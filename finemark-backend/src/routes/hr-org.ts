import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { auditLog } from "../services/auditService.js";
import { created, errorResponse, ok } from "../utils/responses.js";
import {
  createOrgUnitSchema, updateOrgUnitSchema,
  createJobRoleSchema, updateJobRoleSchema,
  createCadreSchema,
  createBenefitPlanSchema, updateBenefitPlanSchema,
} from "../utils/hrValidators.js";

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// ORGANISATION UNITS
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/units", requireAuth, async (_req, res) => {
  const rows = await pgAll(`
    SELECT u.*, e.full_name AS head_name
    FROM hr_org_units u
    LEFT JOIN hr_employees e ON e.id = u.head_employee_id
    ORDER BY u.type, u.name`);
  return ok(res, { data: rows });
});

router.post("/units", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const parsed = createOrgUnitSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { name, type, parentId, headEmployeeId, description } = parsed.data;
  if (parentId) {
    const parent = await pgGet("SELECT id FROM hr_org_units WHERE id = ?", [parentId]);
    if (!parent) return errorResponse(res, 404, "NOT_FOUND", "Parent unit not found.");
  }
  const now = new Date().toISOString();
  const id = uuidv4();
  await pgRun(
    `INSERT INTO hr_org_units (id, name, type, parent_id, head_employee_id, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, type, parentId || null, headEmployeeId || null, description || null, now, now]
  );
  auditLog(req, "HR_ORG_UNIT_CREATED", `hr_org_unit:${id}`, "Info", { name }).catch(console.error);
  return created(res, { id, name, type }, "Organisation unit created");
});

router.patch("/units/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const unit = await pgGet("SELECT * FROM hr_org_units WHERE id = ?", [req.params.id]);
  if (!unit) return errorResponse(res, 404, "NOT_FOUND", "Unit not found.");
  const parsed = updateOrgUnitSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE hr_org_units SET name=COALESCE(?,name), type=COALESCE(?,type), parent_id=COALESCE(?,parent_id),
     head_employee_id=COALESCE(?,head_employee_id), description=COALESCE(?,description), updated_at=?
     WHERE id=?`,
    [d.name ?? null, d.type ?? null, d.parentId ?? null, d.headEmployeeId ?? null, d.description ?? null, now, req.params.id]
  );
  auditLog(req, "HR_ORG_UNIT_UPDATED", `hr_org_unit:${req.params.id}`, "Info", d).catch(console.error);
  const updated = await pgGet("SELECT * FROM hr_org_units WHERE id = ?", [req.params.id]);
  return ok(res, updated, "Unit updated");
});

router.delete("/units/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const unit = await pgGet("SELECT id FROM hr_org_units WHERE id = ?", [req.params.id]);
  if (!unit) return errorResponse(res, 404, "NOT_FOUND", "Unit not found.");
  const children = await pgGet("SELECT id FROM hr_org_units WHERE parent_id = ?", [req.params.id]);
  if (children) return errorResponse(res, 409, "CONFLICT", "Unit has sub-units. Reassign them first.");
  const hasEmployees = await pgGet("SELECT id FROM hr_employees WHERE org_unit_id = ?", [req.params.id]);
  if (hasEmployees) return errorResponse(res, 409, "CONFLICT", "Unit has employees. Reassign them first.");
  await pgRun("DELETE FROM hr_org_units WHERE id = ?", [req.params.id]);
  auditLog(req, "HR_ORG_UNIT_DELETED", `hr_org_unit:${req.params.id}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Unit deleted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// JOB ROLES
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/roles", requireAuth, async (_req, res) => {
  const rows = await pgAll("SELECT * FROM hr_job_roles ORDER BY grade_level, title");
  return ok(res, { data: rows });
});

router.post("/roles", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const parsed = createJobRoleSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { title, description, responsibilities, gradeLevel, salaryBandMin, salaryBandMax } = parsed.data;
  const now = new Date().toISOString();
  const id = uuidv4();
  await pgRun(
    `INSERT INTO hr_job_roles (id, title, description, responsibilities, grade_level, salary_band_min, salary_band_max, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, description || null, responsibilities || null, gradeLevel || null, salaryBandMin ?? null, salaryBandMax ?? null, now, now]
  );
  auditLog(req, "HR_JOB_ROLE_CREATED", `hr_job_role:${id}`, "Info", { title }).catch(console.error);
  return created(res, { id, title }, "Job role created");
});

