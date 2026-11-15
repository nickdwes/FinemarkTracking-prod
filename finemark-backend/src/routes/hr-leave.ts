import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS, ROLES, LEGACY_ROLE_MAP } from "../middleware/rbac.js";
import { ensureBalance, computeEntitlement } from "../services/hrLeaveBalanceService.js";
import { auditLog } from "../services/auditService.js";
import { createNotification } from "./notifications.js";
import { created, errorResponse, ok } from "../utils/responses.js";
import {
  createLeaveTypeSchema, updateLeaveTypeSchema,
  createLeaveEntitlementSchema, updateLeaveEntitlementSchema,
  createLeaveApplicationSchema,
  approveLeaveSchema, hrOverrideLeaveSchema,
  recalculateBalanceSchema,
  listApplicationsQuerySchema,
} from "../utils/hrLeaveValidators.js";

const router = Router();
// Unrestricted, org-wide leave access. BDM/BDMCorporate deliberately excluded —
// they used to be full-access here too ("any BDM sees every team"), which broke
// once retail split into multiple regional BDMs each managing their own reps.
// Everyone else's rights come from the org chart via leaveActor() below.
const HR_LEAVE_FULL_ACCESS = [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.HR] as string[];
// Local override for this module only — NOT ROLE_GROUPS.ADMIN_ONLY, which is a
// shared cross-module constant ([Admin] only); broadening that globally would
// grant the HR role admin rights everywhere, not just over leave configuration.
const HR_LEAVE_ADMIN_ROLES = [ROLES.ADMIN, ROLES.HR] as string[];
// requireRole() already resolves a legacy role (e.g. "Management") to its
// canonical equivalent ("Executive") when checking route access, via
// LEGACY_ROLE_MAP. This module's own scoping logic below reads req.user.role
// directly for finer-grained decisions (full-access vs manager-scoped vs
// self), so it needs the same resolution or a legacy-role caller passes the
// route guard but then falls through to the wrong scoping branch.
function canonicalRole(role: string | undefined | null): string {
  return (role && LEGACY_ROLE_MAP[role]) || role || "";
}

// Who the caller is in leave terms. Manager rights (approve at L1, see the
// team's applications/balances/calendar) are granted by having direct reports
// in the HR org chart (hr_employees.manager_id) — NOT by role. See the
// canApproveLeave() design note in middleware/rbac.ts. The previous role-based
// gate (Admin/Executive/HR/BDM/BDMCorporate/TeamLead) silently locked out any
// manager whose account role happened to be something else — in practice the
// Technical Manager (27 direct reports) and the Recovery manager (4), i.e. a
// third of the company could not get their leave approved.
type LeaveActor = {
  role: string;
  fullAccess: boolean;          // HR / Admin / Executive — org-wide
  emp: { id: string; full_name: string; user_account_id: string } | null;
  isManager: boolean;           // has ≥1 active direct report
};
async function leaveActor(user: { id: string; role: string }): Promise<LeaveActor> {
  const role = canonicalRole(user.role);
  const fullAccess = HR_LEAVE_FULL_ACCESS.includes(role);
  const emp = await pgGet<any>("SELECT id, full_name, user_account_id FROM hr_employees WHERE user_account_id=?", [user.id]);
  const isManager = emp
    ? !!(await pgGet("SELECT 1 AS x FROM hr_employees WHERE manager_id=? AND status='Active' LIMIT 1", [emp.id]))
    : false;
  return { role, fullAccess, emp: emp ?? null, isManager };
}

// In-app notifications (bell in the header, assets/layout.js) — the same
// app_notifications mechanism tickets/proforma/custody already use. Fire-and-
// forget: a notification failure must never fail the leave action itself.
function notify(opts: Parameters<typeof createNotification>[0]) {
  createNotification(opts).catch(e => console.error("[hr-leave notify]", e?.message || e));
}

// ── WORKING DAYS helper (Mon–Fri, no weekend counting) ───────────────────────
function countWorkingDays(start: string, end: string): number {
  let count = 0;
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE TYPES
// ─────────────────────────────────────────────────────────────────────────────
router.get("/types", requireAuth, async (_req, res) => {
  const rows = await pgAll(`SELECT * FROM hr_leave_types ORDER BY statutory DESC, name`);
  return ok(res, { data: rows });
});

router.post("/types", requireAuth, requireRole(HR_LEAVE_ADMIN_ROLES), async (req: AuthRequest, res) => {
  const parsed = createLeaveTypeSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const exists = await pgGet("SELECT id FROM hr_leave_types WHERE LOWER(name) = LOWER(?)", [d.name]);
  if (exists) return errorResponse(res, 409, "CONFLICT", "Leave type with this name already exists.");
  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO hr_leave_types (id, name, description, statutory, gender_restricted, max_days_per_year,
      entitlement_model, carry_forward_allowed, carry_forward_cap, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, d.name, d.description ?? null, d.statutory ? 1 : 0, d.genderRestricted ?? null,
     d.maxDaysPerYear ?? null, d.entitlementModel, d.carryForwardAllowed ? 1 : 0,
     d.carryForwardCap ?? null, d.isActive ? 1 : 0, now, now]
  );
  auditLog(req, "HR_LEAVE_TYPE_CREATED", `hr_leave_type:${id}`, "Info", { name: d.name }).catch(console.error);
  return created(res, { id, name: d.name }, "Leave type created");
});

