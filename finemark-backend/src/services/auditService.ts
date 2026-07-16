import { Request } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgRun } from "../db.js";
import { getClientIp, parseUserAgent, geoLookup } from "../utils/requestContext.js";

/**
 * Explicit actor info for audit events that happen before authentication
 * succeeds (failed logins, OTP requests, password resets) — req.user isn't
 * set yet on those routes, so the caller supplies who the event is about.
 * When provided, this takes precedence over req.user.
 */
export interface AuditActor {
  id?: string | null;
  email?: string | null;
  role?: string | null;
}

export const auditLog = async (
  req: Request,
  action: string,
  target: string,
  severity: "Info" | "Warning" | "Critical" = "Info",
  details: Record<string, unknown> = {},
  actor?: AuditActor
): Promise<void> => {
  const reqUser = (req as any).user;
  const timestamp = new Date().toISOString();
  const ip = getClientIp(req);
  const userAgent = (req.headers["user-agent"] as string) || "";
  const { browser, os, deviceType } = parseUserAgent(userAgent);
  const { city, region, country } = geoLookup(ip);

  await pgRun(
    `INSERT INTO audit_logs
       (id, timestamp, user_id, user_email, role, action, target, severity,
        ip_address, user_agent, browser, os, device_type, city, region, country,
        details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      timestamp,
      actor?.id ?? reqUser?.id ?? null,
      actor?.email ?? reqUser?.email ?? null,
      actor?.role ?? reqUser?.role ?? null,
      action,
      target,
      severity,
      ip,
      userAgent,
      browser,
      os,
      deviceType,
      city,
      region,
      country,
      JSON.stringify(details),
      timestamp,
    ]
  );
};
