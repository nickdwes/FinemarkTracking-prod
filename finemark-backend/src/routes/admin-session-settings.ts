/**
 * Admin Session Timeout Settings — /api/admin/session-settings
 *
 * GET  /   — current idle-timeout minutes per sign-in method
 * POST /   — update idle-timeout minutes (Admin only)
 */

import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { pgGet, pgRun } from "../db.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { invalidateSessionTimeoutSettingsCache } from "../services/sessionTimeoutService.js";

const router = Router();

const MIN_MINUTES = 1;
const MAX_MINUTES = 1440; // 24 hours

const isValidMinutes = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= MIN_MINUTES && value <= MAX_MINUTES;

router.get("/", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (_req, res) => {
  const row = await pgGet("SELECT * FROM session_timeout_settings WHERE id = 1");
  return res.json({
    ok: true,
    settings: row ?? {
      password_idle_minutes: 30,
      otp_idle_minutes: 30,
      azure_idle_minutes: 30,
      updated_at: null,
      updated_by: null,
    },
  });
});

router.post("/", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const { passwordIdleMinutes, otpIdleMinutes, azureIdleMinutes } = req.body as {
    passwordIdleMinutes: unknown;
    otpIdleMinutes: unknown;
    azureIdleMinutes: unknown;
  };

  if (!isValidMinutes(passwordIdleMinutes) || !isValidMinutes(otpIdleMinutes) || !isValidMinutes(azureIdleMinutes)) {
    return errorResponse(
      res, 400, "VALIDATION_ERROR",
      `Each idle timeout must be a whole number of minutes between ${MIN_MINUTES} and ${MAX_MINUTES}.`,
    );
  }

  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO session_timeout_settings (id, password_idle_minutes, otp_idle_minutes, azure_idle_minutes, updated_at, updated_by)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       password_idle_minutes = EXCLUDED.password_idle_minutes,
       otp_idle_minutes      = EXCLUDED.otp_idle_minutes,
       azure_idle_minutes    = EXCLUDED.azure_idle_minutes,
       updated_at            = EXCLUDED.updated_at,
       updated_by            = EXCLUDED.updated_by`,
    [passwordIdleMinutes, otpIdleMinutes, azureIdleMinutes, now, req.user?.email ?? "admin"],
  );
  invalidateSessionTimeoutSettingsCache();

  auditLog(req, "SESSION_TIMEOUT_SETTINGS_UPDATED", "session_timeout_settings:1", "Info", {
    passwordIdleMinutes, otpIdleMinutes, azureIdleMinutes,
  }).catch(console.error);

  const row = await pgGet("SELECT * FROM session_timeout_settings WHERE id = 1");
  return res.json({ ok: true, settings: row });
});

export default router;