router.patch("/types/:id", requireAuth, requireRole(HR_LEAVE_ADMIN_ROLES), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT * FROM hr_leave_types WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Leave type not found.");
  const parsed = updateLeaveTypeSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  if (d.name) {
    const dup = await pgGet("SELECT id FROM hr_leave_types WHERE LOWER(name)=LOWER(?) AND id<>?", [d.name, req.params.id]);
    if (dup) return errorResponse(res, 409, "CONFLICT", "Leave type with this name already exists.");
  }
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE hr_leave_types SET
      name=COALESCE(?,name), description=COALESCE(?,description), statutory=COALESCE(?,statutory),
      gender_restricted=COALESCE(?,gender_restricted), max_days_per_year=COALESCE(?,max_days_per_year),
      entitlement_model=COALESCE(?,entitlement_model), carry_forward_allowed=COALESCE(?,carry_forward_allowed),
      carry_forward_cap=COALESCE(?,carry_forward_cap), is_active=COALESCE(?,is_active), updated_at=?
     WHERE id=?`,
    [d.name ?? null, d.description ?? null, d.statutory != null ? (d.statutory ? 1 : 0) : null,
     d.genderRestricted ?? null, d.maxDaysPerYear ?? null, d.entitlementModel ?? null,
     d.carryForwardAllowed != null ? (d.carryForwardAllowed ? 1 : 0) : null,
     d.carryForwardCap ?? null, d.isActive != null ? (d.isActive ? 1 : 0) : null, now, req.params.id]
  );
  auditLog(req, "HR_LEAVE_TYPE_UPDATED", `hr_leave_type:${req.params.id}`, "Info", d).catch(console.error);
  return ok(res, await pgGet("SELECT * FROM hr_leave_types WHERE id = ?", [req.params.id]), "Updated");
});

router.delete("/types/:id", requireAuth, requireRole(HR_LEAVE_ADMIN_ROLES), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT id FROM hr_leave_types WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Leave type not found.");
  const hasApps = await pgGet("SELECT id FROM hr_leave_applications WHERE leave_type_id = ?", [req.params.id]);
  if (hasApps) return errorResponse(res, 409, "CONFLICT", "Leave applications exist for this type. Deactivate instead.");
  const entCount = (await pgGet("SELECT COUNT(*) c FROM hr_leave_entitlements WHERE leave_type_id = ?", [req.params.id]))?.c ?? 0;
  const balCount = (await pgGet("SELECT COUNT(*) c FROM hr_leave_balances WHERE leave_type_id = ?", [req.params.id]))?.c ?? 0;
  if ((entCount > 0 || balCount > 0) && req.query.confirm !== "true") {
    return errorResponse(res, 409, "CONFIRM_REQUIRED",
      `This will delete ${entCount} entitlement rule(s) and ${balCount} balance record(s).`,
      { entitlements: Number(entCount), balances: Number(balCount) });
  }
  await pgRun("DELETE FROM hr_leave_entitlements WHERE leave_type_id = ?", [req.params.id]);
  await pgRun("DELETE FROM hr_leave_balances WHERE leave_type_id = ?", [req.params.id]);
  await pgRun("DELETE FROM hr_leave_types WHERE id = ?", [req.params.id]);
  auditLog(req, "HR_LEAVE_TYPE_DELETED", `hr_leave_type:${req.params.id}`, "Warning", {}).catch(console.error);
  return ok(res, null, "Leave type deleted");
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE ENTITLEMENTS
// ─────────────────────────────────────────────────────────────────────────────
router.get("/entitlements", requireAuth, async (_req, res) => {
  const rows = await pgAll(`
    SELECT e.*, lt.name AS leave_type_name, c.name AS cadre_name
    FROM hr_leave_entitlements e
    JOIN hr_leave_types lt ON lt.id = e.leave_type_id
    LEFT JOIN hr_cadres c ON c.id = e.cadre_id
    ORDER BY lt.name, c.name`);
  return ok(res, { data: rows });
});

router.post("/entitlements", requireAuth, requireRole(HR_LEAVE_ADMIN_ROLES), async (req: AuthRequest, res) => {
  const parsed = createLeaveEntitlementSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const lt = await pgGet("SELECT id FROM hr_leave_types WHERE id = ?", [d.leaveTypeId]);
  if (!lt) return errorResponse(res, 404, "NOT_FOUND", "Leave type not found.");
  if (d.cadreId) {
    const cadre = await pgGet("SELECT id FROM hr_cadres WHERE id = ?", [d.cadreId]);
    if (!cadre) return errorResponse(res, 404, "NOT_FOUND", "Cadre not found.");
  }
  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO hr_leave_entitlements (id, leave_type_id, cadre_id, days_per_year, accrual_rate, min_service_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, d.leaveTypeId, d.cadreId ?? null, d.daysPerYear, d.accrualRate ?? null, d.minServiceDays, now, now]
  );
  auditLog(req, "HR_LEAVE_ENTITLEMENT_CREATED", `hr_leave_entitlement:${id}`, "Info", d).catch(console.error);
  return created(res, { id }, "Entitlement rule created");
});

router.patch("/entitlements/:id", requireAuth, requireRole(HR_LEAVE_ADMIN_ROLES), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT * FROM hr_leave_entitlements WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Entitlement not found.");
  const parsed = updateLeaveEntitlementSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE hr_leave_entitlements SET
      cadre_id=COALESCE(?,cadre_id), days_per_year=COALESCE(?,days_per_year),
      accrual_rate=COALESCE(?,accrual_rate), min_service_days=COALESCE(?,min_service_days), updated_at=?
     WHERE id=?`,
    [d.cadreId ?? null, d.daysPerYear ?? null, d.accrualRate ?? null, d.minServiceDays ?? null, now, req.params.id]
  );
  return ok(res, await pgGet("SELECT * FROM hr_leave_entitlements WHERE id = ?", [req.params.id]), "Updated");
});

