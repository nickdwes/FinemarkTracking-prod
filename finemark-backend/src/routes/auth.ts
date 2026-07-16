import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgRun } from "../db.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { signAccessToken, generateRefreshToken, hashRefreshToken } from "../utils/tokens.js";
import { authLimiter, loginLimiter } from "../middleware/rateLimit.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { errorResponse, ok } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchemaAuth } from "../utils/validators.js";
import { isGraphConfigured, sendEmailViaGraph } from "../services/graphMailService.js";
import { resolveIdentity } from "../services/identityService.js";
import { getIdleMinutes, isSessionIdleExpired, touchSessionActivity } from "../services/sessionTimeoutService.js";

const router = Router();
const refreshDays = Number(process.env.REFRESH_EXPIRES_DAYS || 7);

// ── Session cookie helpers ─────────────────────────────────────────────────
// fm_rt is an HttpOnly, Secure, SameSite=Lax cookie that mirrors the refresh
// token. nginx auth_request reads it to gate access to all protected HTML pages
// without exposing the token to JavaScript.
const _cookieOpts = {
  httpOnly: true,
  secure: true,          // always HTTPS in production (nginx terminates TLS)
  sameSite: 'lax' as const,
  path: '/',
};

export const setAuthCookie = (res: any, token: string) => {
  res.cookie('fm_rt', token, { ..._cookieOpts, maxAge: refreshDays * 86400 * 1000 });
};

const clearAuthCookie = (res: any) => {
  res.clearCookie('fm_rt', _cookieOpts);
};

// Parse a single named cookie from the raw Cookie request header
const parseRequestCookie = (req: any, name: string): string | null => {
  const header = (req.headers.cookie as string | undefined) || '';
  const pair = header.split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith(name + '='));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
};

router.post("/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { email, password } = parsed.data;

  const user = await pgGet("SELECT * FROM users WHERE email = ?", [email]);
  if (!user) {
    auditLog(req, "LOGIN_FAILED", `user:${email}`, "Warning", { email, reason: "no_such_account" }, { email }).catch(console.error);
    return errorResponse(res, 401, "UNAUTHORIZED", "Invalid email or password.");
  }
  if (user.status === "Disabled") {
    auditLog(req, "LOGIN_FAILED", `user:${user.id}`, "Warning", { email, reason: "account_disabled" }, { id: user.id, email, role: user.role }).catch(console.error);
    return errorResponse(res, 403, "FORBIDDEN", "User account is disabled.");
  }
  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    auditLog(req, "LOGIN_FAILED", `user:${user.id}`, "Warning", { email, reason: "bad_password" }, { id: user.id, email, role: user.role }).catch(console.error);
    return errorResponse(res, 401, "UNAUTHORIZED", "Invalid email or password.");
  }

  const sessionId = uuidv4();
  const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email, sid: sessionId });
  const refreshToken = generateRefreshToken();
  const refreshHash = hashRefreshToken(refreshToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + refreshDays * 86400000).toISOString();

  await pgRun(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, login_method, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, user.id, refreshHash, expiresAt, now.toISOString(), "password", now.toISOString()]
  );
  await pgRun("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?", [
    now.toISOString(), now.toISOString(), user.id,
  ]);

  auditLog(req, "LOGIN_SUCCESS", `user:${user.id}`, "Info", { email }, { id: user.id, email, role: user.role }).catch(console.error);

  // Resolve full identity so the session has all cross-space IDs from the start
  const identity = await resolveIdentity(user.id).catch(() => null);

  // Set HttpOnly session cookie used by nginx auth_request to gate HTML pages
  setAuthCookie(res, refreshToken);

  return res.status(200).json({
    accessToken, refreshToken,
    loginMethod: "password",
    idleTimeoutMinutes: await getIdleMinutes("password"),
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      status: user.status, forcePasswordReset: Boolean(user.force_password_reset),
      lastLoginAt: now.toISOString(),
      // Cross-space identity facets — stable until next login or token refresh
      hrEmployeeId:     identity?.hrEmployeeId     ?? null,
      employeeNo:       identity?.employeeNo       ?? null,
      rosterId:         identity?.rosterId         ?? null,
      rosterMemberType: identity?.rosterMemberType ?? null,
    },
  });
});

