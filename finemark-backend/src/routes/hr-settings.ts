/**
 * HR Settings — Employee Number Configuration
 *
 * GET  /hr/settings/emp-no-config         → list all employment type configs
 * GET  /hr/settings/emp-no-config/:type   → get single type config
 * PUT  /hr/settings/emp-no-config/:type   → upsert config for a type
 * DELETE /hr/settings/emp-no-config/:type → remove a custom type config
 * GET  /hr/settings/emp-no-preview/:type  → preview what the next number would look like
 */

import { Router } from "express";
import { pgAll, pgGet, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { auditLog } from "../services/auditService.js";
import { errorResponse, ok } from "../utils/responses.js";

const router = Router();

// Known employment types (can be extended via the API)
const DEFAULT_TYPES = [
  "Permanent",
  "Contract",
  "Contractor",
  "Intern",
  "Casual",
  "Part-Time",
  "Consultant",
];

// ══════════════════════════════════════════════════════════════════════════════
// LIST all configs
// ══════════════════════════════════════════════════════════════════════════════
router.get("/emp-no-config", requireAuth, async (_req, res) => {
  const rows = await pgAll(
    "SELECT employment_type, prefix, type_code, padding, updated_at FROM hr_emp_no_config ORDER BY employment_type"
  );
  return ok(res, { data: rows });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET single config
// ══════════════════════════════════════════════════════════════════════════════
router.get("/emp-no-config/:type", requireAuth, async (req, res) => {
  const type = decodeURIComponent(req.params.type);
  const row = await pgGet(
    "SELECT employment_type, prefix, type_code, padding, updated_at FROM hr_emp_no_config WHERE employment_type = ?",
    [type]
  );
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Configuration not found for this employment type.");
  return ok(res, row);
});

// ══════════════════════════════════════════════════════════════════════════════
// UPSERT config for a type  (Admin only)
// ══════════════════════════════════════════════════════════════════════════════
router.put("/emp-no-config/:type", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const type = decodeURIComponent(req.params.type);
  const { prefix, typeCode, padding } = req.body;

  // Validate
  if (!prefix || typeof prefix !== "string" || !/^[A-Z0-9]+$/i.test(prefix.trim())) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "prefix must be non-empty alphanumeric.");
  }
  if (!typeCode || typeof typeCode !== "string" || !/^[A-Z0-9]+$/i.test(typeCode.trim())) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "typeCode must be non-empty alphanumeric.");
  }
  const pad = parseInt(padding, 10);
  if (isNaN(pad) || pad < 2 || pad > 8) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "padding must be between 2 and 8.");
  }

  // Ensure type_code is unique across types (except this type itself)
  const conflict = await pgGet(
    "SELECT employment_type FROM hr_emp_no_config WHERE UPPER(type_code) = UPPER(?) AND employment_type != ?",
    [typeCode.trim().toUpperCase(), type]
  );
  if (conflict) {
    return errorResponse(res, 409, "CONFLICT",
      `Type code "${typeCode.toUpperCase()}" is already used by employment type: ${conflict.employment_type}`);
  }

  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO hr_emp_no_config (employment_type, prefix, type_code, padding, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (employment_type) DO UPDATE
       SET prefix=EXCLUDED.prefix, type_code=EXCLUDED.type_code,
           padding=EXCLUDED.padding, updated_at=EXCLUDED.updated_at`,
    [type, prefix.trim().toUpperCase(), typeCode.trim().toUpperCase(), pad, now]
  );
  auditLog(req, "HR_EMP_NO_CONFIG_UPDATED", `hr_emp_no_config:${type}`, "Info",
    { prefix, typeCode, padding: pad }).catch(console.error);
  const updated = await pgGet(
    "SELECT employment_type, prefix, type_code, padding, updated_at FROM hr_emp_no_config WHERE employment_type = ?",
    [type]
  );
  return ok(res, updated, "Employee number configuration saved.");
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE a type config  (resets to defaults — does not affect existing employees)
// ══════════════════════════════════════════════════════════════════════════════
router.delete("/emp-no-config/:type", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const type = decodeURIComponent(req.params.type);
  if (DEFAULT_TYPES.includes(type)) {
    return errorResponse(res, 400, "BAD_REQUEST",
      "Cannot delete a default employment type config. You can edit it instead.");
  }
  await pgRun("DELETE FROM hr_emp_no_config WHERE employment_type = ?", [type]);
  auditLog(req, "HR_EMP_NO_CONFIG_DELETED", `hr_emp_no_config:${type}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Configuration deleted.");
});

// ══════════════════════════════════════════════════════════════════════════════
// PREVIEW — what would the next employee number look like for a given type?
// ══════════════════════════════════════════════════════════════════════════════
router.get("/emp-no-preview/:type", requireAuth, async (req, res) => {
  const type = decodeURIComponent(req.params.type);
  const cfg = await pgGet(
    "SELECT prefix, type_code, padding FROM hr_emp_no_config WHERE employment_type = ?",
    [type]
  ) as { prefix: string; type_code: string; padding: number } | undefined;
  const prefix   = cfg?.prefix    ?? "FM";
  const typeCode = cfg?.type_code ?? "EMP";
  const padding  = cfg?.padding   ?? 4;

  const rows = await pgAll(
    "SELECT employee_no FROM hr_employees WHERE employee_no LIKE ? ORDER BY employee_no",
    [`${prefix}-${typeCode}-%`]
  );
  let maxSeq = 0;
  for (const r of rows) {
    const parts = r.employee_no.split("-");
    const seq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }
  const nextNo = `${prefix}-${typeCode}-${String(maxSeq + 1).padStart(padding, "0")}`;
  return ok(res, { type, nextEmployeeNo: nextNo, currentCount: rows.length });
});

export default router;
