import cron from "node-cron";
import { v4 as uuidv4 } from "uuid";
import { pgAll, pgRun } from "../db.js";
import { createNotification } from "../routes/notifications.js";

export const initGpsUninstallScanCron = () => {
  const enabled = process.env.GPS_UNINSTALL_SCAN_CRON_ENABLED === "true";
  if (!enabled) {
    console.log("[GPS Uninstall Scan Cron] Disabled via GPS_UNINSTALL_SCAN_CRON_ENABLED=false");
    return;
  }

  // Daily at 08:15 Africa/Nairobi — offset 15 min from the other 08:00 jobs
  // (reminderCron, leadWarningCron, leadFollowupReminderCron) so they don't
  // all hit the DB at the same instant.
  const schedule = "15 8 * * *";

  cron.schedule(schedule, async () => {
    try {
      console.log("[GPS Uninstall Scan Cron] Running loan-term-end scan...");
      await runGpsUninstallScan();
    } catch (err) {
      console.error("[GPS Uninstall Scan Cron] Error:", err);
    }
  }, { timezone: "Africa/Nairobi" });

  console.log("[GPS Uninstall Scan Cron] Initialized (daily at 08:15 Africa/Nairobi)");
};

// Exported so it can be invoked directly for verification/testing without
// waiting for the schedule or restarting the process.
export async function runGpsUninstallScan() {
  // Candidate set: vehicles with a completed installation whose device is
  // still Installed (the exact join chain crm-tickets.ts's
  // GET /lookup/vehicle/:vehicleId already uses to resolve "what's on this
  // vehicle right now" — this JOIN also self-excludes already-uninstalled
  // vehicles, since a completed uninstallation flips the device to
  // 'Returned'), that have loan data recorded, and that don't already have
  // an active (non-terminal) queue row.
  const candidates = await pgAll(
    `SELECT DISTINCT v.id AS vehicle_id, v.registration, v.customer_id, v.partner_id,
            v.loan_start_date, v.loan_tenure_months,
            COALESCE(ind.full_name, corp.company_name) AS customer_name
     FROM crm_customer_vehicles v
     JOIN installation_tickets it ON it.vehicle_id = v.id AND it.status = 'Completed' AND it.deleted_at IS NULL
     JOIN inv_items i ON i.installation_id = it.id AND i.status = 'Installed' AND i.deleted_at IS NULL
     LEFT JOIN crm_individual_profiles ind ON ind.customer_id = v.customer_id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = v.customer_id
     WHERE v.deleted_at IS NULL
       AND v.loan_start_date IS NOT NULL
       AND v.loan_tenure_months IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM gps_uninstall_queue q
         WHERE q.vehicle_id = v.id AND q.status IN ('Scheduled','TicketRaised')
       )`,
    []
  ).catch((e) => { console.error("[GPS Uninstall Scan Cron] candidate query failed:", e); return []; });

  const today = new Date();
  let queued = 0;

  for (const v of candidates as any[]) {
    // Exact same loan-end-date math already used (but never persisted) in
    // partner-portal.ts and partners.ts — reused verbatim so this queue's
    // eligible_date always agrees with what those dashboards already show.
    const expiry = new Date(v.loan_start_date);
    expiry.setMonth(expiry.getMonth() + v.loan_tenure_months);
    if (expiry > today) continue; // term hasn't ended yet

    const now = new Date().toISOString();
    const eligibleDate = expiry.toISOString().slice(0, 10);
    try {
      await pgRun(
        `INSERT INTO gps_uninstall_queue
           (id, vehicle_id, vehicle_registration, customer_id, customer_name, partner_id,
            trigger_type, eligible_date, status, reason, flagged_by_user_id, flagged_by_email,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'LoanTermEnd', ?, 'Scheduled', ?, NULL, 'system:gps-uninstall-scan-cron', ?, ?)
         ON CONFLICT (vehicle_id) WHERE status IN ('Scheduled','TicketRaised') DO NOTHING`,
        [uuidv4(), v.vehicle_id, v.registration, v.customer_id, v.customer_name, v.partner_id,
         eligibleDate, `Loan term ended naturally — ${v.loan_tenure_months}-month term starting ${String(v.loan_start_date).slice(0, 10)} expired ${eligibleDate} (system-detected).`,
         now, now]
      );
      queued++;
    } catch (err) {
      console.error(`[GPS Uninstall Scan Cron] Failed to queue vehicle ${v.vehicle_id}:`, err);
    }
  }

  if (queued > 0) {
    await createNotification({
      targetRole: "Technical",
      type: "info",
      title: "GPS uninstallation queue updated",
      body: `${queued} vehicle(s) newly eligible for GPS tracker uninstallation (loan term ended).`,
      link: "gps-uninstall-queue.html",
    }).catch(console.error);
    await createNotification({
      targetRole: "Finance",
      type: "info",
      title: "GPS uninstallation queue updated",
      body: `${queued} vehicle(s) newly eligible for GPS tracker uninstallation (loan term ended).`,
      link: "gps-uninstall-queue.html",
    }).catch(console.error);
  }

  console.log(`[GPS Uninstall Scan Cron] Completed. ${candidates.length} candidate(s) checked, ${queued} newly queued.`);
}
