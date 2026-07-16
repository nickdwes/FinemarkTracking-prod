import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { createNotification } from "../routes/notifications.js";
import { sendEmailViaGraph, isGraphConfigured, MAILBOXES } from "./graphMailService.js";

/** Returns the email address to use for notifications.
 *  In dev/test mode (DEV_NOTIFY_EMAIL env), all outbound emails go there instead. */
function notifyEmail(actual: string): string {
  return process.env.DEV_NOTIFY_EMAIL || actual;
}

export interface LeadWarningRow {
  id: string;
  lead_no: string;
  customer_name: string | null;
  sales_rep_id: string;
  sales_rep_email: string;
  assigned_to_id: string | null;
  assigned_to_email: string | null;
  warn_nearing_close_no_activity: boolean;
  warn_new_no_followup: boolean;
}

/** Leads currently matching either Phase 2 warning condition — same SQL shape
 *  as GET /crm/leads' per-row flags, but unscoped (the cron sweeps everyone). */
export async function getLeadsWithWarnings(): Promise<LeadWarningRow[]> {
  const nowIso = new Date().toISOString();
  const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString();
  const cutoff7dActivity = new Date(Date.now() - 7 * 86400000).toISOString();
  const in7dCloseDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const todayDate = nowIso.slice(0, 10);

  const rows = await pgAll<LeadWarningRow>(
    `SELECT l.id, l.lead_no, l.customer_name, l.sales_rep_id, l.sales_rep_email,
            l.assigned_to_id, l.assigned_to_email,
      (l.status = 'Qualified' AND l.expected_close_date IS NOT NULL
        AND l.expected_close_date <= ? AND l.expected_close_date >= ?
        AND NOT EXISTS (SELECT 1 FROM crm_lead_conversations c WHERE c.lead_id = l.id AND c.created_at >= ?)
        AND NOT EXISTS (SELECT 1 FROM crm_lead_followups f WHERE f.lead_id = l.id AND f.created_at >= ?)
      ) AS warn_nearing_close_no_activity,
      (l.status = 'New' AND l.created_at <= ?
        AND NOT EXISTS (SELECT 1 FROM crm_lead_conversations c WHERE c.lead_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM crm_lead_followups f WHERE f.lead_id = l.id)
      ) AS warn_new_no_followup
     FROM crm_leads l
     WHERE l.deleted_at IS NULL AND l.status IN ('New','Qualified')`,
    [in7dCloseDate, todayDate, cutoff7dActivity, cutoff7dActivity, cutoff48h]
  ).catch(() => [] as LeadWarningRow[]);

  return rows.filter(r => r.warn_nearing_close_no_activity || r.warn_new_no_followup);
}

/** Dedupe check — same lead+warning+recipient shouldn't re-notify within the window. */
export async function checkRecentWarningNotification(
  leadId: string, warningType: string, recipient: string, withinHours: number = 24
): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinHours * 3600000).toISOString();
  const row = await pgGet(
    `SELECT id FROM crm_lead_warning_notifications WHERE lead_id = ? AND warning_type = ? AND recipient = ? AND sent_at > ? LIMIT 1`,
    [leadId, warningType, recipient, cutoff]
  ).catch(() => null);
  return !!row;
}

async function recordWarningNotification(leadId: string, warningType: string, recipient: string, channel: "bell" | "email") {
  await pgRun(
    `INSERT INTO crm_lead_warning_notifications (id, lead_id, warning_type, recipient, channel, sent_at) VALUES (?,?,?,?,?,?)`,
    [uuidv4(), leadId, warningType, recipient, channel, new Date().toISOString()]
  );
}

/** Notifies the lead's sales rep + assigned-to (bell always; email when Graph is
 *  configured) for one warning type, honoring the per-recipient 24h dedupe window. */
export async function sendLeadWarningNotification(
  lead: LeadWarningRow, warningType: string, title: string, message: string
): Promise<number> {
  const recipients = new Map<string, string>(); // userId -> email
  recipients.set(lead.sales_rep_id, lead.sales_rep_email);
  if (lead.assigned_to_id && lead.assigned_to_email) recipients.set(lead.assigned_to_id, lead.assigned_to_email);

  const link = `/crm-leads.html?id=${lead.id}`;
  let sent = 0;

  for (const [userId, email] of recipients) {
    const already = await checkRecentWarningNotification(lead.id, warningType, userId, 24);
    if (already) continue;

    await createNotification({ targetUserId: userId, type: "warning", title, body: message, link });
    await recordWarningNotification(lead.id, warningType, userId, "bell");

    if (isGraphConfigured() && email) {
      try {
        await sendEmailViaGraph({
          fromMailbox: MAILBOXES.notification,
          to: notifyEmail(email),
          subject: title,
          htmlBody: `<p>${message}</p><p><a href="https://portal.finemarktracking.co.ke${link}">Open lead ${lead.lead_no}</a></p>`,
        });
        await recordWarningNotification(lead.id, warningType, userId, "email");
      } catch (err) {
        console.error(`[crmLeadWarningService] Email failed for ${email}:`, err);
      }
    }
    sent++;
  }
  return sent;
}
