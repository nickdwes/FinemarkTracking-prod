import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/tokens.js";
import { errorResponse } from "../utils/responses.js";
import { pgGet } from "../db.js";
import { getRoleConfig } from "../services/roleConfigService.js";
import { getIdleMinutes, isSessionIdleExpired } from "../services/sessionTimeoutService.js";
import { getIdentity } from "../services/identityCacheService.js";

// Canonical system roles — custom roles are anything NOT in this set.
// Must match role-configs.ts's SYSTEM_ROLE_META exactly (14 roles). Note: the ISO
// (Installation Support Officer) role is "Technical", not a separate "ISO" string —
// no role_configs row exists for "ISO", so including it here would silently lock
// out any account ever given that literal role (empty capabilities/allowedPages).
const SYSTEM_ROLES = new Set([
  "Admin","Executive","BDM","BDMCorporate","CorporateSales","KAM","Telesales",
  "InventoryManager","Technician","Technical","InstallOffice",
  "CertAdmin","Finance","HR",
]);

/**
 * Identity facets attached to every authenticated request.
 *
 * id              — users.id (canonical ERP GUID) — always present
 * role            — ERP role string
 * email           — ERP login email
 * hrEmployeeId    — hr_employees.id (null if person has no HR record)
 * employeeNo      — HR employee number (null if no HR record)
 * rosterId        — technical_team_roster.id (null if not on roster)
 * rosterMemberType — "Technician" | "ISO" | null
 */
export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
    email: string;
    hrEmployeeId: string | null;
    employeeNo: string | null;
    rosterId: string | null;
    rosterMemberType: string | null;
    /** For custom roles: the system role this custom role inherits API permissions from */
    effectiveRole: string | null;
    /** refresh_tokens.id for the session behind this access token, if present */
    sid: string | null;
    /** How this session signed in — password / otp / azure — drives idle-timeout policy */
    loginMethod: string | null;
    idleTimeoutMinutes: number | null;
  };
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.replace("Bearer ", "") : null;
  if (!token) {
    return errorResponse(res, 401, "UNAUTHORIZED", "Missing or invalid authorization header.");
  }
  try {
    const payload = verifyAccessToken(token);

    // Idle-timeout enforcement: a session that's gone quiet longer than its
    // login method's configured window is revoked here, forcing re-authentication.
    let session: { id: string; login_method: string; last_activity_at: string | null } | undefined;
    if (payload.sid) {
      session = await pgGet<{ id: string; login_method: string; last_activity_at: string | null }>(
        "SELECT id, login_method, last_activity_at FROM refresh_tokens WHERE id = ?",
        [payload.sid],
      );
      if (!session) {
        return errorResponse(res, 401, "SESSION_REVOKED", "Session no longer valid. Please sign in again.");
      }
      if (await isSessionIdleExpired(session)) {
        return errorResponse(res, 401, "IDLE_TIMEOUT", "Session expired due to inactivity. Please sign in again.");
      }
    }

    // Identity JOIN result is cached for a short TTL — see identityCacheService.ts
    // for why this is safe (the session-row check above is never cached, and
    // any role/status change already revokes sessions immediately).
    const row = await getIdentity(payload.sub);

    if (!row) {
      return errorResponse(res, 401, "UNAUTHORIZED", "User not found.");
    }
    if (row.status === "Disabled") {
      return errorResponse(res, 403, "FORBIDDEN", "User account is disabled.");
    }

    req.user = {
      id:               row.id,
      role:             row.role,
      email:            row.email,
      hrEmployeeId:     row.hrEmployeeId,
      employeeNo:       row.employeeNo,
      rosterId:         row.rosterId,
      rosterMemberType: row.rosterMemberType,
      effectiveRole:    null,
      sid:              session?.id ?? null,
      loginMethod:      session?.login_method ?? null,
      idleTimeoutMinutes: session ? await getIdleMinutes(session.login_method) : null,
    };

    // For custom (non-system) roles, resolve the base system role for API auth
    if (!SYSTEM_ROLES.has(row.role)) {
      const config = await getRoleConfig(row.role).catch(() => null);
      req.user!.effectiveRole = config?.baseRole ?? null;
    }

    return next();
  } catch {
    return errorResponse(res, 401, "UNAUTHORIZED", "Invalid or expired token.");
  }
};
