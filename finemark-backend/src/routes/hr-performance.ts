import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { auditLog } from "../services/auditService.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import {
  createPromotionSchema,
  createTrainingSchema,
  createPerformanceSchema,
  updatePerformanceSchema,
} from "../utils/hrValidators.js";

const router = Router();
const REVIEWER_ROLES = ["Admin", "Management", "TeamLead"];

// ═══════════════════════════════════════════════════════════════════════════════
// PROMOTION / CAREER HISTORY
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/employees/:id/promotions", requireAuth, async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT id FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  const rows = await pgAll(`
    SELECT ph.*,
      jrf.title AS from_role_title, jrt.title AS to_role_title,
      cf.name   AS from_cadre_name, ct.name   AS to_cadre_name
    FROM hr_promotion_history ph
    LEFT JOIN hr_job_roles jrf ON jrf.id = ph.from_role_id
    LEFT JOIN hr_job_roles jrt ON jrt.id = ph.to_role_id
    LEFT JOIN hr_cadres    cf  ON  cf.id = ph.from_cadre_id
    LEFT JOIN hr_cadres    ct  ON  ct.id = ph.to_cadre_id
    WHERE ph.employee_id = ? ORDER BY ph.effective_date`, [req.params.id]);
  return ok(res, rows);
});

router.post("/employees/:id/promotions", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT id FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  const parsed = createPromotionSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { fromRoleId, toRoleId, fromCadreId, toCadreId, effectiveDate, notes } = parsed.data;
  const roleExists = await pgGet("SELECT id FROM hr_job_roles WHERE id = ?", [toRoleId]);
  if (!roleExists) return errorResponse(res, 404, "NOT_FOUND", "Target role not found.");
  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO hr_promotion_history
      (id, employee_id, from_role_id, to_role_id, from_cadre_id, to_cadre_id, effective_date, notes, recorded_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, req.params.id, fromRoleId || null, toRoleId, fromCadreId || null, toCadreId || null, effectiveDate, notes || null, req.user?.email || "system", now]
  );
  // Also update the employee's current role and cadre
  await pgRun(
    "UPDATE hr_employees SET job_role_id=?, cadre_id=COALESCE(?,cadre_id), updated_at=? WHERE id=?",
    [toRoleId, toCadreId || null, now, req.params.id]
  );
  auditLog(req, "HR_PROMOTION_RECORDED", `hr_employee:${req.params.id}`, "Info", { toRoleId, effectiveDate }).catch(console.error);
  return created(res, { id }, "Promotion recorded and employee profile updated");
});

router.delete("/employees/:id/promotions/:pid", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const promo = await pgGet("SELECT id FROM hr_promotion_history WHERE id = ? AND employee_id = ?", [req.params.pid, req.params.id]);
  if (!promo) return errorResponse(res, 404, "NOT_FOUND", "Promotion record not found.");
  await pgRun("DELETE FROM hr_promotion_history WHERE id = ?", [req.params.pid]);
  auditLog(req, "HR_PROMOTION_DELETED", `hr_employee:${req.params.id}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Promotion record deleted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRAINING RECORDS
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/employees/:id/training", requireAuth, async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT id FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  return ok(res, await pgAll("SELECT * FROM hr_training_records WHERE employee_id = ? ORDER BY completion_date DESC", [req.params.id]));
});

router.post("/employees/:id/training", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT id FROM hr_employees WHERE id = ?", [req.params.id]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  const parsed = createTrainingSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { courseName, provider, completionDate, certificationNo, notes } = parsed.data;
  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    "INSERT INTO hr_training_records (id, employee_id, course_name, provider, completion_date, certification_no, notes, created_at) VALUES (?,?,?,?,?,?,?,?)",
    [id, req.params.id, courseName, provider || null, completionDate, certificationNo || null, notes || null, now]
  );
  auditLog(req, "HR_TRAINING_ADDED", `hr_employee:${req.params.id}`, "Info", { courseName }).catch(console.error);
  return created(res, { id }, "Training record added");
});