router.patch("/roles/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const role = await pgGet("SELECT id FROM hr_job_roles WHERE id = ?", [req.params.id]);
  if (!role) return errorResponse(res, 404, "NOT_FOUND", "Role not found.");
  const parsed = updateJobRoleSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE hr_job_roles SET title=COALESCE(?,title), description=COALESCE(?,description),
     responsibilities=COALESCE(?,responsibilities), grade_level=COALESCE(?,grade_level),
     salary_band_min=COALESCE(?,salary_band_min), salary_band_max=COALESCE(?,salary_band_max), updated_at=?
     WHERE id=?`,
    [d.title ?? null, d.description ?? null, d.responsibilities ?? null, d.gradeLevel ?? null,
     d.salaryBandMin ?? null, d.salaryBandMax ?? null, now, req.params.id]
  );
  auditLog(req, "HR_JOB_ROLE_UPDATED", `hr_job_role:${req.params.id}`, "Info", d).catch(console.error);
  return ok(res, await pgGet("SELECT * FROM hr_job_roles WHERE id = ?", [req.params.id]), "Role updated");
});

router.delete("/roles/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const role = await pgGet("SELECT id FROM hr_job_roles WHERE id = ?", [req.params.id]);
  if (!role) return errorResponse(res, 404, "NOT_FOUND", "Role not found.");
  const inUse = await pgGet("SELECT id FROM hr_employees WHERE job_role_id = ?", [req.params.id]);
  if (inUse) return errorResponse(res, 409, "CONFLICT", "Role is assigned to employees.");
  await pgRun("DELETE FROM hr_job_roles WHERE id = ?", [req.params.id]);
  auditLog(req, "HR_JOB_ROLE_DELETED", `hr_job_role:${req.params.id}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Role deleted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// CADRES
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/cadres", requireAuth, async (_req, res) => {
  return ok(res, { data: await pgAll("SELECT * FROM hr_cadres ORDER BY name") });
});

router.post("/cadres", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const parsed = createCadreSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const exists = await pgGet("SELECT id FROM hr_cadres WHERE name = ?", [parsed.data.name]);
  if (exists) return errorResponse(res, 409, "CONFLICT", "Cadre already exists.");
  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun("INSERT INTO hr_cadres (id, name, description, created_at) VALUES (?, ?, ?, ?)",
    [id, parsed.data.name, parsed.data.description || null, now]);
  auditLog(req, "HR_CADRE_CREATED", `hr_cadre:${id}`, "Info", parsed.data).catch(console.error);
  return created(res, { id, name: parsed.data.name }, "Cadre created");
});