router.post("/refresh", authLimiter, async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { refreshToken } = parsed.data;
  const refreshHash = hashRefreshToken(refreshToken);
  const tokenRow = await pgGet("SELECT * FROM refresh_tokens WHERE token_hash = ?", [refreshHash]);
  if (!tokenRow) return errorResponse(res, 401, "UNAUTHORIZED", "Invalid refresh token.");
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
    await pgRun("DELETE FROM refresh_tokens WHERE id = ?", [tokenRow.id]);
    return errorResponse(res, 401, "UNAUTHORIZED", "Refresh token expired.");
  }
  if (await isSessionIdleExpired(tokenRow)) {
    return errorResponse(res, 401, "IDLE_TIMEOUT", "Session expired due to inactivity. Please sign in again.");
  }
  const user = await pgGet("SELECT * FROM users WHERE id = ?", [tokenRow.user_id]);
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found.");
  const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email, sid: tokenRow.id });
  (req as any).user = { id: user.id, email: user.email, role: user.role };
  auditLog(req, "TOKEN_REFRESH", `user:${user.id}`, "Info", { email: user.email }).catch(console.error);
  // Re-extend the session cookie so page access stays valid alongside the new access token
  setAuthCookie(res, refreshToken);
  return res.status(200).json({
    accessToken, refreshToken,
    loginMethod: tokenRow.login_method,
    idleTimeoutMinutes: await getIdleMinutes(tokenRow.login_method),
  });
});

router.post("/logout", async (req, res) => {
  // Always clear the session cookie regardless of body validity
  clearAuthCookie(res);
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) return res.status(200).json({ message: "Logged out" });
  const { refreshToken } = parsed.data;
  const refreshHash = hashRefreshToken(refreshToken);
  const tokenRow = await pgGet("SELECT * FROM refresh_tokens WHERE token_hash = ?", [refreshHash]);
  if (tokenRow) {
    const user = await pgGet("SELECT * FROM users WHERE id = ?", [tokenRow.user_id]);
    if (user) {
      (req as any).user = { id: user.id, email: user.email, role: user.role };
      auditLog(req, "LOGOUT", `user:${user.id}`, "Info", { email: user.email }).catch(console.error);
    }
  }
  await pgRun("DELETE FROM refresh_tokens WHERE token_hash = ?", [refreshHash]);
  return res.status(200).json({ message: "Logged out" });
});

// GET /verify-page — called by nginx auth_request for every protected HTML page.
// Validates the fm_rt HttpOnly cookie against the refresh_tokens table.
// Returns 200 (allow) or 401 (deny → nginx redirects to login).
router.get("/verify-page", async (req, res) => {
  const rawToken = parseRequestCookie(req, 'fm_rt');
  if (!rawToken) {
    return res.status(401).end();
  }
  try {
    const tokenHash = hashRefreshToken(rawToken);
    const tokenRow = await pgGet(
      'SELECT id, expires_at, login_method, last_activity_at FROM refresh_tokens WHERE token_hash = ?',
      [tokenHash]
    );
    if (!tokenRow || new Date(tokenRow.expires_at).getTime() < Date.now()) {
      clearAuthCookie(res);
      return res.status(401).end();
    }
    if (await isSessionIdleExpired(tokenRow)) {
      clearAuthCookie(res);
      return res.status(401).end();
    }
    // A page navigation is itself real user activity — count it, so a user
    // clicking from page to page doesn't get idled out between clicks just
    // because no single page sat open long enough to fire a JS heartbeat.
    touchSessionActivity(tokenRow.id).catch(() => {});
    return res.status(200).end();
  } catch {
    return res.status(401).end();
  }
});

// POST /heartbeat — called by the frontend on genuine user activity (throttled
// client-side) to keep an idle session alive on pages the user stays on for a
// while (page navigations already count via /verify-page above). Deliberately
// NOT wired into every authenticated request, since background polling (e.g.
// the /me session watcher) must not count as activity for idle-timeout purposes.
router.post("/heartbeat", requireAuth, async (req: AuthRequest, res) => {
  if (req.user?.sid) {
    await touchSessionActivity(req.user.sid);
  }
  return res.status(200).json({ ok: true });
});

router.get("/me", requireAuth, async (req: AuthRequest, res) => {
  const user = await pgGet("SELECT * FROM users WHERE id = ?", [req.user?.id]);
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found.");
  return ok(res, {
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      status: user.status, forcePasswordReset: Boolean(user.force_password_reset),
      lastLoginAt: user.last_login_at,
    },
  });
});

