import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, LEGACY_ROLE_MAP, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { createUserSchema, updateUserSchema, resetPasswordSchema, listUsersQuerySchema } from "../utils/validators.js";
import { listUsers, createUser, updateUser, adminResetPassword, invalidateUserRefreshTokens, getUserById } from "../services/userService.js";
import { pgGet, pgRun } from "../db.js";
import { validatePassword } from "../utils/passwordPolicy.js";
import { cacheDeleteByPrefix, cacheGetOrSet } from "../utils/cache.js";
import { invalidateIdentityCache } from "../services/identityCacheService.js";
import { v4 as uuidv4 } from "uuid";
import { hashRefreshToken } from "../utils/tokens.js";
import { isGraphConfigured, sendEmailViaGraph } from "../services/graphMailService.js";

const router = Router();
const USERS_LIST_TTL_MS = 30_000;

function invalidateUsersCache() {
  cacheDeleteByPrefix("users:list:");
}

// Role membership: any system/custom role_key defined in role_configs (the
// authoritative list managed via admin-access-control.html), plus legacy role
// strings still recognized by LEGACY_ROLE_MAP. Replaces the old static zod enum
// so custom roles created in role_configs can actually be assigned to a user.
async function isAssignableRole(role: string): Promise<boolean> {
  if (Object.prototype.hasOwnProperty.call(LEGACY_ROLE_MAP, role)) return true;
  const row = await pgGet("SELECT 1 FROM role_configs WHERE role_key = ?", [role]);
  return !!row;
}

const mapUser = (row: any) => ({
  id: row.id, name: row.name, email: row.email, role: row.role, status: row.status,
  lastLoginAt: row.last_login_at, createdAt: row.created_at, updatedAt: row.updated_at,
  forcePasswordReset: Boolean(row.force_password_reset),
});

router.get("/", requireAuth, async (req, res) => {
  const parsed = listUsersQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const requesterRole = (req as any).user?.role;
  const isAdmin = requesterRole === "Admin";
  if (!isAdmin) {
    const requestedRole = parsed.data.role || "";
    const BD_ROLES = new Set(["Sales", "Telesales", "FieldSales", "BDM", "BDMCorporate", "TeamLead", "CorporateSales"]);
    const requestedRoles = requestedRole.split(",").map((r: string) => r.trim()).filter(Boolean);
    const canLookupTechs = ["Technical"].includes(requesterRole);
    const isBDM = ["BDM", "BDMCorporate"].includes(requesterRole);
    // Non-manager BD reps may only look up their own role's peers (e.g. a
    // CorporateSales rep listing fellow CorporateSales reps for a team
    // performance view) — this used to hardcode `r === "Sales"` specifically,
    // which meant a Telesales/FieldSales/CorporateSales rep could look up
    // Sales reps but never their own actual peers.
    const allAllowed = requestedRoles.every((r: string) =>
      BD_ROLES.has(r) && (isBDM || r === requesterRole) ||
      (canLookupTechs && r === "Technician")
    );
    if (!requestedRole || !allAllowed) {
      return errorResponse(res, 403, "FORBIDDEN", "Insufficient permissions to list users.");
    }
  }
  const page = Math.max(parseInt(parsed.data.page || "1", 10) || 1, 1);
  const pageSize = Math.min(parseInt(parsed.data.pageSize || "50", 10) || 50, 200);
  const cacheKey = `users:list:${requesterRole}:${JSON.stringify({ search: parsed.data.search || "", role: parsed.data.role || "", status: parsed.data.status || "", page, pageSize })}`;
  const { rows, total } = await cacheGetOrSet(cacheKey, USERS_LIST_TTL_MS, async () =>
    listUsers({ search: parsed.data.search, role: parsed.data.role, status: parsed.data.status, page, pageSize })
  );
  if (!isAdmin) {
    const limited = rows.map((row: any) => ({ id: row.id, name: row.name, email: row.email, role: row.role }));
    return res.status(200).json({ data: limited, meta: { total } });
  }
  return res.status(200).json({ data: rows.map(mapUser), meta: { total } });
});

