import { Router } from "express";
import { pgAll, pgGet } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok } from "../utils/responses.js";

const router = Router();

// ── Headcount by department ───────────────────────────────────────────────────
router.get("/headcount-by-unit", requireAuth, requireRole(ROLE_GROUPS.MANAGEMENT), async (_req, res) => {
  const rows = await pgAll(`
    SELECT ou.name AS unit_name, ou.type, COUNT(e.id) AS headcount
    FROM hr_org_units ou
    LEFT JOIN hr_employees e ON e.org_unit_id = ou.id AND e.status = 'Active'
    GROUP BY ou.id, ou.name, ou.type ORDER BY ou.type, ou.name`);
  return ok(res, { data: rows });
});

// ── Headcount by employment type ──────────────────────────────────────────────
router.get("/headcount-by-type", requireAuth, requireRole(ROLE_GROUPS.MANAGEMENT), async (_req, res) => {
  const rows = await pgAll(`
    SELECT employment_type, COUNT(*) AS headcount, status
    FROM hr_employees GROUP BY employment_type, status ORDER BY employment_type`);
  return ok(res, { data: rows });
});

// ── New hires in a given period ───────────────────────────────────────────────
router.get("/new-hires", requireAuth, requireRole(ROLE_GROUPS.MANAGEMENT), async (req: AuthRequest, res) => {
  const from = (req.query.from as string) || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  const rows = await pgAll(
    `SELECT e.full_name, e.employee_no, e.employment_type, e.start_date, ou.name AS unit_name, jr.title AS role_title
     FROM hr_employees e
     LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
     LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
     WHERE e.start_date >= ? AND e.start_date <= ? ORDER BY e.start_date DESC`,
    [from, to]
  );
  return ok(res, { from, to, data: rows });
});

// ── Benefit plan distribution ─────────────────────────────────────────────────
router.get("/benefit-distribution", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (_req, res) => {
  const rows = await pgAll(`
    SELECT bp.name AS plan_name, c.name AS cadre_name,
      bp.annual_leave_days, bp.sick_leave_days,
      bp.medical_cover, bp.pension,
      COUNT(e.id) AS employee_count
    FROM hr_benefit_plans bp
    LEFT JOIN hr_cadres c ON c.id = bp.cadre_id
    LEFT JOIN hr_employees e ON e.benefit_plan_id = bp.id AND e.status = 'Active'
    GROUP BY bp.id, bp.name, bp.annual_leave_days, bp.sick_leave_days,
             bp.medical_cover, bp.pension, c.name
    ORDER BY c.name, bp.name`);
  return ok(res, { data: rows });
});

// ── Attrition / terminated employees ─────────────────────────────────────────
router.get("/attrition", requireAuth, requireRole(ROLE_GROUPS.MANAGEMENT), async (req: AuthRequest, res) => {
  const from = (req.query.from as string) || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  const rows = await pgAll(
    `SELECT e.full_name, e.employee_no, e.employment_type, e.updated_at AS terminated_at,
            ou.name AS unit_name, jr.title AS role_title
     FROM hr_employees e
     LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
     LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
     WHERE e.status = 'Terminated' AND e.updated_at >= ? AND e.updated_at <= ?
     ORDER BY e.updated_at DESC`,
    [from, to]
  );
  return ok(res, { from, to, data: rows });
});

// ── Dashboard summary counts ──────────────────────────────────────────────────
router.get("/dashboard-summary", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (_req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const [total, newHires, terminated, pendingReviews] = await Promise.all([
    pgGet("SELECT COUNT(*) AS cnt FROM hr_employees WHERE status = 'Active'"),
    pgGet("SELECT COUNT(*) AS cnt FROM hr_employees WHERE start_date >= ?", [monthStart]),
    pgGet("SELECT COUNT(*) AS cnt FROM hr_employees WHERE status = 'Terminated'"),
    pgGet(`SELECT COUNT(DISTINCT e.id) AS cnt FROM hr_employees e
           WHERE e.status = 'Active' AND NOT EXISTS (
             SELECT 1 FROM hr_performance_records pr
             WHERE pr.employee_id = e.id AND pr.review_date >= ?
           )`, [new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10)]),
  ]);
  return ok(res, {
    totalActive: total?.cnt ?? 0,
    newHiresThisMonth: newHires?.cnt ?? 0,
    terminated: terminated?.cnt ?? 0,
    employeesPendingReview: pendingReviews?.cnt ?? 0,
  });
});

// ── Data subject access export (DSAR – Kenya DPA compliance) ─────────────────
router.get("/data-export/:employeeId", requireAuth, requireRole(ROLE_GROUPS.HR_ADMIN), async (req: AuthRequest, res) => {
  const emp = await pgGet("SELECT * FROM hr_employees WHERE id = ?", [req.params.employeeId]);
  if (!emp) return ok(res, null, "Employee not found");
  const [contacts, docs, promotions, trainings, perf] = await Promise.all([
    pgAll("SELECT name, relationship, phone FROM hr_emergency_contacts WHERE employee_id = ?", [req.params.employeeId]),
    pgAll("SELECT document_type, file_name, created_at FROM hr_documents WHERE employee_id = ?", [req.params.employeeId]),
    pgAll("SELECT effective_date, notes FROM hr_promotion_history WHERE employee_id = ? ORDER BY effective_date", [req.params.employeeId]),
    pgAll("SELECT course_name, provider, completion_date, certification_no FROM hr_training_records WHERE employee_id = ?", [req.params.employeeId]),
    pgAll("SELECT review_cycle, review_date, rating, outcomes FROM hr_performance_records WHERE employee_id = ? ORDER BY review_date", [req.params.employeeId]),
  ]);
  return ok(res, {
    exportDate: new Date().toISOString(),
    notice: "Data exported under the Kenya Data Protection Act 2019 – Data Subject Access Request",
    employee: {
      employeeNo: emp.employee_no, fullName: emp.full_name, phone: emp.phone,
      email: emp.email, residentialAddress: emp.residential_address,
      dateOfBirth: emp.date_of_birth, nationalId: emp.national_id, kraPin: emp.kra_pin,
      employmentType: emp.employment_type, startDate: emp.start_date, status: emp.status,
    },
    emergencyContacts: contacts,
    documents: docs,
    careerHistory: promotions,
    training: trainings,
    performanceHistory: perf,
  });
});

export default router;
