import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { pgGet, pgRun, pgAll } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { errorResponse, ok } from "../utils/responses.js";
import { changePasswordSchema } from "../utils/validators.js";
import { validatePassword } from "../utils/passwordPolicy.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { invalidateUserRefreshTokens } from "../services/userService.js";
import { auditLog } from "../services/auditService.js";
import { getRoleConfig } from "../services/roleConfigService.js";
import { CAPABILITY_DEFS, CAPABILITY_MODULES } from "./role-configs.js";

const router = Router();

const mapUser = (row: any) => ({
  id: row.id, name: row.name, email: row.email, role: row.role, status: row.status,
  forcePasswordReset: Boolean(row.force_password_reset), lastLoginAt: row.last_login_at,
  signatureUrl: row.signature_url || null,
});

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const user = await pgGet("SELECT * FROM users WHERE id = ?", [req.user?.id]);
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found.");

  // Resolve capabilities from role_configs
  const roleConfig = await getRoleConfig(user.role).catch(() => null);
  const capabilities: string[] = roleConfig?.capabilities ?? [];

  // Compute allowed pages from capabilities
  const allowedPages: string[] = Array.from(
    new Set(capabilities.flatMap((cap) => CAPABILITY_DEFS[cap]?.pages ?? [])),
  );

  // Compute allowed nav sections: a section is unlocked if any of its capability pages are allowed
  const NAV_SECTION_CAPS: Record<string, string[]> = {
    Dashboard:     ["crm_customers_view","install_tickets_view","inv_view","finance_dashboard","cert_view_pdf"],
    Sales:         ["crm_customers_view","crm_leads_view","crm_quotes_view","finance_invoices_view"],
    Technical:     ["install_tickets_view","install_tickets_assign","install_job_card","install_technical_dashboard"],
    Technician:    ["install_job_card","inv_device_custody"],
    Finance:       ["finance_invoices_view","finance_dashboard","finance_reports","finance_payments"],
    Admin:         ["admin_users","admin_audit","admin_settings","admin_access"],
    Certificates:  ["cert_generate","cert_deliver","cert_view_pdf"],
    Inventory:     ["inv_view","inv_manage","inv_procurement","inv_warranty","inv_device_custody"],
    Executive:     ["crm_customers_view","finance_dashboard","install_technical_dashboard"],
    Partners:      ["crm_partners"],
    Communication: ["crm_campaigns"],
    AllStaff:      ["hr_self_service"],
  };
  const allowedNavSections = Object.entries(NAV_SECTION_CAPS)
    .filter(([, caps]) => caps.some((c) => capabilities.includes(c)))
    .map(([section]) => section);

  return ok(res, {
    user: {
      ...mapUser(user),
      hrEmployeeId:       req.user?.hrEmployeeId     ?? null,
      employeeNo:         req.user?.employeeNo       ?? null,
      rosterId:           req.user?.rosterId         ?? null,
      rosterMemberType:   req.user?.rosterMemberType ?? null,
      effectiveRole:      req.user?.effectiveRole    ?? null,
      capabilities,
      allowedPages,
      allowedNavSections,
    },
    loginMethod: req.user?.loginMethod ?? null,
    idleTimeoutMinutes: req.user?.idleTimeoutMinutes ?? null,
  });
});

// ── PATCH /me — update display name ─────────────────────────────────────────
router.patch("/", requireAuth, async (req: AuthRequest, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Name is required.");
  }
  const now = new Date().toISOString();
  await pgRun("UPDATE users SET name = ?, updated_at = ? WHERE id = ?", [name.trim(), now, req.user!.id]);
  auditLog(req, "SELF_PROFILE_UPDATED", `user:${req.user!.id}`, "Info", { name: name.trim() }).catch(console.error);
  return ok(res, { message: "Profile updated." });
});

// ── GET /me/employee — fetch linked HR employee record ───────────────────────
router.get("/employee", requireAuth, async (req: AuthRequest, res) => {
  const emp = await pgGet(
    "SELECT * FROM hr_employees WHERE user_account_id = ?",
    [req.user!.id]
  );
  if (!emp) return ok(res, { employee: null });

  const contacts = await pgAll(
    "SELECT id, name, relationship, phone FROM hr_emergency_contacts WHERE employee_id = ? ORDER BY created_at",
    [emp.id]
  );

  return ok(res, {
    employee: {
      id: emp.id,
      employeeNo: emp.employee_no,
      personalFileNo: emp.personal_file_no,
      fullName: emp.full_name,
      phone: emp.phone,
      residentialAddress: emp.residential_address,
      dateOfBirth: emp.date_of_birth,
      nationalId: emp.national_id,
      kraPin: emp.kra_pin,
      workEmail: emp.work_email,
      startDate: emp.start_date,
      employmentType: emp.employment_type,
      status: emp.status,
      emergencyContacts: contacts,
    },
  });
});

