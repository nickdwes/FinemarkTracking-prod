import cron from "node-cron";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { createNotification } from "../routes/notifications.js";
import { sendEmailViaGraph, isGraphConfigured, MAILBOXES } from "../services/graphMailService.js";

/** Returns the email address to use for notifications.
 *  In dev/test mode (DEV_NOTIFY_EMAIL env), all outbound emails go there instead. */
function notifyEmail(actual: string): string {
  return process.env.DEV_NOTIFY_EMAIL || actual;
}

interface FollowupRow {
  followup_id: string;
  title: string;
  scheduled_at: string;
  status: string;
  rep_user_id: string;
  rep_email: string | null;
  rep_email_fallback: string | null;
  manager_user_id: string | null;
  manager_email: string | null;
  lead_id: string;
  lead_no: string;
  customer_name: string | null;
  customer_email: string | null;
}

// tier label -> minutes-before-scheduled-time it targets
const TIERS: { key: string; minutes: number; label: string }[] = [
  { key: "3d",  minutes: 3 * 24 * 60, label: "3 days" },
  { key: "24h", minutes: 24 * 60,     label: "24 hours" },
  { key: "2h",  minutes: 2 * 60,      label: "2 hours" },
];

// Matches the cron's own 15-minute cadence — as minutesUntil counts down it
// passes through each tier's window exactly once.
const CATCH_WINDOW_MINUTES = 15;

export const initLeadFollowupReminderCron = () => {
  const enabled = process.env.LEAD_FOLLOWUP_REMINDER_CRON_ENABLED === "true";
  if (!enabled) {
    console.log("[Lead Followup Reminder Cron] Disabled via LEAD_FOLLOWUP_REMINDER_CRON_ENABLED=false");
    return;
  }

  cron.schedule("*/15 * * * *", async () => {
    try {
      await runLeadFollowupReminderCheck();
    } catch (err) {
      console.error("[Lead Followup Reminder Cron] Error:", err);
    }
  });

  console.log("[Lead Followup Reminder Cron] Initialized (every 15 minutes)");
};

async function alreadySent(followupId: string, tier: string, recipient: string): Promise<boolean> {
  const row = await pgGet(
    `SELECT id FROM crm_lead_followup_reminders WHERE followup_id = ? AND tier = ? AND recipient = ? LIMIT 1`,
    [followupId, tier, recipient]
  ).catch(() => null);
  return !!row;
}

async function recordSent(followupId: string, tier: string, recipient: string, channel: "bell" | "email") {
  await pgRun(
    `INSERT INTO crm_lead_followup_reminders (id, followup_id, tier, recipient, channel, sent_at) VALUES (?,?,?,?,?,?)`,
    [uuidv4(), followupId, tier, recipient, channel, new Date().toISOString()]
  );
}

export async function runLeadFollowupReminderCheck() {
  const rows = await pgAll<FollowupRow>(
    `SELECT f.id AS followup_id, f.title, f.scheduled_at, f.status,
            f.created_by_user_id AS rep_user_id, u.email AS rep_email, f.created_by_name AS rep_email_fallback,
            f.manager_user_id, f.manager_email,
            l.id AS lead_id, l.lead_no, l.customer_name, l.email AS customer_email
     FROM crm_lead_followups f
     JOIN crm_leads l ON l.id = f.lead_id
     LEFT JOIN users u ON u.id = f.created_by_user_id
     WHERE f.status = 'Pending' AND l.deleted_at IS NULL`,
    []
  ).catch(() => [] as FollowupRow[]);

  const now = Date.now();
  let totalSent = 0;

  for (const f of rows) {
    const minutesUntil = (new Date(f.scheduled_at).getTime() - now) / 60000;
    if (!Number.isFinite(minutesUntil) || minutesUntil < 0) continue;

    for (const tier of TIERS) {
      const inWindow = minutesUntil <= tier.minutes && minutesUntil > tier.minutes - CATCH_WINDOW_MINUTES;
      if (!inWindow) continue;

      const repEmail = f.rep_email || f.rep_email_fallback;
      const subject = `Follow-up in ${tier.label}: ${f.title} — ${f.customer_name ?? f.lead_no}`;
      const body = `Follow-up "${f.title}" for lead ${f.lead_no}${f.customer_name ? ` (${f.customer_name})` : ""} is scheduled in ${tier.label} (${new Date(f.scheduled_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}).`;
      const link = `/crm-leads.html?id=${f.lead_id}`;

      // Rep + manager: bell + email
      const staffRecipients: { userId: string; email: string | null }[] = [{ userId: f.rep_user_id, email: repEmail }];
      if (f.manager_user_id) staffRecipients.push({ userId: f.manager_user_id, email: f.manager_email });

      for (const { userId, email } of staffRecipients) {
        if (await alreadySent(f.followup_id, tier.key, userId)) continue;
        await createNotification({ targetUserId: userId, type: "reminder", title: subject, body, link });
        await recordSent(f.followup_id, tier.key, userId, "bell");
        if (isGraphConfigured() && email) {
          try {
            await sendEmailViaGraph({ fromMailbox: MAILBOXES.notification, to: notifyEmail(email), subject, htmlBody: `<p>${body}</p>` });
            await recordSent(f.followup_id, tier.key, userId, "email");
          } catch (err) { console.error(`[Lead Followup Reminder Cron] Email failed for ${email}:`, err); }
        }
        totalSent++;
      }

      // Customer: email only — no in-app account to bell-notify
      if (f.customer_email && isGraphConfigured()) {
        const custKey = `customer:${f.customer_email}`;
        if (!(await alreadySent(f.followup_id, tier.key, custKey))) {
          try {
            await sendEmailViaGraph({ fromMailbox: MAILBOXES.notification, to: notifyEmail(f.customer_email), subject, htmlBody: `<p>${body}</p>` });
            await recordSent(f.followup_id, tier.key, custKey, "email");
            totalSent++;
          } catch (err) { console.error(`[Lead Followup Reminder Cron] Customer email failed for ${f.customer_email}:`, err); }
        }
      }

      console.log(`[Lead Followup Reminder Cron] Tier ${tier.key} processed for followup ${f.followup_id} (${f.lead_no})`);
    }
  }

  if (totalSent) console.log(`[Lead Followup Reminder Cron] Completed. ${totalSent} reminder(s) sent.`);
}