router.post("/", requireAuth, requireRole(["Admin", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());
  if (!(await isAssignableRole(parsed.data.role))) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", { fieldErrors: { role: [`Unknown role "${parsed.data.role}".`] } });
  }
  // BDM/BDMCorporate can only create Sales-team accounts (not Admin/Finance/HR etc.)
  // Includes both canonical names and legacy aliases that map to the same roles
  const BDM_ALLOWED_ROLES = ["Sales", "Telesales", "FieldSales", "TeamLead", "CorporateSales"];
  if (["BDM", "BDMCorporate"].includes(req.user!.role) && !BDM_ALLOWED_ROLES.includes(parsed.data.role)) {
    return errorResponse(res, 403, "FORBIDDEN", "BDM can only create Sales team accounts.");
  }
  const exists = await pgGet("SELECT id FROM users WHERE email = ?", [parsed.data.email]);
  if (exists) return errorResponse(res, 409, "CONFLICT", "Email already exists.");
  // Auto-generate a secure temp password when sendInvite flow is used
  const autoGenPassword = `Fm${uuidv4().replace(/-/g, "").slice(0, 10)}1A`;
  const tempPassword = parsed.data.tempPassword || autoGenPassword;
  const user = await createUser({ ...parsed.data, tempPassword, forcePasswordReset: true });
  invalidateUsersCache();
  auditLog(req, "USER_CREATED", `user:${user.id}`, "Info", { email: user.email, role: user.role }).catch(console.error);
  // Send password reset / invite email if requested
  if (parsed.data.sendInvite) {
    try {
      const rawToken = uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "");
      const tokenHash = hashRefreshToken(rawToken);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(); // 72 hours for invite
      await pgRun(
        "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
        [uuidv4(), user.id, tokenHash, expiresAt, now]
      );
      const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5500").replace(/\/$/, "");
      const resetLink = `${frontendUrl}/reset-password.html?token=${rawToken}`;
      const otpMailbox = process.env.GRAPH_OTP_MAILBOX;
      if (isGraphConfigured() && otpMailbox) {
        await sendEmailViaGraph({
          fromMailbox: otpMailbox,
          to: user.email,
          subject: "Welcome to Finemark — Set your password",
          htmlBody: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
              <div style="background:#0f766e;padding:24px 32px;border-radius:12px 12px 0 0">
                <h1 style="color:#fff;font-size:20px;margin:0">Welcome to Finemark</h1>
              </div>
              <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:32px;border-radius:0 0 12px 12px">
                <p style="color:#334155;font-size:15px">Hi ${user.name},</p>
                <p style="color:#334155;font-size:15px">Your Finemark account has been created. Click the button below to set your password and get started. This link expires in <strong>72 hours</strong>.</p>
                <div style="text-align:center;margin:32px 0">
                  <a href="${resetLink}" style="background:#0f766e;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Set Password &amp; Login</a>
                </div>
                <p style="color:#64748b;font-size:13px">Or copy and paste this link:</p>
                <p style="color:#0f766e;font-size:13px;word-break:break-all">${resetLink}</p>
              </div>
            </div>`,
        }).catch(e => console.error("[users] Failed to send invite email:", e.message));
      } else {
        console.log(`[users] Invite link for ${user.email}: ${resetLink}`);
      }
    } catch (e: any) {
      console.error("[users] Invite token error:", e.message);
    }
  }
  return res.status(201).json({ data: mapUser(user), message: "User created" });
});

router.patch("/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());
  if (parsed.data.role !== undefined && !(await isAssignableRole(parsed.data.role))) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", { fieldErrors: { role: [`Unknown role "${parsed.data.role}".`] } });
  }
  const user = await getUserById(req.params.id);
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found.");
  const previousStatus = user.status;
  // Invalidate tokens when role changes so the user must re-authenticate with new permissions
  if (parsed.data.role && parsed.data.role !== user.role) await invalidateUserRefreshTokens(req.params.id);
  if (parsed.data.status === "Disabled") await invalidateUserRefreshTokens(req.params.id);
  const updated = await updateUser(req.params.id, {
    name: parsed.data.name, role: parsed.data.role, status: parsed.data.status,
    force_password_reset: parsed.data.forcePasswordReset,
  });
  invalidateUsersCache();
  invalidateIdentityCache(req.params.id);
  auditLog(req, "USER_UPDATED", `user:${req.params.id}`, "Info", parsed.data).catch(console.error);
  if (parsed.data.status && parsed.data.status !== previousStatus) {
    const action = parsed.data.status === "Disabled" ? "USER_DISABLED" : "USER_ENABLED";
    auditLog(req, action, `user:${req.params.id}`, "Warning", { fromStatus: previousStatus, toStatus: parsed.data.status, email: updated.email }).catch(console.error);
  }
  return res.status(200).json({ data: mapUser(updated), message: "User updated" });
});

router.post("/:id/reset-password", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());
  const policy = validatePassword(parsed.data.tempPassword);
  if (!policy.ok) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", { fieldErrors: { tempPassword: policy.errors } });
  const user = await getUserById(req.params.id);
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found.");
  const updated = await adminResetPassword(req.params.id, parsed.data.tempPassword, parsed.data.forcePasswordReset);
  auditLog(req, "ADMIN_PASSWORD_RESET", `user:${req.params.id}`, "Warning", { email: updated.email }).catch(console.error);
  return res.status(200).json({ data: mapUser(updated), message: "Password reset issued" });
});

export default router;