// ── PATCH /me/employee — update personal/contact fields only ─────────────────
router.patch("/employee", requireAuth, async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT id FROM hr_employees WHERE user_account_id = ?", [req.user!.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "No employee record linked to this account.");

  const { phone, residentialAddress, emergencyContacts } = req.body;
  const now = new Date().toISOString();

  const updates: string[] = [];
  const vals: any[] = [];
  if (phone !== undefined)             { updates.push("phone = ?");                vals.push(phone?.trim() || null); }
  if (residentialAddress !== undefined) { updates.push("residential_address = ?");  vals.push(residentialAddress?.trim() || null); }
  if (updates.length) {
    updates.push("updated_at = ?"); vals.push(now);
    vals.push(emp.id);
    await pgRun(`UPDATE hr_employees SET ${updates.join(", ")} WHERE id = ?`, vals);
  }

  if (Array.isArray(emergencyContacts)) {
    await pgRun("DELETE FROM hr_emergency_contacts WHERE employee_id = ?", [emp.id]);
    for (const ec of emergencyContacts) {
      if (ec.name?.trim() && ec.phone?.trim()) {
        await pgRun(
          "INSERT INTO hr_emergency_contacts (id, employee_id, name, relationship, phone, consent_given, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
          [uuidv4(), emp.id, ec.name.trim(), ec.relationship?.trim() || "", ec.phone.trim(), now, now]
        );
      }
    }
  }

  auditLog(req, "SELF_EMPLOYEE_PROFILE_UPDATED", `hr_employee:${emp.id}`, "Info", {}).catch(console.error);
  return ok(res, { message: "Profile updated." });
});

// ── Signature upload (used as "Printed By" signature on generated certificates) ──
// Stored under /public (not /uploads) since it's embedded client-side into the
// certificate PDF and shown in signature previews without needing auth headers.
router.patch("/signature", requireAuth, async (req: AuthRequest, res) => {
  const { signatureBase64 } = req.body as { signatureBase64?: string };
  if (!signatureBase64) return errorResponse(res, 400, "VALIDATION_ERROR", "signatureBase64 is required.");
  const match = /^data:image\/png;base64,(.+)$/.exec(signatureBase64);
  if (!match) return errorResponse(res, 400, "VALIDATION_ERROR", "signatureBase64 must be a PNG data URL.");
  const buffer = Buffer.from(match[1], "base64");
  if (buffer.length > 2 * 1024 * 1024) return errorResponse(res, 400, "VALIDATION_ERROR", "Signature image must be under 2MB.");
  const dir = path.join(process.cwd(), "public", "signatures");
  fs.mkdirSync(dir, { recursive: true });
  const filename = `user-${req.user!.id}-${Date.now()}.png`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  const url = `/public/signatures/${filename}`;
  const now = new Date().toISOString();
  await pgRun("UPDATE users SET signature_url = ?, updated_at = ? WHERE id = ?", [url, now, req.user!.id]);
  auditLog(req, "SELF_SIGNATURE_UPDATED", `user:${req.user!.id}`, "Info", {}).catch(console.error);
  return ok(res, { signatureUrl: url }, "Signature updated.");
});

router.delete("/signature", requireAuth, async (req: AuthRequest, res) => {
  const now = new Date().toISOString();
  await pgRun("UPDATE users SET signature_url = NULL, updated_at = ? WHERE id = ?", [now, req.user!.id]);
  auditLog(req, "SELF_SIGNATURE_REMOVED", `user:${req.user!.id}`, "Info", {}).catch(console.error);
  return ok(res, {}, "Signature removed.");
});

router.post("/change-password", requireAuth, async (req: AuthRequest, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { currentPassword, newPassword, confirmPassword } = parsed.data;
  if (newPassword !== confirmPassword) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", { fieldErrors: { confirmPassword: ["Passwords do not match."] } });
  }
  if (newPassword === currentPassword) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", { fieldErrors: { newPassword: ["New password must be different from current password."] } });
  }
  const policy = validatePassword(newPassword);
  if (!policy.ok) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", { fieldErrors: { newPassword: policy.errors } });
  const user = await pgGet("SELECT * FROM users WHERE id = ?", [req.user?.id]);
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found.");
  const passwordOk = await verifyPassword(currentPassword, user.password_hash);
  if (!passwordOk) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", { fieldErrors: { currentPassword: ["Current password is incorrect."] } });
  }
  const passwordHash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  await pgRun("UPDATE users SET password_hash = ?, force_password_reset = 0, updated_at = ? WHERE id = ?", [passwordHash, now, user.id]);
  await invalidateUserRefreshTokens(user.id);
  auditLog(req, "SELF_PASSWORD_CHANGED", `user:${user.id}`, "Info", { method: "current_password" }).catch(console.error);
  return res.status(200).json({ message: "Password changed successfully" });
});

export default router;
