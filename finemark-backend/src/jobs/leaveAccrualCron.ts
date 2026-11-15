import cron from "node-cron";
import { pgAll, pgRun } from "../db.js";
import { ensureBalance, resolveEntitlement } from "../services/hrLeaveBalanceService.js";

async function runMonthlyAccrual() {
  const today = new Date();
  const year = today.getFullYear();
  const currentMonth = `${year}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const todayIso = today.toISOString().slice(0, 10);

  const employees = await pgAll<any>(
    "SELECT id FROM hr_employees WHERE status='Active' AND start_date<=?",
    [todayIso]
  );
  const accrualTypes = await pgAll<any>(
    "SELECT id FROM hr_leave_types WHERE is_active=1 AND entitlement_model='accrual'"
  );

  let accrued = 0;
  let skippedAlready = 0;
  let skippedNoEntitlement = 0;

  for (const emp of employees) {
    for (const lt of accrualTypes) {
      const ent = await resolveEntitlement(emp.id, lt.id);
      if (!ent || !ent.accrual_rate) { skippedNoEntitlement++; continue; }

      const bal = await ensureBalance(emp.id, lt.id, year);
      if (bal.last_accrual_month === currentMonth) { skippedAlready++; continue; }

      const cap = ent.days_per_year != null ? Number(ent.days_per_year) : Infinity;
      const newAccrued = Math.min(Number(bal.accrued_days) + Number(ent.accrual_rate), cap);
      await pgRun(
        `UPDATE hr_leave_balances SET accrued_days=?, entitled_days=?, last_accrual_month=?, updated_at=? WHERE id=?`,
        [newAccrued, newAccrued, currentMonth, new Date().toISOString(), bal.id]
      );
      accrued++;
    }
  }

  console.log(`[Leave Accrual Cron] ${currentMonth}: ${accrued} balance(s) accrued, ${skippedAlready} already done this month, ${skippedNoEntitlement} skipped (no entitlement/accrual_rate)`);
}

export const initLeaveAccrualCron = () => {
  const enabled = process.env.LEAVE_ACCRUAL_CRON_ENABLED === "true";
  if (!enabled) {
    console.log("[Leave Accrual Cron] Disabled via LEAVE_ACCRUAL_CRON_ENABLED=false");
    return;
  }

  // 01:00 on the 1st of every month, Africa/Nairobi.
  const schedule = process.env.LEAVE_ACCRUAL_CRON_SCHEDULE || "0 1 1 * *";

  cron.schedule(schedule, async () => {
    try {
      console.log("[Leave Accrual Cron] Running monthly leave accrual...");
      await runMonthlyAccrual();
    } catch (err) {
      console.error("[Leave Accrual Cron] Error:", err);
    }
  }, { timezone: "Africa/Nairobi" });

  console.log(`[Leave Accrual Cron] Initialized (schedule: ${schedule}, Africa/Nairobi)`);
};

// Exposed for verification/testing — runs the accrual pass immediately,
// bypassing the cron schedule.
export const runLeaveAccrualNow = runMonthlyAccrual;
