import cron from "node-cron";
import { getLeadsWithWarnings, sendLeadWarningNotification } from "../services/crmLeadWarningService.js";

const WARNING_MESSAGES: Record<string, { title: string; message: (lead: { lead_no: string; customer_name: string | null }) => string }> = {
  nearing_close_no_activity: {
    title: "Lead nearing close date — no recent activity",
    message: (l) => `Lead ${l.lead_no}${l.customer_name ? ` (${l.customer_name})` : ""} is nearing its expected close date but has had no logged conversation or follow-up in the last 7 days.`,
  },
  new_no_followup: {
    title: "New lead — no follow-up logged",
    message: (l) => `Lead ${l.lead_no}${l.customer_name ? ` (${l.customer_name})` : ""} has been New for over 48 hours with no conversation or follow-up logged yet.`,
  },
};

export const initLeadWarningCron = () => {
  const enabled = process.env.LEAD_WARNING_CRON_ENABLED === "true";
  if (!enabled) {
    console.log("[Lead Warning Cron] Disabled via LEAD_WARNING_CRON_ENABLED=false");
    return;
  }

  // Daily at 08:00 Africa/Nairobi
  const schedule = "0 8 * * *";

  cron.schedule(schedule, async () => {
    try {
      console.log("[Lead Warning Cron] Running lead warning check...");
      await runLeadWarningCheck();
    } catch (err) {
      console.error("[Lead Warning Cron] Error:", err);
    }
  }, { timezone: "Africa/Nairobi" });

  console.log("[Lead Warning Cron] Initialized (daily at 08:00 Africa/Nairobi)");
};

export async function runLeadWarningCheck() {
  const leads = await getLeadsWithWarnings();
  let totalSent = 0;

  for (const lead of leads) {
    const types: string[] = [];
    if (lead.warn_nearing_close_no_activity) types.push("nearing_close_no_activity");
    if (lead.warn_new_no_followup) types.push("new_no_followup");

    for (const warningType of types) {
      const def = WARNING_MESSAGES[warningType];
      try {
        const sent = await sendLeadWarningNotification(lead, warningType, def.title, def.message(lead));
        totalSent += sent;
        if (sent) console.log(`[Lead Warning Cron] Sent ${warningType} for ${lead.lead_no} (${sent} recipient(s))`);
      } catch (err) {
        console.error(`[Lead Warning Cron] Error sending ${warningType} for ${lead.lead_no}:`, err);
      }
    }
  }

  console.log(`[Lead Warning Cron] Completed. ${leads.length} lead(s) flagged, ${totalSent} notification(s) sent.`);
}