router.delete("/cadres/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const cadre = await pgGet("SELECT id FROM hr_cadres WHERE id = ?", [req.params.id]);
  if (!cadre) return errorResponse(res, 404, "NOT_FOUND", "Cadre not found.");
  const inUse = await pgGet("SELECT id FROM hr_employees WHERE cadre_id = ?", [req.params.id]);
  if (inUse) return errorResponse(res, 409, "CONFLICT", "Cadre is assigned to employees.");
  await pgRun("DELETE FROM hr_cadres WHERE id = ?", [req.params.id]);
  auditLog(req, "HR_CADRE_DELETED", `hr_cadre:${req.params.id}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Cadre deleted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// BENEFIT PLANS
// ═══════════════════════════════════════════════════════════════════════════════
const mapPlan = (row: any) => ({
  id: row.id,
  name: row.name,
  cadreId: row.cadre_id ?? null,
  cadreName: row.cadre_name ?? null,
  annualLeaveDays: row.annual_leave_days,
  sickLeaveDays: row.sick_leave_days,
  medicalCover: row.medical_cover ?? null,
  pension: row.pension ?? null,
  otherBenefits: row.other_benefits ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

router.get("/benefit-plans", requireAuth, async (_req, res) => {
  const rows = await pgAll(`
    SELECT bp.*, c.name AS cadre_name FROM hr_benefit_plans bp
    LEFT JOIN hr_cadres c ON c.id = bp.cadre_id ORDER BY c.name, bp.name`);
  return ok(res, { data: rows.map(mapPlan) });
});

router.post("/benefit-plans", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const parsed = createBenefitPlanSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { cadreId, name, annualLeaveDays, sickLeaveDays, medicalCover, pension, otherBenefits } = parsed.data;
  if (cadreId) {
    const cadre = await pgGet("SELECT id FROM hr_cadres WHERE id = ?", [cadreId]);
    if (!cadre) return errorResponse(res, 404, "NOT_FOUND", "Cadre not found.");
  }
  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO hr_benefit_plans (id, cadre_id, name, annual_leave_days, sick_leave_days, medical_cover, pension, other_benefits, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, cadreId || null, name, annualLeaveDays, sickLeaveDays, medicalCover || null, pension || null, otherBenefits || null, now, now]
  );
  auditLog(req, "HR_BENEFIT_PLAN_CREATED", `hr_benefit_plan:${id}`, "Info", { name }).catch(console.error);
  const row = await pgGet("SELECT bp.*, c.name AS cadre_name FROM hr_benefit_plans bp LEFT JOIN hr_cadres c ON c.id = bp.cadre_id WHERE bp.id = ?", [id]);
  return created(res, mapPlan(row), "Benefit plan created");
});

router.patch("/benefit-plans/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const plan = await pgGet("SELECT id FROM hr_benefit_plans WHERE id = ?", [req.params.id]);
  if (!plan) return errorResponse(res, 404, "NOT_FOUND", "Benefit plan not found.");
  const parsed = updateBenefitPlanSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE hr_benefit_plans SET cadre_id=COALESCE(?,cadre_id), name=COALESCE(?,name),
     annual_leave_days=COALESCE(?,annual_leave_days), sick_leave_days=COALESCE(?,sick_leave_days),
     medical_cover=COALESCE(?,medical_cover), pension=COALESCE(?,pension),
     other_benefits=COALESCE(?,other_benefits), updated_at=? WHERE id=?`,
    [d.cadreId ?? null, d.name ?? null, d.annualLeaveDays ?? null, d.sickLeaveDays ?? null,
     d.medicalCover ?? null, d.pension ?? null, d.otherBenefits ?? null, now, req.params.id]
  );
  auditLog(req, "HR_BENEFIT_PLAN_UPDATED", `hr_benefit_plan:${req.params.id}`, "Info", d).catch(console.error);
  const updated = await pgGet("SELECT bp.*, c.name AS cadre_name FROM hr_benefit_plans bp LEFT JOIN hr_cadres c ON c.id = bp.cadre_id WHERE bp.id = ?", [req.params.id]);
  return ok(res, mapPlan(updated), "Plan updated");
});

router.delete("/benefit-plans/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const plan = await pgGet("SELECT id FROM hr_benefit_plans WHERE id = ?", [req.params.id]);
  if (!plan) return errorResponse(res, 404, "NOT_FOUND", "Plan not found.");
  const inUse = await pgGet("SELECT id FROM hr_employees WHERE benefit_plan_id = ?", [req.params.id]);
  if (inUse) return errorResponse(res, 409, "CONFLICT", "Plan assigned to employees.");
  await pgRun("DELETE FROM hr_benefit_plans WHERE id = ?", [req.params.id]);
  auditLog(req, "HR_BENEFIT_PLAN_DELETED", `hr_benefit_plan:${req.params.id}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Plan deleted");
});

export default router;