router.delete("/entitlements/:id", requireAuth, requireRole(HR_LEAVE_ADMIN_ROLES), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT id FROM hr_leave_entitlements WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Entitlement not found.");
  await pgRun("DELETE FROM hr_leave_entitlements WHERE id = ?", [req.params.id]);
  return ok(res, null, "Entitlement rule deleted");
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE BALANCES
// ─────────────────────────────────────────────────────────────────────────────

// Helper: look up or create a balance row
// ensureBalance/computeEntitlement moved to services/hrLeaveBalanceService.ts —
// the accrual cron (jobs/leaveAccrualCron.ts) needs the same logic.

router.get("/balances", requireAuth, async (req: AuthRequest, res) => {
  const year = parseInt((req.query.year as string) || String(new Date().getFullYear()), 10);
  const actor = await leaveActor(req.user!);
  let empFilter = "";
  const args: any[] = [year];
  if (actor.fullAccess) {
    if (req.query.employeeId) {
      empFilter = " AND b.employee_id = ?";
      args.push(req.query.employeeId as string);
    }
  } else if (actor.isManager) {
    // Manager: scope to real direct reports, not the whole company —
    // optionally narrowed further to one of those reports.
    if (req.query.employeeId) {
      empFilter = " AND b.employee_id = ? AND b.employee_id IN (SELECT id FROM hr_employees WHERE manager_id=?)";
      args.push(req.query.employeeId as string, actor.emp!.id);
    } else {
      empFilter = " AND b.employee_id IN (SELECT id FROM hr_employees WHERE manager_id=?)";
      args.push(actor.emp!.id);
    }
  } else {
    // Everyone else: always scope to own employee record
    if (!actor.emp) return ok(res, { data: [] });
    empFilter = " AND b.employee_id = ?";
    args.push(actor.emp.id);
  }
  const rows = await pgAll(
    `SELECT b.*, e.full_name, e.employee_no, lt.name AS leave_type_name,
       (b.entitled_days + b.carried_forward - b.used_days - b.pending_days) AS remaining_days
     FROM hr_leave_balances b
     JOIN hr_employees e ON e.id = b.employee_id
     JOIN hr_leave_types lt ON lt.id = b.leave_type_id
     WHERE b.balance_year = ?${empFilter}
     ORDER BY e.full_name, lt.name`,
    args
  );
  return ok(res, { data: rows });
});

router.get("/balances/:employeeId", requireAuth, async (req: AuthRequest, res) => {
  const year = parseInt((req.query.year as string) || String(new Date().getFullYear()), 10);
  // Access control: self, own direct report, or HR/Admin/Executive.
  const actor = await leaveActor(req.user!);
  if (!actor.fullAccess) {
    const isSelf = actor.emp?.id === req.params.employeeId;
    const isReport = actor.emp
      ? !!(await pgGet("SELECT 1 AS x FROM hr_employees WHERE id=? AND manager_id=?", [req.params.employeeId, actor.emp.id]))
      : false;
    if (!isSelf && !isReport) {
      return errorResponse(res, 403, "FORBIDDEN", "Cannot view other employees' leave balances.");
    }
  }
  const rows = await pgAll(
    `SELECT b.*, lt.name AS leave_type_name, lt.entitlement_model, lt.carry_forward_allowed,
       (b.entitled_days + b.carried_forward - b.used_days - b.pending_days) AS remaining_days
     FROM hr_leave_balances b
     JOIN hr_leave_types lt ON lt.id = b.leave_type_id
     WHERE b.employee_id = ? AND b.balance_year = ?
     ORDER BY lt.name`,
    [req.params.employeeId, year]
  );
  return ok(res, { data: rows });
});

// POST /balances/initialise — allocate balances for an employee (called on onboarding or year-change)
router.post("/balances/initialise", requireAuth, requireRole(HR_LEAVE_ADMIN_ROLES), async (req: AuthRequest, res) => {
  const parsed = recalculateBalanceSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { employeeId, year: reqYear } = parsed.data;
  const year = reqYear || new Date().getFullYear();
  const emp = await pgGet("SELECT id, cadre_id, start_date FROM hr_employees WHERE id=?", [employeeId]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found.");
  const leaveTypes = await pgAll("SELECT id FROM hr_leave_types WHERE is_active=1");
  const results: any[] = [];
  for (const lt of leaveTypes) {
    const entitled = await computeEntitlement(employeeId, lt.id, year);
    if (entitled <= 0) continue;
    const bal = await ensureBalance(employeeId, lt.id, year);
    const now = new Date().toISOString();
    // Carry forward from prev year if allowed
    let carriedForward = 0;
    const lt_row = await pgGet("SELECT * FROM hr_leave_types WHERE id=?", [lt.id]);
    if (lt_row?.carry_forward_allowed) {
      const prev = await pgGet(
        "SELECT entitled_days, carried_forward, used_days FROM hr_leave_balances WHERE employee_id=? AND leave_type_id=? AND balance_year=?",
        [employeeId, lt.id, year - 1]
      );
      if (prev) {
        const leftOver = (prev.entitled_days + prev.carried_forward) - prev.used_days;
        carriedForward = lt_row.carry_forward_cap != null ? Math.min(leftOver, lt_row.carry_forward_cap) : leftOver;
        carriedForward = Math.max(0, Math.round(carriedForward * 10) / 10);
      }
    }
    if (lt_row?.entitlement_model === "accrual") {
      if (bal.created) {
        // Fresh balance row — nothing accrued yet; entitled_days/accrued_days
        // both start at 0 and the monthly accrual cron grows them from here.
        // (Do NOT grant the full computeEntitlement() value up front — that
        // would defeat the point of "accrual".)
        await pgRun(
          `UPDATE hr_leave_balances SET entitled_days=0, accrued_days=0, carried_forward=?, updated_at=? WHERE id=?`,
          [carriedForward, now, bal.id]
        );
      } else {
        // Existing row — re-running initialise (e.g. a cadre change mid-year)
        // must not wipe out days the cron has already banked; only carry-forward changes.
        await pgRun(
          `UPDATE hr_leave_balances SET carried_forward=?, updated_at=? WHERE id=?`,
          [carriedForward, now, bal.id]
        );
      }
    } else {
      await pgRun(
        `UPDATE hr_leave_balances SET entitled_days=?, carried_forward=?, accrued_days=?, updated_at=? WHERE id=?`,
        [entitled, carriedForward, entitled, now, bal.id]
      );
    }
    results.push({ leaveTypeId: lt.id, entitled, carriedForward });
  }
  auditLog(req, "HR_LEAVE_BALANCE_INIT", `hr_employee:${employeeId}`, "Info", { year, results }).catch(console.error);
  return ok(res, results, `Balances initialised for ${year}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE APPLICATIONS
// ─────────────────────────────────────────────────────────────────────────────
const APP_SELECT = `
  SELECT a.*,
    e.full_name AS employee_name, e.employee_no, e.manager_id, e.user_account_id AS employee_user_id,
    m.full_name AS manager_name, m.user_account_id AS manager_user_id,
    ou.name AS org_unit_name,
    lt.name AS leave_type_name, lt.gender_restricted, lt.max_days_per_year
  FROM hr_leave_applications a
  JOIN hr_employees e ON e.id = a.employee_id
  LEFT JOIN hr_employees m ON m.id = e.manager_id
  LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
  JOIN hr_leave_types lt ON lt.id = a.leave_type_id
`;

router.get("/applications", requireAuth, async (req: AuthRequest, res) => {
  const parsed = listApplicationsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());
  const q = parsed.data;
  const actor = await leaveActor(req.user!);
  const clauses: string[] = [];
  const args: any[] = [];
  const managerId = req.query.managerId as string | undefined;

  if (actor.fullAccess) {
    // HR/Admin/Executive: see all, optional filter by employee or manager
    if (q.employeeId) { clauses.push("a.employee_id=?"); args.push(q.employeeId); }
    if (managerId) { clauses.push("e.manager_id=?"); args.push(managerId); }
  } else if (q.employeeId && actor.emp && q.employeeId === actor.emp.id) {
    // Own applications (the self-service page asks for its own employeeId —
    // a manager must still see *their* history here, not their team's)
    clauses.push("a.employee_id=?"); args.push(actor.emp.id);
  } else if (managerId) {
    // Viewing a team by managerId — must be your own team
    if (!actor.emp || actor.emp.id !== managerId) {
      return errorResponse(res, 403, "FORBIDDEN", "Cannot view applications for this manager.");
    }
    clauses.push("e.manager_id=?"); args.push(managerId);
    if (q.employeeId) { clauses.push("a.employee_id=?"); args.push(q.employeeId); }
  } else if (actor.isManager) {
    // Manager with no explicit filter: their direct reports
    clauses.push("e.manager_id=?"); args.push(actor.emp!.id);
    if (q.employeeId) { clauses.push("a.employee_id=?"); args.push(q.employeeId); }
  } else {
    // All other employees: scope to own record
    if (!actor.emp) return ok(res, { applications: [], total: 0 });
    clauses.push("a.employee_id=?"); args.push(actor.emp.id);
  }
  if (q.status) { clauses.push("a.status=?"); args.push(q.status); }
  if (q.leaveTypeId) { clauses.push("a.leave_type_id=?"); args.push(q.leaveTypeId); }
  if (q.from) { clauses.push("a.start_date>=?"); args.push(q.from); }
  if (q.to) { clauses.push("a.end_date<=?"); args.push(q.to); }
  // start_date is stored as an ISO "YYYY-MM-DD" string, so its first 4 characters
  // are the year — avoids strftime(), which is SQLite-only and 500s on Postgres.
  if (q.year) { clauses.push("LEFT(a.start_date, 4)=?"); args.push(String(q.year)); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = (await pgGet(`SELECT COUNT(*) as c FROM hr_leave_applications a JOIN hr_employees e ON e.id=a.employee_id ${where}`, args))?.c ?? 0;
  const rows = await pgAll(
    `${APP_SELECT} ${where} ORDER BY a.applied_date DESC LIMIT ? OFFSET ?`,
    [...args, q.limit, q.offset]
  );
  return ok(res, { applications: rows, total });
});

router.get("/applications/:id", requireAuth, async (req: AuthRequest, res) => {
  const app = await pgGet(`${APP_SELECT} WHERE a.id=?`, [req.params.id]);
  if (!app) return errorResponse(res, 404, "NOT_FOUND", "Application not found.");
  // Own application, own direct report, or HR/Admin/Executive.
  const actor = await leaveActor(req.user!);
  if (!actor.fullAccess) {
    const own = !!actor.emp && actor.emp.id === app.employee_id;
    const report = !!actor.emp && app.manager_id === actor.emp.id;
    if (!own && !report) return errorResponse(res, 403, "FORBIDDEN", "Not your leave application.");
  }
  const logs = await pgAll(
    "SELECT * FROM hr_leave_approval_log WHERE application_id=? ORDER BY created_at",
    [req.params.id]
  );
  let segments = null;
  try { segments = app.segments ? JSON.parse(app.segments) : null; } catch { /* ignore */ }
  return ok(res, { ...app, segments, approvalLog: logs });
});

router.post("/applications", requireAuth, async (req: AuthRequest, res) => {
  const parsed = createLeaveApplicationSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const actor = await leaveActor(req.user!);
  // Resolve employee: everyone applies as themselves via their linked HR
  // record; only HR/Admin/Executive may file on someone else's behalf by
  // passing employeeId. (This used to key off a literal "Employee" role that
  // no account actually has, so every self-service submission 404'd.)
  const requestedEmpId = (req.body as any).employeeId as string | undefined;
  let emp: any = null;
  if (requestedEmpId && actor.fullAccess) {
    emp = await pgGet("SELECT * FROM hr_employees WHERE id=?", [requestedEmpId]);
  } else if (requestedEmpId && actor.emp && requestedEmpId !== actor.emp.id) {
    return errorResponse(res, 403, "FORBIDDEN", "You can only apply for leave on your own behalf.");
  } else if (actor.emp) {
    emp = await pgGet("SELECT * FROM hr_employees WHERE id=?", [actor.emp.id]);
  }
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "No HR employee record is linked to your account — ask HR to link it.");
  const lt = await pgGet("SELECT * FROM hr_leave_types WHERE id=? AND is_active=1", [d.leaveTypeId]);
  if (!lt) return errorResponse(res, 404, "NOT_FOUND", "Leave type not found or inactive.");
  if (lt.gender_restricted && emp.gender && lt.gender_restricted !== emp.gender) {
    return errorResponse(res, 403, "FORBIDDEN", `This leave type is restricted to ${lt.gender_restricted === "F" ? "female" : "male"} employees.`);
  }

  // Normalise to segments array
  type Seg = { startDate: string; endDate: string; halfDay?: "morning" | "afternoon"; days: number };
  const rawSegments: Seg[] = d.segments?.length
    ? d.segments.map(s => {
        const fullDays = countWorkingDays(s.startDate, s.endDate);
        const days = s.halfDay && s.startDate === s.endDate ? 0.5 : fullDays;
        return { startDate: s.startDate, endDate: s.endDate, halfDay: s.halfDay, days };
      })
    : [{ startDate: d.startDate!, endDate: d.endDate!, days: countWorkingDays(d.startDate!, d.endDate!) }];

  // Validate each segment has working days
  for (const seg of rawSegments) {
    if (seg.days <= 0) return errorResponse(res, 400, "INVALID_DATES", `No working days in range ${seg.startDate} → ${seg.endDate}.`);
  }
  // Validate no two segments in this application overlap each other
  for (let i = 0; i < rawSegments.length; i++) {
    for (let j = i + 1; j < rawSegments.length; j++) {
      if (rawSegments[i].startDate <= rawSegments[j].endDate && rawSegments[i].endDate >= rawSegments[j].startDate) {
        return errorResponse(res, 400, "OVERLAPPING_SEGMENTS", `Segments overlap: ${rawSegments[i].startDate} and ${rawSegments[j].startDate}.`);
      }
    }
  }

  const totalDays = rawSegments.reduce((sum, s) => sum + s.days, 0);
  const allDates = rawSegments.flatMap(s => [s.startDate, s.endDate]);
  const startDate = allDates.reduce((a, b) => a < b ? a : b);
  const endDate = allDates.reduce((a, b) => a > b ? a : b);
  const year = parseInt(startDate.split("-")[0], 10);

  // Check balance
  const bal = await pgGet(
    "SELECT * FROM hr_leave_balances WHERE employee_id=? AND leave_type_id=? AND balance_year=?",
    [emp.id, d.leaveTypeId, year]
  );
  const available = bal ? (bal.entitled_days + bal.carried_forward - bal.used_days - bal.pending_days) : 0;
  if (available < totalDays) {
    return errorResponse(res, 400, "INSUFFICIENT_BALANCE", `Insufficient leave balance. Available: ${available} days, Requested: ${totalDays} days.`);
  }

  // Check for overlapping existing applications per segment
  for (const seg of rawSegments) {
    const overlap = await pgGet(
      `SELECT id FROM hr_leave_applications
       WHERE employee_id=? AND status IN ('Pending','Approved')
       AND start_date<=? AND end_date>=?`,
      [emp.id, seg.endDate, seg.startDate]
    );
    if (overlap) return errorResponse(res, 409, "CONFLICT", `You already have a pending or approved leave that overlaps ${seg.startDate} → ${seg.endDate}.`);
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO hr_leave_applications
      (id, employee_id, leave_type_id, start_date, end_date, total_days, segments, reason, status,
       applied_date, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?)`,
    [id, emp.id, d.leaveTypeId, startDate, endDate, totalDays, JSON.stringify(rawSegments),
     d.reason ?? null, now.slice(0, 10), d.notes ?? null, now, now]
  );
  if (bal) {
    await pgRun(
      "UPDATE hr_leave_balances SET pending_days=pending_days+?, updated_at=? WHERE id=?",
      [totalDays, now, bal.id]
    );
  }
  auditLog(req, "HR_LEAVE_APPLIED", `hr_leave_app:${id}`, "Info", { employeeId: emp.id, leaveTypeId: d.leaveTypeId, totalDays, segments: rawSegments.length }).catch(console.error);
  // Notify the line manager — or HR/Admin when there is none (CEO/COO).
  const mgr = emp.manager_id
    ? await pgGet<any>("SELECT user_account_id FROM hr_employees WHERE id=?", [emp.manager_id])
    : null;
  const summary = `${emp.full_name} — ${lt.name}, ${startDate} → ${endDate} (${totalDays} day${totalDays === 1 ? "" : "s"})`;
  if (mgr?.user_account_id) {
    notify({ targetUserId: mgr.user_account_id, type: "action", title: "Leave request awaiting your approval", body: summary, link: "hr-manager-leave.html" });
  } else {
    notify({ targetRole: "HR",    type: "action", title: "Leave request awaiting approval (no line manager)", body: summary, link: "hr-leave-approvals.html" });
    notify({ targetRole: "Admin", type: "action", title: "Leave request awaiting approval (no line manager)", body: summary, link: "hr-leave-approvals.html" });
  }
  return created(res, { id, totalDays, segments: rawSegments, status: "Pending" }, "Leave application submitted");
});

router.patch("/applications/:id/cancel", requireAuth, async (req: AuthRequest, res) => {
  const app = await pgGet(`${APP_SELECT} WHERE a.id=?`, [req.params.id]);
  if (!app) return errorResponse(res, 404, "NOT_FOUND", "Application not found.");
  // Only the employee themselves or HR/Admin/Executive can cancel. (This used
  // to key off a literal "Employee" role no account has, so the ownership
  // check never ran and any signed-in user could cancel anyone's leave.)
  const actor = await leaveActor(req.user!);
  if (!actor.fullAccess && (!actor.emp || actor.emp.id !== app.employee_id)) {
    return errorResponse(res, 403, "FORBIDDEN", "Not your leave application.");
  }
  if (!["Pending", "PendingL2", "Approved"].includes(app.status)) {
    return errorResponse(res, 400, "INVALID_STATUS", `Cannot cancel a ${app.status} application.`);
  }
  const now = new Date().toISOString();
  await pgRun("UPDATE hr_leave_applications SET status='Cancelled', updated_at=? WHERE id=?", [now, req.params.id]);
  // Release pending days
  const year = parseInt(app.start_date.split("-")[0], 10);
  const bal = await pgGet(
    "SELECT id, pending_days, used_days FROM hr_leave_balances WHERE employee_id=? AND leave_type_id=? AND balance_year=?",
    [app.employee_id, app.leave_type_id, year]
  );
  if (bal) {
    if (app.status === "Pending" || app.status === "PendingL2") {
      await pgRun("UPDATE hr_leave_balances SET pending_days=GREATEST(0,pending_days-?), updated_at=? WHERE id=?",
        [app.total_days, now, bal.id]);
    } else {
      // was approved — decrement used days
      await pgRun("UPDATE hr_leave_balances SET used_days=GREATEST(0,used_days-?), updated_at=? WHERE id=?",
        [app.total_days, now, bal.id]);
    }
  }
  auditLog(req, "HR_LEAVE_CANCELLED", `hr_leave_app:${req.params.id}`, "Info", {}).catch(console.error);
  // A withdrawn request that was sitting in someone's queue should leave it.
  if (app.manager_user_id && (app.status === "Pending" || app.status === "PendingL2")) {
    notify({ targetUserId: app.manager_user_id, type: "info", title: "Leave request withdrawn",
      body: `${app.employee_name} — ${app.leave_type_name}, ${app.start_date} → ${app.end_date}`, link: "hr-manager-leave.html" });
  }
  return ok(res, null, "Leave application cancelled");
});

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL WORKFLOW
// ─────────────────────────────────────────────────────────────────────────────
router.post("/applications/:id/approve", requireAuth, async (req: AuthRequest, res) => {
  const app = await pgGet(`${APP_SELECT} WHERE a.id=?`, [req.params.id]);
  if (!app) return errorResponse(res, 404, "NOT_FOUND", "Application not found.");
  // Two-level workflow: 'Pending' = awaiting manager (L1); 'PendingL2' = manager
  // approved, awaiting HR/Admin countersign (L2). Any other status is terminal.
  if (app.status !== "Pending" && app.status !== "PendingL2") {
    return errorResponse(res, 400, "INVALID_STATUS", `Application is already ${app.status}.`);
  }
  const parsed = approveLeaveSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { action, notes, rejectionReason } = parsed.data;
  const user = req.user!;
  const actor = await leaveActor(user);
  const role = actor.role;
  const actorEmp = actor.emp;
  // Approval rights come from the org chart (see leaveActor), not the role.
  if (!actor.fullAccess && !actor.isManager) {
    return errorResponse(res, 403, "FORBIDDEN", "Only line managers or HR can act on leave applications.");
  }
  // Prevent self-approval
  if (actorEmp && actorEmp.id === app.employee_id) {
    return errorResponse(res, 403, "FORBIDDEN", "Cannot approve your own leave application.");
  }
  const level = app.status === "Pending" ? 1 : 2;
  if (level === 1) {
    // A line manager can only approve their own direct reports;
    // HR/Admin/Executive bypass ownership (covers employees with no manager).
    if (!actor.fullAccess) {
      if (!actorEmp || app.manager_id !== actorEmp.id) {
        return errorResponse(res, 403, "FORBIDDEN", "You can only approve leave for your direct reports.");
      }
    }
  } else {
    // L2 is a dedicated HR/Admin countersign step — line managers cannot act here.
    if (!HR_LEAVE_ADMIN_ROLES.includes(role)) {
      return errorResponse(res, 403, "FORBIDDEN", "This application is awaiting HR countersign.");
    }
  }
  const now = new Date().toISOString();
  const year = parseInt(app.start_date.split("-")[0], 10);
  let newStatus: string;
  if (level === 1) {
    await pgRun(
      `UPDATE hr_leave_applications SET level1_approver_id=?, level1_action=?, level1_date=?,
       rejection_reason=COALESCE(?,rejection_reason), notes=COALESCE(?,notes), updated_at=? WHERE id=?`,
      [user.id, action, now, rejectionReason ?? null, notes ?? null, now, req.params.id]
    );
    // Rejected at L1 finalises immediately; approved moves to the L2 HR
    // countersign step — the leave isn't granted (balance untouched) yet.
    newStatus = action === "Rejected" ? "Rejected" : "PendingL2";
  } else {
    await pgRun(
      `UPDATE hr_leave_applications SET level2_approver_id=?, level2_action=?, level2_date=?,
       rejection_reason=COALESCE(?,rejection_reason), notes=COALESCE(?,notes), updated_at=? WHERE id=?`,
      [user.id, action, now, rejectionReason ?? null, notes ?? null, now, req.params.id]
    );
    newStatus = action;
  }
  // Finalise status
  await pgRun("UPDATE hr_leave_applications SET status=?, updated_at=? WHERE id=?", [newStatus, now, req.params.id]);
  // Update balance
  const bal = await pgGet(
    "SELECT id FROM hr_leave_balances WHERE employee_id=? AND leave_type_id=? AND balance_year=?",
    [app.employee_id, app.leave_type_id, year]
  );
  if (bal) {
    if (newStatus === "Approved") {
      await pgRun(
        "UPDATE hr_leave_balances SET pending_days=GREATEST(0,pending_days-?), used_days=used_days+?, updated_at=? WHERE id=?",
        [app.total_days, app.total_days, now, bal.id]
      );
    } else if (newStatus === "Rejected") {
      await pgRun(
        "UPDATE hr_leave_balances SET pending_days=GREATEST(0,pending_days-?), updated_at=? WHERE id=?",
        [app.total_days, now, bal.id]
      );
    }
  }
  // Log
  await pgRun(
    `INSERT INTO hr_leave_approval_log (id, application_id, action, by_user_id, actor_name, approval_level, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), req.params.id, action, user.id, user.email, level, notes ?? null, now]
  );
  auditLog(req, `HR_LEAVE_${action.toUpperCase()}`, `hr_leave_app:${req.params.id}`, "Info", { level, action }).catch(console.error);
  // Notifications: the employee always hears the outcome; HR/Admin hear when
  // an L1 approval lands in their countersign queue.
  const summary = `${app.employee_name} — ${app.leave_type_name}, ${app.start_date} → ${app.end_date} (${app.total_days} days)`;
  if (newStatus === "PendingL2") {
    if (app.employee_user_id) {
      notify({ targetUserId: app.employee_user_id, type: "info", title: "Leave approved by your manager — awaiting HR countersign", body: summary, link: "hr-leave-apply.html" });
    }
    notify({ targetRole: "HR",    type: "action", title: "Leave awaiting HR countersign", body: summary, link: "hr-leave-approvals.html" });
    notify({ targetRole: "Admin", type: "action", title: "Leave awaiting HR countersign", body: summary, link: "hr-leave-approvals.html" });
  } else if (app.employee_user_id) {
    notify({
      targetUserId: app.employee_user_id,
      type: newStatus === "Approved" ? "success" : "info",
      title: newStatus === "Approved" ? "Leave approved" : "Leave rejected",
      body: summary + (rejectionReason ? ` — ${rejectionReason}` : ""),
      link: "hr-leave-apply.html",
    });
  }
  return ok(res, { status: newStatus }, `Leave application ${action.toLowerCase()}`);
});

// Admin / HR override
router.post("/applications/:id/override", requireAuth, requireRole(HR_LEAVE_ADMIN_ROLES), async (req: AuthRequest, res) => {
  const app = await pgGet("SELECT * FROM hr_leave_applications WHERE id=?", [req.params.id]);
  if (!app) return errorResponse(res, 404, "NOT_FOUND", "Application not found.");
  const parsed = hrOverrideLeaveSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { action, notes } = parsed.data;
  const user = req.user!;
  // Mirror the same guard the normal approve path already has — override can
  // force any status at any time, so without this an Admin could approve their
  // own leave simply by using override instead of the regular approve action.
  const actorEmp = await pgGet("SELECT id FROM hr_employees WHERE user_account_id=?", [user.id]);
  if (actorEmp && actorEmp.id === app.employee_id) {
    return errorResponse(res, 403, "FORBIDDEN", "Cannot override your own leave application.");
  }
  const now = new Date().toISOString();
  const previousStatus = app.status;
  await pgRun(
    `UPDATE hr_leave_applications SET status=?, hr_override_by=?, hr_override_date=?, notes=COALESCE(?,notes), updated_at=? WHERE id=?`,
    [action, user.id, now, notes ?? null, now, req.params.id]
  );
  // Recalculate balance delta
  const year = parseInt(app.start_date.split("-")[0], 10);
  const bal = await pgGet(
    "SELECT id, pending_days, used_days FROM hr_leave_balances WHERE employee_id=? AND leave_type_id=? AND balance_year=?",
    [app.employee_id, app.leave_type_id, year]
  );
  if (bal) {
    const wasPending = previousStatus === "Pending" || previousStatus === "PendingL2";
    if (wasPending && action === "Approved") {
      await pgRun("UPDATE hr_leave_balances SET pending_days=GREATEST(0,pending_days-?), used_days=used_days+?, updated_at=? WHERE id=?",
        [app.total_days, app.total_days, now, bal.id]);
    } else if (wasPending && action === "Rejected") {
      await pgRun("UPDATE hr_leave_balances SET pending_days=GREATEST(0,pending_days-?), updated_at=? WHERE id=?",
        [app.total_days, now, bal.id]);
    } else if (previousStatus === "Approved" && action === "Cancelled") {
      await pgRun("UPDATE hr_leave_balances SET used_days=GREATEST(0,used_days-?), updated_at=? WHERE id=?",
        [app.total_days, now, bal.id]);
    }
  }
  await pgRun(
    `INSERT INTO hr_leave_approval_log (id, application_id, action, by_user_id, actor_name, approval_level, notes, created_at)
     VALUES (?, ?, ?, ?, ?, 99, ?, ?)`,
    [uuidv4(), req.params.id, `HR_OVERRIDE:${action}`, user.id, user.email, notes ?? null, now]
  );
  auditLog(req, "HR_LEAVE_OVERRIDE", `hr_leave_app:${req.params.id}`, "Warning", { action, previousStatus }).catch(console.error);
  const empRow = await pgGet<any>("SELECT user_account_id, full_name FROM hr_employees WHERE id=?", [app.employee_id]);
  if (empRow?.user_account_id) {
    notify({ targetUserId: empRow.user_account_id, type: action === "Approved" ? "success" : "info",
      title: `Leave ${action.toLowerCase()} by HR`,
      body: `${empRow.full_name} — ${app.start_date} → ${app.end_date} (${app.total_days} days)`, link: "hr-leave-apply.html" });
  }
  return ok(res, { status: action }, "HR override applied");
});

// ─────────────────────────────────────────────────────────────────────────────
// MY TEAM (manager helper — returns direct reports for any authenticated user)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/my-team", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user;
  const role = canonicalRole(user?.role);
  const emp = await pgGet(
    "SELECT id, full_name, employee_no FROM hr_employees WHERE user_account_id=?",
    [user!.id]
  );
  // Only Admin/Executive get an unrestricted org-wide roster. BDM and
  // BDMCorporate used to get one too (role-based: "any BDM sees every retail
  // Sales-team employee, any BDMCorporate sees every CorporateSales
  // employee") — that broke once retail split into multiple regional BDMs
  // (e.g. Janet Muthui / Nancy Ngethe each managing their own reps): every
  // BDM saw every other BDM's team too. Both now fall through to the same
  // hr_employees.manager_id-based lookup every other manager already uses
  // below, so "my team" always means this specific manager's real HR direct
  // reports — verified this doesn't change BDMCorporate's own result today
  // (its 3 reps already have manager_id pointing at the one real BDMCorporate).
  if (HR_LEAVE_FULL_ACCESS.includes(role)) {
    const teamReports = await pgAll(
      `SELECT e.id, e.full_name, e.employee_no, jr.title AS job_title
       FROM hr_employees e
       LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
       WHERE e.status='Active' ORDER BY e.full_name`,
      []
    );
    return ok(res, {
      isManager: true,
      employeeId: emp?.id || null,
      directReports: teamReports,
      canApprove: true,
    });
  }
  if (!emp) return ok(res, { isManager: false, employeeId: null, directReports: [], canApprove: false });
  const reports = await pgAll(
    `SELECT e.id, e.full_name, e.employee_no, e.user_account_id, u.email, jr.title AS job_title
     FROM hr_employees e
     LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
     LEFT JOIN users u ON u.id = e.user_account_id
     WHERE e.manager_id=? AND e.status='Active' ORDER BY e.full_name`,
    [emp.id]
  );
  return ok(res, {
    isManager: reports.length > 0,
    employeeId: emp.id,
    directReports: reports,
    // Approval right = has direct reports (see leaveActor), not a role list.
    canApprove: reports.length > 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────────────────────────────────────
router.get("/calendar", requireAuth, async (req: AuthRequest, res) => {
  const { from, to, orgUnitId, managerId } = req.query as Record<string, string>;
  const now = new Date();
  const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const start = from || startOfMonth;
  const end = to || endOfMonth;
  const clauses = ["a.status='Approved'", "a.start_date<=?", "a.end_date>=?"];
  const args: any[] = [end, start];
  if (orgUnitId) { clauses.push("e.org_unit_id=?"); args.push(orgUnitId); }
  if (managerId) {
    // Verify the managerId belongs to the current user (or user is admin/management)
      if (!HR_LEAVE_FULL_ACCESS.includes(canonicalRole(req.user?.role))) {
      const emp = await pgGet("SELECT id FROM hr_employees WHERE user_account_id=?", [req.user!.id]);
      if (!emp || emp.id !== managerId) {
        return errorResponse(res, 403, "FORBIDDEN", "Cannot view calendar for this manager.");
      }
    }
    clauses.push("e.manager_id=?"); args.push(managerId);
  }
  const rows = await pgAll(
    `SELECT a.id, a.start_date, a.end_date, a.total_days,
       e.id AS employee_id, e.full_name, e.employee_no,
       lt.name AS leave_type_name, ou.name AS org_unit_name
     FROM hr_leave_applications a
     JOIN hr_employees e ON e.id = a.employee_id
     JOIN hr_leave_types lt ON lt.id = a.leave_type_id
     LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY a.start_date`,
    args
  );
  return ok(res, { data: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────────────────────────────────
router.get("/reports/balances", requireAuth, requireRole([...ROLE_GROUPS.MANAGEMENT, ROLES.HR]), async (req: AuthRequest, res) => {
  const year = parseInt((req.query.year as string) || String(new Date().getFullYear()), 10);
  const rows = await pgAll(
    `SELECT b.*, e.full_name, e.employee_no, lt.name AS leave_type_name,
       (b.entitled_days + b.carried_forward - b.used_days - b.pending_days) AS remaining_days
     FROM hr_leave_balances b
     JOIN hr_employees e ON e.id = b.employee_id
     JOIN hr_leave_types lt ON lt.id = b.leave_type_id
     WHERE b.balance_year=?
     ORDER BY e.full_name, lt.name`,
    [year]
  );
  return ok(res, { data: rows });
});

router.get("/reports/utilization", requireAuth, requireRole([...ROLE_GROUPS.MANAGEMENT, ROLES.HR]), async (req: AuthRequest, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  const rows = await pgAll(
    `SELECT ou.name AS org_unit_name, lt.name AS leave_type_name,
       COUNT(DISTINCT e.id) AS employee_count,
       SUM(b.used_days) AS total_used, SUM(b.entitled_days) AS total_entitled,
       ROUND(CAST(SUM(b.used_days) AS NUMERIC) / NULLIF(CAST(SUM(b.entitled_days) AS NUMERIC),0) * 100, 1) AS utilization_pct
     FROM hr_leave_balances b
     JOIN hr_employees e ON e.id = b.employee_id
     JOIN hr_org_units ou ON ou.id = e.org_unit_id
     JOIN hr_leave_types lt ON lt.id = b.leave_type_id
     WHERE b.balance_year=?
     GROUP BY ou.id, ou.name, lt.id, lt.name
     ORDER BY ou.name, lt.name`,
    [year]
  );
  return ok(res, { data: rows });
});

router.get("/reports/excess-balances", requireAuth, requireRole([...ROLE_GROUPS.MANAGEMENT, ROLES.HR]), async (req: AuthRequest, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  const threshold = parseFloat((req.query.threshold as string) || "10");
  const rows = await pgAll(
    `SELECT e.full_name, e.employee_no, lt.name AS leave_type,
       b.entitled_days, b.used_days, b.carried_forward,
       (b.entitled_days + b.carried_forward - b.used_days - b.pending_days) AS remaining_days
     FROM hr_leave_balances b
     JOIN hr_employees e ON e.id = b.employee_id
     JOIN hr_leave_types lt ON lt.id = b.leave_type_id
     WHERE b.balance_year=?
       AND (b.entitled_days + b.carried_forward - b.used_days - b.pending_days) >= ?
     ORDER BY remaining_days DESC`,
    [year, threshold]
  );
  return ok(res, { data: rows });
});

router.get("/reports/pending-approvals", requireAuth, async (req: AuthRequest, res) => {
  const actor = await leaveActor(req.user!);
  if (!actor.fullAccess && !actor.isManager) {
    return errorResponse(res, 403, "FORBIDDEN", "Only line managers or HR can view the approval queue.");
  }
  // Managers act at L1 only — their queue is their own reports' 'Pending'
  // items. HR/Admin/Executive see the full queue including 'PendingL2'
  // (awaiting their own countersign).
  const clause = actor.fullAccess ? "a.status IN ('Pending','PendingL2')" : "a.status='Pending' AND e.manager_id=?";
  const args: any[] = actor.fullAccess ? [] : [actor.emp!.id];
  const rows = await pgAll(
    `${APP_SELECT} WHERE ${clause} ORDER BY a.applied_date ASC`,
    args
  );
  return ok(res, { data: rows });
});

export default router;
