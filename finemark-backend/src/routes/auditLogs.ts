import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { auditLogsQuerySchema } from "../utils/validators.js";
import { errorResponse } from "../utils/responses.js";
import { pgGet, pgAll } from "../db.js";

const router = Router();

router.get("/", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req, res) => {
  const parsed = auditLogsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());

  const page = Math.max(parseInt(parsed.data.page || "1", 10) || 1, 1);
  const pageSize = Math.min(parseInt(parsed.data.pageSize || "50", 10) || 50, 200);
  const offset = (page - 1) * pageSize;

  const clauses: string[] = [];
  const params: any[] = [];
  if (parsed.data.search) {
    clauses.push(
      "(action ILIKE ? OR target ILIKE ? OR user_email ILIKE ? OR details_json ILIKE ? " +
      "OR ip_address ILIKE ? OR browser ILIKE ? OR os ILIKE ? OR city ILIKE ? OR country ILIKE ?)"
    );
    const term = `%${parsed.data.search}%`;
    params.push(term, term, term, term, term, term, term, term, term);
  }
  if (parsed.data.severity) { clauses.push("severity = ?"); params.push(parsed.data.severity); }
  if (parsed.data.action) { clauses.push("action = ?"); params.push(parsed.data.action); }
  if (parsed.data.from) { clauses.push("timestamp >= ?"); params.push(new Date(parsed.data.from).toISOString()); }
  if (parsed.data.to) {
    const end = new Date(parsed.data.to);
    end.setHours(23, 59, 59, 999);
    clauses.push("timestamp <= ?");
    params.push(end.toISOString());
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await pgAll(`SELECT * FROM audit_logs ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM audit_logs ${where}`, params);

  const mapped = rows.map((row) => {
    let details: any = null;
    if (row.details_json) { try { details = JSON.parse(row.details_json); } catch { details = row.details_json; } }
    return {
      id: row.id, timestamp: row.timestamp, userId: row.user_id, userEmail: row.user_email,
      role: row.role, action: row.action, target: row.target, severity: row.severity,
      ipAddress: row.ip_address, userAgent: row.user_agent,
      browser: row.browser, os: row.os, deviceType: row.device_type,
      city: row.city, region: row.region, country: row.country,
      details, createdAt: row.created_at,
    };
  });

  return res.status(200).json({ data: mapped, meta: { total: Number(totalRow?.total ?? 0) } });
});

export default router;
