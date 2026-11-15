import { v4 as uuidv4 } from "uuid";
import { pgGet, pgRun } from "../db.js";

// Shared by src/routes/hr-leave.ts and src/jobs/leaveAccrualCron.ts.

export async function ensureBalance(
  employeeId: string,
  leaveTypeId: string,
  year: number
): Promise<{ id: string; created: boolean; [key: string]: any }> {
  let bal = await pgGet<any>(
    "SELECT * FROM hr_leave_balances WHERE employee_id=? AND leave_type_id=? AND balance_year=?",
    [employeeId, leaveTypeId, year]
  );
  if (bal) return { ...bal, created: false };
  const id = uuidv4();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO hr_leave_balances (id, employee_id, leave_type_id, balance_year,
      entitled_days, accrued_days, used_days, pending_days, carried_forward, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`,
    [id, employeeId, leaveTypeId, year, now, now]
  );
  bal = await pgGet<any>("SELECT * FROM hr_leave_balances WHERE id=?", [id]);
  return { ...bal, created: true };
}

// Helper: compute entitled days for employee based on cadre and leave type.
// `year` is the balance year being computed for — NOT necessarily the current
// calendar year (balances can be initialised for a past or future year), so
// pro-ration must compare the hire date against that year, not "today".
export async function computeEntitlement(employeeId: string, leaveTypeId: string, year: number): Promise<number> {
  const emp = await pgGet<any>("SELECT start_date, cadre_id FROM hr_employees WHERE id=?", [employeeId]);
  if (!emp) return 0;
  // Entitlement: cadre-specific first, then fallback to any-cadre (cadre_id IS NULL)
  let ent: any = null;
  if (emp.cadre_id) {
    ent = await pgGet<any>(
      "SELECT * FROM hr_leave_entitlements WHERE leave_type_id=? AND cadre_id=?",
      [leaveTypeId, emp.cadre_id]
    );
  }
  if (!ent) {
    ent = await pgGet<any>(
      "SELECT * FROM hr_leave_entitlements WHERE leave_type_id=? AND cadre_id IS NULL",
      [leaveTypeId]
    );
  }
  if (!ent) return 0;
  // Pro-rate for a hire mid-way through the year being computed; zero for a
  // year that predates the hire date entirely (they weren't employed yet).
  const startDate = new Date(emp.start_date);
  const startYear = startDate.getFullYear();
  if (startYear > year) return 0;
  if (startYear === year) {
    // months remaining including start month
    const monthsRemaining = 12 - startDate.getMonth();
    return Math.round((ent.days_per_year / 12) * monthsRemaining * 10) / 10;
  }
  return ent.days_per_year;
}

// Resolve the entitlement row for an employee+leave-type (cadre-specific,
// else any-cadre fallback) — used by the accrual cron to read accrual_rate
// and days_per_year without recomputing the full pro-rated entitlement.
export async function resolveEntitlement(employeeId: string, leaveTypeId: string): Promise<any | null> {
  const emp = await pgGet<any>("SELECT cadre_id FROM hr_employees WHERE id=?", [employeeId]);
  if (!emp) return null;
  let ent: any = null;
  if (emp.cadre_id) {
    ent = await pgGet<any>(
      "SELECT * FROM hr_leave_entitlements WHERE leave_type_id=? AND cadre_id=?",
      [leaveTypeId, emp.cadre_id]
    );
  }
  if (!ent) {
    ent = await pgGet<any>(
      "SELECT * FROM hr_leave_entitlements WHERE leave_type_id=? AND cadre_id IS NULL",
      [leaveTypeId]
    );
  }
  return ent ?? null;
}