router.post("/forgot-password", authLimiter, async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const inputEmail = parsed.data.email.trim().toLowerCase();

  const okMsg = "If an account exists, you will receive a reset link shortly.";

  // Resolve user: first by account email, then by employee personal email.
  // This allows staff without a Finemark corporate email (no Azure AD access)
  // to reset their password using the personal email stored on their HR record.
  let user: any = await pgGet(
    "SELECT id, name, email FROM users WHERE LOWER(email) = ? AND status != 'Disabled'",
    [inputEmail]
  );
  // targetEmail is where the reset link will be sent — whichever email the user entered
  let targetEmail = inputEmail;

  if (!user) {
    const emp = await pgGet(
      "SELECT u.id, u.name, u.email FROM hr_employees e " +
      "JOIN users u ON u.id = e.user_account_id " +
      "WHERE LOWER(e.email) = ? AND u.status != 'Disabled'",
      [inputEmail]
    );
    if (emp) user = emp;
    // targetEmail stays as inputEmail (their personal email) so the link arrives there
  }

  if (!user) return res.status(200).json({ message: okMsg });

  // Generate a secure token
  const rawToken = uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "");
  const tokenHash = hashRefreshToken(rawToken);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  // Invalidate prior unused tokens for this user
  await pgRun("UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL", [now, user.id]);

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
      to: targetEmail,
      subject: "Reset your Finemark password",
      htmlBody: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#0f766e;padding:24px 32px;border-radius:12px 12px 0 0">
            <h1 style="color:#fff;font-size:20px;margin:0">Password Reset Request</h1>
          </div>
          <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:32px;border-radius:0 0 12px 12px">
            <p style="color:#334155;font-size:15px">Hi ${user.name},</p>
            <p style="color:#334155;font-size:15px">We received a request to reset the password for your Finemark account.</p>
            <p style="color:#334155;font-size:15px">Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.</p>
            <div style="text-align:center;margin:32px 0">
              <a href="${resetLink}" style="background:#0f766e;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Reset Password</a>
            </div>
            <p style="color:#64748b;font-size:13px">Or copy and paste this link into your browser:</p>
            <p style="color:#0f766e;font-size:13px;word-break:break-all">${resetLink}</p>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <p style="color:#94a3b8;font-size:12px">If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
          </div>
        </div>`,
    }).catch(e => console.error("[auth] Failed to send reset email:", e.message));
  } else {
    console.log(`[auth] Password reset token for ${targetEmail} (user:${user.id}): ${rawToken}`);
  }

  auditLog(req, "PASSWORD_RESET_REQUESTED", `user:${user.id}`, "Info", { email: targetEmail }, { id: user.id, email: user.email, role: user.role }).catch(console.error);
  return res.status(200).json({ message: okMsg });
});

router.post("/reset-password", authLimiter, async (req, res) => {
  const parsed = resetPasswordSchemaAuth.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { token, newPassword } = parsed.data;

  if (!token) return errorResponse(res, 400, "VALIDATION_ERROR", "Reset token is required.");

  const tokenHash = hashRefreshToken(token);
  const tokenRow = await pgGet("SELECT * FROM password_reset_tokens WHERE token_hash = ?", [tokenHash]);

  if (!tokenRow || tokenRow.used_at) {
    return errorResponse(res, 400, "INVALID_TOKEN", "This reset link is invalid or has already been used.");
  }
  if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
    return errorResponse(res, 400, "TOKEN_EXPIRED", "This reset link has expired. Please request a new one.");
  }

  const user = await pgGet("SELECT * FROM users WHERE id = ?", [tokenRow.user_id]);
  if (!user) return errorResponse(res, 404, "NOT_FOUND", "User not found.");

  const hashed = await hashPassword(newPassword);
  const now = new Date().toISOString();
  await pgRun("UPDATE users SET password_hash = ?, force_password_reset = 0, updated_at = ? WHERE id = ?", [hashed, now, user.id]);
  await pgRun("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?", [now, tokenRow.id]);

  auditLog(req, "PASSWORD_RESET_COMPLETED", `user:${user.id}`, "Info", { email: user.email }, { id: user.id, email: user.email, role: user.role }).catch(console.error);
  return res.status(200).json({ message: "Password updated successfully." });
});

// ── Email OTP Login ─────────────────────────────────────────────────────────

router.post("/otp/request", authLimiter, async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  if (!email) return errorResponse(res, 400, "VALIDATION_ERROR", "Email is required.");

  // Resolve user: first by account email, then by employee personal email
  let user: any = await pgGet(
    "SELECT id, name, email FROM users WHERE LOWER(email) = ? AND status != 'Disabled'",
    [email]
  );
  let targetEmail = email;

  if (!user) {
    const emp = await pgGet(
      "SELECT u.id, u.name, u.email FROM hr_employees e " +
      "JOIN users u ON u.id = e.user_account_id " +
      "WHERE LOWER(e.email) = ? AND u.status != 'Disabled'",
      [email]
    );
    if (emp) {
      user = emp;
      targetEmail = email; // send to the personal email they entered
    }
  }

  const okMsg = "If that email is associated with an account, a one-time code has been sent.";
  if (!user) return res.status(200).json({ message: okMsg });

  const now = new Date();
  // Invalidate any prior unused tokens for this user
  await pgRun("UPDATE login_otp_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL", [
    now.toISOString(), user.id,
  ]);

  // Generate 6-digit OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = hashRefreshToken(otp);
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // 10 min

  await pgRun(
    "INSERT INTO login_otp_tokens (id, user_id, otp_hash, target_email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [uuidv4(), user.id, otpHash, targetEmail, expiresAt, now.toISOString()]
  );

  const otpMailbox = process.env.GRAPH_OTP_MAILBOX;
  if (isGraphConfigured() && otpMailbox) {
    await sendEmailViaGraph({
      fromMailbox: otpMailbox,
      to: targetEmail,
      subject: "Your Finemark sign-in code",
      htmlBody: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#0f766e;padding:24px 32px;border-radius:12px 12px 0 0">
            <h1 style="color:#fff;font-size:20px;margin:0">Finemark Sign-In Code</h1>
          </div>
          <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;padding:32px;border-radius:0 0 12px 12px">
            <p style="color:#334155;font-size:15px">Hi ${user.name},</p>
            <p style="color:#334155;font-size:15px">Use the code below to sign in to Finemark. This code expires in <strong>10 minutes</strong>.</p>
            <div style="text-align:center;margin:32px 0">
              <span style="display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 40px;font-size:36px;font-weight:700;letter-spacing:10px;color:#0f172a;font-family:monospace">${otp}</span>
            </div>
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
            <p style="color:#94a3b8;font-size:12px">If you didn't request this code, you can safely ignore this email.</p>
          </div>
        </div>`,
    }).catch(e => console.error("[auth] Failed to send OTP email:", e.message));
  } else {
    console.log(`[auth] Login OTP for ${targetEmail}: ${otp}`);
  }

  auditLog(req, "OTP_LOGIN_REQUESTED", `user:${user.id}`, "Info", { email: targetEmail }, { id: user.id, email: user.email, role: user.role }).catch(console.error);
  return res.status(200).json({ message: okMsg });
});