router.delete("/employees/:id/training/:tid", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const t = await pgGet("SELECT id FROM hr_training_records WHERE id = ? AND employee_id = ?", [req.params.tid, req.params.id]);
  if (!t) return errorResponse(res, 404, "NOT_FOUND", "Training record not found.");
  await pgRun("DELETE FROM hr_training_records WHERE id = ?", [req.params.tid]);
  return ok(res, null, "Training record deleted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE REVIEWS
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/employees/:id/performance", requireAuth, async (req: AuthRequest, res) => {
  const isAdmin = req.user?.role === "Admin";
  const self = await pgGet("SELECT id FROM hr_employees WHERE user_account_id = ?", [req.user?.id]);
  const isSelf = self?.id === req.params.id;
  if (!isAdmin && !isSelf && !REVIEWER_ROLES.includes(req.user?.role || "")) {
    return errorResponse(res, 403, "FORBIDDEN", "Access denied.");
  }
  const rows = await pgAll("SELECT * FROM hr_performance_records WHERE employee_id = ? ORDER BY review_date DESC", [req.params.id]);
  return ok(res, rows);
});

router.post("/reviews", requireAuth, requireRole(REVIEWER_ROLES), async (req: AuthRequest, res) => {
  const parsed = createPerformanceSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { employeeId, reviewCycle, reviewDate, rating, goals, comments, outcomes } = parsed.data;
  const emp = await pgGet("SELECT id FROM hr_employees WHERE id = ?", [employeeId]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");

  // Team leads can only review their direct reports
  if (req.user?.role === "TeamLead") {
    const lead = await pgGet("SELECT id FROM hr_employees WHERE user_account_id = ?", [req.user?.id]);
    const directReport = await pgGet("SELECT id FROM hr_employees WHERE id = ? AND manager_id = ?", [employeeId, lead?.id]);
    if (!directReport) return errorResponse(res, 403, "FORBIDDEN", "You can only review your direct reports.");
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO hr_performance_records
      (id, employee_id, reviewer_id, review_cycle, review_date, rating, goals, comments, outcomes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, employeeId, req.user?.id, reviewCycle, reviewDate, rating, goals || null, comments || null, outcomes || null, now, now]
  );
  auditLog(req, "HR_PERFORMANCE_REVIEW_CREATED", `hr_employee:${employeeId}`, "Info", { reviewCycle, rating }).catch(console.error);
  return created(res, { id }, "Performance review saved");
});

router.patch("/reviews/:id", requireAuth, requireRole(REVIEWER_ROLES), async (req: AuthRequest, res) => {
  const review = await pgGet("SELECT * FROM hr_performance_records WHERE id = ?", [req.params.id]);
  if (!review) return errorResponse(res, 404, "NOT_FOUND", "Review not found.");
  if (review.reviewer_id !== req.user?.id && req.user?.role !== "Admin") {
    return errorResponse(res, 403, "FORBIDDEN", "You can only edit your own reviews.");
  }
  const parsed = updatePerformanceSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE hr_performance_records SET
      review_cycle=COALESCE(?,review_cycle), review_date=COALESCE(?,review_date),
      rating=COALESCE(?,rating), goals=COALESCE(?,goals),
      comments=COALESCE(?,comments), outcomes=COALESCE(?,outcomes), updated_at=?
     WHERE id=?`,
    [d.reviewCycle ?? null, d.reviewDate ?? null, d.rating ?? null, d.goals ?? null, d.comments ?? null, d.outcomes ?? null, now, req.params.id]
  );
  auditLog(req, "HR_PERFORMANCE_REVIEW_UPDATED", `hr_performance:${req.params.id}`, "Info", d).catch(console.error);
  return ok(res, null, "Review updated");
});

router.delete("/reviews/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const review = await pgGet("SELECT id FROM hr_performance_records WHERE id = ?", [req.params.id]);
  if (!review) return errorResponse(res, 404, "NOT_FOUND", "Review not found.");
  await pgRun("DELETE FROM hr_performance_records WHERE id = ?", [req.params.id]);
  auditLog(req, "HR_PERFORMANCE_REVIEW_DELETED", `hr_performance:${req.params.id}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Review deleted");
});

export default router;
