import cron from "node-cron";
import { pgGet, pgAll, pgRun } from "../db.js";
import { sendReminderForInvoice, checkRecentReminder } from "../services/reminderService.js";
import { auditLog } from "../services/auditService.js";

const isoToDate = (iso: string) => new Date(iso).toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi" });
const getTodayIntz = (tz: string = "Africa/Nairobi") => new Date().toLocaleDateString("en-KE", { timeZone: tz });

interface ReminderRule {
  stage: string;
  checkFn: (invoice: any) => boolean;
  channels: ("email" | "sms")[];
  segmentKey: string;
}

export const initReminderCron = () => {
  const enabled = process.env.INVOICE_REMINDER_CRON_ENABLED === "true";
  if (!enabled) {
    console.log("[Reminder Cron] Disabled via INVOICE_REMINDER_CRON_ENABLED=false");
    return;
  }

  // Daily at 08:00 Africa/Nairobi
  const schedule = "0 8 * * *";

  cron.schedule(schedule, async () => {
    try {
      console.log("[Reminder Cron] Running invoice reminder check...");
      await runReminderCheck();
    } catch (err) {
      console.error("[Reminder Cron] Error:", err);
    }
  }, { timezone: "Africa/Nairobi" });

  console.log("[Reminder Cron] Initialized (daily at 08:00 Africa/Nairobi)");
};

async function runReminderCheck() {
  const today = getTodayIntz("Africa/Nairobi");
  const today7d = new Date(Date.now() + 7 * 86400000).toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi" });
  const now = new Date();

  // Fetch unpaid/partial invoices
  const invoices = await pgAll(
    `SELECT id, invoice_number, customer, status, due_on, issued_on, amount, total, created_at FROM invoices
     WHERE status IN ('Unpaid', 'PartiallyPaid', 'Overdue', 'Pending')
     AND deleted_at IS NULL
     ORDER BY due_on ASC`,
    []
  ).catch(() => []);

  const reminderRules: ReminderRule[] = [
    {
      stage: "pre7d",
      checkFn: (inv) => {
        const dueDate = isoToDate(inv.due_on);
        return dueDate === today7d; // Due in 7 days
      },
      channels: ["email"],
      segmentKey: "pre7d",
    },
    {
      stage: "ondue",
      checkFn: (inv) => isoToDate(inv.due_on) === today,
      channels: ["email", "sms"],
      segmentKey: "ondue",
    },
    {
      stage: "overdue3d",
      checkFn: (inv) => {
        const daysOverdue = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000);
        return daysOverdue === 3;
      },
      channels: ["email", "sms"],
      segmentKey: "overdue3d",
    },
    {
      stage: "overdue7d",
      checkFn: (inv) => {
        const daysOverdue = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000);
        return daysOverdue === 7;
      },
      channels: ["email", "sms"],
      segmentKey: "overdue7d",
    },
    {
      stage: "overdue14d",
      checkFn: (inv) => {
        const daysOverdue = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000);
        return daysOverdue === 14;
      },
      channels: ["email", "sms"],
      segmentKey: "overdue14d",
    },
    {
      stage: "overdue30d",
      checkFn: (inv) => {
        const daysOverdue = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000);
        return daysOverdue === 30;
      },
      channels: ["email", "sms"],
      segmentKey: "overdue30d",
    },
  ];

  let totalSent = 0;
  const smsCap = parseInt(process.env.SMS_DAILY_CAP || "200", 10);
  let smsSent = 0;

  for (const rule of reminderRules) {
    const matching = invoices.filter(rule.checkFn);

    for (const invoice of matching) {
      // Check for recent reminder to avoid spam
      const hasRecent = await checkRecentReminder(invoice.id, rule.segmentKey, 24);
      if (hasRecent) {
        console.log(`[Reminder Cron] Skipping ${invoice.invoice_number} (${rule.segmentKey}) — sent recently`);
        continue;
      }

      // Enforce SMS cap
      const smsChannels = rule.channels.filter((c) => c === "sms");
      if (smsChannels.length > 0 && smsSent >= smsCap) {
        console.log(`[Reminder Cron] SMS cap (${smsCap}/day) reached. Stopping SMS sends.`);
        continue;
      }

      try {
        const results = await sendReminderForInvoice(invoice.id, rule.channels, rule.segmentKey, {
          stage: rule.stage,
          sentBy: "system:reminder-cron",
          auto: true,
        });

        if (results.sms?.success) smsSent++;
        if (results.email?.success || results.sms?.success) {
          totalSent++;
          console.log(`[Reminder Cron] Sent ${rule.segmentKey} reminder for ${invoice.invoice_number}`);
        }
      } catch (err) {
        console.error(`[Reminder Cron] Error sending reminder for ${invoice.invoice_number}:`, err);
      }
    }
  }

  console.log(`[Reminder Cron] Completed. Sent ${totalSent} reminders (SMS: ${smsSent}/${smsCap})`);
}