router.post("/otp/verify", authLimiter, async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const otp = (req.body?.otp || "").trim();
  if (!email || !otp) return errorResponse(res, 400, "VALIDATION_ERROR", "Email and OTP code are required.");

  const invalidMsg = "Invalid or expired code. Please request a new one.";

  // Resolve user by account email, then by employee personal email
  let user: any = await pgGet("SELECT * FROM users WHERE LOWER(email) = ? AND status != 'Disabled'", [email]);
  if (!user) {
    const emp = await pgGet(
      "SELECT u.* FROM hr_employees e JOIN users u ON u.id = e.user_account_id " +
      "WHERE LOWER(e.email) = ? AND u.status != 'Disabled'",
      [email]
    );
    user = emp || null;
  }
  if (!user) {
    auditLog(req, "OTP_LOGIN_FAILED", `user:${email}`, "Warning", { email, reason: "no_such_account" }, { email }).catch(console.error);
    return errorResponse(res, 401, "INVALID_OTP", invalidMsg);
  }

  const otpHash = hashRefreshToken(otp);
  const now = new Date();
  const record = await pgGet(
    "SELECT * FROM login_otp_tokens WHERE user_id = ? AND otp_hash = ? AND used_at IS NULL AND expires_at > ?",
    [user.id, otpHash, now.toISOString()]
  );
  if (!record) {
    auditLog(req, "OTP_LOGIN_FAILED", `user:${user.id}`, "Warning", { email, reason: "invalid_or_expired_otp" }, { id: user.id, email: user.email, role: user.role }).catch(console.error);
    return errorResponse(res, 401, "INVALID_OTP", invalidMsg);
  }

  await pgRun("UPDATE login_otp_tokens SET used_at = ? WHERE id = ?", [now.toISOString(), record.id]);
  await pgRun("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?", [
    now.toISOString(), now.toISOString(), user.id,
  ]);

  const sessionId = uuidv4();
  const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email, sid: sessionId });
  const refreshToken = generateRefreshToken();
  const refreshHash = hashRefreshToken(refreshToken);
  const expiresAt = new Date(now.getTime() + refreshDays * 86400000).toISOString();
  await pgRun(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, login_method, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, user.id, refreshHash, expiresAt, now.toISOString(), "otp", now.toISOString()]
  );

  // OTP sign-in also happens over HTTPS from the browser, so gate HTML pages the same way password login does
  setAuthCookie(res, refreshToken);

  auditLog(req, "OTP_LOGIN_SUCCESS", `user:${user.id}`, "Info", { email: user.email }, { id: user.id, email: user.email, role: user.role }).catch(console.error);
  const identity = await resolveIdentity(user.id).catch(() => null);

  return res.status(200).json({
    accessToken, refreshToken,
    loginMethod: "otp",
    idleTimeoutMinutes: await getIdleMinutes("otp"),
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      status: user.status, forcePasswordReset: Boolean(user.force_password_reset),
      lastLoginAt: now.toISOString(),
      hrEmployeeId:     identity?.hrEmployeeId     ?? null,
      employeeNo:       identity?.employeeNo       ?? null,
      rosterId:         identity?.rosterId         ?? null,
      rosterMemberType: identity?.rosterMemberType ?? null,
    },
  });
});

export default router;
