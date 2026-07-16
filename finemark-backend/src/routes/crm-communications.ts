import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { encryptField, decryptField } from "../services/cryptoService.js";
import {
  fetchUnreadEmails, sendEmailViaGraph, replyToEmail, createCalendarEvent,
  isGraphConfigured, MAILBOXES, MailboxKey,
} from "../services/graphMailService.js";
import { sendSms, isAtConfigured } from "../services/smsService.js";
import { sendWhatsApp, isTwilioConfigured } from "../services/whatsappService.js";

const router = Router();

function mapLog(row: any, masked = false) {
  return {
    id: row.id,
    customerId: row.customer_id,
    channel: row.channel,
    direction: row.direction,
    subject: row.subject,
    body: masked ? "[restricted]" : (decryptField(row.body_enc) || null),
    byUserId: row.by_user_id,
    byUserEmail: row.by_user_email,
    contactName: row.contact_name,
    contactedAt: row.contacted_at,
    linkedTicketId: row.linked_ticket_id,
    externalId: row.external_id,
    mailbox: row.mailbox,
    createdAt: row.created_at,
  };
}

// ── List communication logs (customer-scoped) ─────────────────────────────────
router.get(
  "/customer/:customerId",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "CorporateSales", "Telesales", "Support", "Operations"]),
  async (req: AuthRequest, res) => {
    const { channel, direction, from, to, page = "1", pageSize = "50" } = req.query as any;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
    const offset = (pageNum - 1) * sizeNum;
    const isMasked = req.user!.role === "Support";

    const filters: string[] = ["customer_id = ?"];
    const params: any[] = [req.params.customerId];

    if (channel) { filters.push("channel = ?"); params.push(channel); }
    if (direction) { filters.push("direction = ?"); params.push(direction); }
    if (from) { filters.push("contacted_at >= ?"); params.push(new Date(from).toISOString()); }
    if (to) {
      const end = new Date(to); end.setHours(23, 59, 59, 999);
      filters.push("contacted_at <= ?"); params.push(end.toISOString());
    }

    const where = `WHERE ${filters.join(" AND ")}`;
    const rows = await pgAll(
      `SELECT * FROM crm_communication_logs ${where} ORDER BY contacted_at DESC LIMIT ? OFFSET ?`,
      [...params, sizeNum, offset]
    );
    const totalRow = await pgGet(`SELECT COUNT(*) AS total FROM crm_communication_logs ${where}`, params);

    return ok(res, { data: rows.map((r: any) => mapLog(r, isMasked)), meta: { total: Number(totalRow?.total ?? 0) } });
  }
);

// ── Log a communication ────────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "CorporateSales", "Telesales", "Support", "Operations"]),
  async (req: AuthRequest, res) => {
    const { customerId, channel, direction, subject, body, contactName, contactedAt, linkedTicketId } = req.body;
    if (!customerId || !channel) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "customerId and channel are required");
    }

    const customer = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [customerId]);
    if (!customer) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");

    const now = new Date().toISOString();
    const id = uuidv4();
    await pgRun(
      `INSERT INTO crm_communication_logs
         (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email, contact_name, contacted_at, linked_ticket_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, customerId, channel, direction || "Outbound",
        subject || null, encryptField(body),
        req.user!.id, req.user!.email,
        contactName || null, contactedAt || now, linkedTicketId || null, now,
      ]
    );

    auditLog(req, "CRM_COMMUNICATION_LOGGED", `crm_comm:${id}`, "Info", { channel, direction, customerId }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_communication_logs WHERE id = ?", [id]);
    return created(res, mapLog(row, false), "Communication logged");
  }
);

// ── Book a meeting with the customer ────────────────────────────────────────
// Sends a real O365 calendar invite (organizer = the acting rep, attendee =
// the customer contact) via Graph, then logs it as a Meeting communication —
// distinct from POST / (after-the-fact logging) since this is a forward-
// scheduled event with real calendar-invite semantics.
router.post(
  "/book-meeting",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "CorporateSales", "Telesales", "Support", "Operations"]),
  async (req: AuthRequest, res) => {
    const { customerId, subject, notes, scheduledAt, durationMinutes, attendeeEmail, attendeeName } = req.body;
    if (!customerId || !subject?.trim() || !scheduledAt) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "customerId, subject, and scheduledAt are required.");
    }

    const customer = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [customerId]);
    if (!customer) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");

    const dur = Number(durationMinutes) > 0 ? Number(durationMinutes) : 60;
    const startDt = new Date(scheduledAt);
    const endDt = new Date(startDt.getTime() + dur * 60000);

    let calendarWarning: string | null = null;
    if (isGraphConfigured()) {
      try {
        await createCalendarEvent({
          userEmail: req.user!.email,
          subject: subject.trim(),
          body: notes || subject.trim(),
          startDateTime: scheduledAt.slice(0, 19),
          endDateTime: endDt.toISOString().slice(0, 19),
          timeZone: "Africa/Nairobi",
          reminderMinutes: 30,
          attendees: attendeeEmail ? [attendeeEmail] : [],
        });
      } catch (err: any) {
        calendarWarning = "Meeting logged, but the calendar invite failed to send.";
        console.error("[book-meeting] calendar error:", err.message);
      }
    } else {
      calendarWarning = "Meeting logged, but calendar invites are not configured.";
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    await pgRun(
      `INSERT INTO crm_communication_logs
         (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email, contact_name, contacted_at, created_at)
       VALUES (?, ?, 'Meeting', 'Outbound', ?, ?, ?, ?, ?, ?, ?)`,
      [id, customerId, subject.trim(), encryptField(notes || null),
       req.user!.id, req.user!.email, attendeeName || null, scheduledAt, now]
    );

    auditLog(req, "CRM_MEETING_BOOKED", `crm_comm:${id}`, "Info", { customerId, subject, scheduledAt }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_communication_logs WHERE id = ?", [id]);
    return created(res, mapLog(row, false), calendarWarning || "Meeting booked and invite sent.");
  }
);

// ── Get single log ─────────────────────────────────────────────────────────────
router.get(
  "/:id",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "CorporateSales", "Telesales", "Support", "Operations"]),
  async (req: AuthRequest, res) => {
    const row = await pgGet("SELECT * FROM crm_communication_logs WHERE id = ?", [req.params.id]);
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Communication log not found");
    const isMasked = req.user!.role === "Support";
    return ok(res, mapLog(row, isMasked));
  }
);

// ── Global inbox (cross-customer, recent logs) ────────────────────────────────
router.get(
  "/",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "CorporateSales", "Telesales", "Support", "Operations"]),
  async (req: AuthRequest, res) => {
    const { channel, direction, mailbox, page = "1", pageSize = "50" } = req.query as any;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
    const offset = (pageNum - 1) * sizeNum;
    const isMasked = req.user!.role === "Support";

    const filters: string[] = [];
    const params: any[] = [];
    if (channel) { filters.push("channel = ?"); params.push(channel); }
    if (direction) { filters.push("direction = ?"); params.push(direction); }
    if (mailbox) { filters.push("mailbox = ?"); params.push(mailbox); }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = await pgAll(
      `SELECT * FROM crm_communication_logs ${where} ORDER BY contacted_at DESC LIMIT ? OFFSET ?`,
      [...params, sizeNum, offset]
    );
    const totalRow = await pgGet(`SELECT COUNT(*) AS total FROM crm_communication_logs ${where}`, params);
    return ok(res, { data: rows.map((r: any) => mapLog(r, isMasked)), meta: { total: Number(totalRow?.total ?? 0) } });
  }
);

// ── Send Email via Microsoft Graph ────────────────────────────────────────────
router.post(
  "/send-email",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "CorporateSales", "Telesales", "Support", "Operations"]),
  async (req: AuthRequest, res) => {
    const { customerId, toAddresses, subject, htmlBody, textBody, fromMailboxKey, replyToExternalId, linkedTicketId } = req.body;
    if (!toAddresses || !subject || !htmlBody) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "toAddresses, subject, htmlBody are required");
    }
    if (!isGraphConfigured()) {
      return errorResponse(res, 503, "NOT_CONFIGURED", "Microsoft Graph email is not configured. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET in .env");
    }

    const key: MailboxKey = (fromMailboxKey as MailboxKey) || "customer";
    const fromMailbox = MAILBOXES[key] ?? MAILBOXES.customer;

    if (replyToExternalId) {
      await replyToEmail({ fromMailbox, messageId: replyToExternalId, htmlBody });
    } else {
      await sendEmailViaGraph({
        fromMailbox,
        to: Array.isArray(toAddresses) ? toAddresses : [toAddresses],
        subject,
        htmlBody,
        textBody,
      });
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    const bodyForLog = htmlBody || textBody || "";
    await pgRun(
      `INSERT INTO crm_communication_logs
         (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
          contact_name, contacted_at, linked_ticket_id, mailbox, created_at)
       VALUES (?, ?, 'Email', 'Outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, customerId || "00000000-0000-0000-0000-000000000000",
        subject, encryptField(bodyForLog),
        req.user!.id, req.user!.email,
        (Array.isArray(toAddresses) ? toAddresses.join(", ") : toAddresses),
        now, linkedTicketId || null, fromMailbox, now,
      ]
    );

    auditLog(req, "EMAIL_SENT", `crm_comm:${id}`, "Info", { fromMailbox, subject, customerId }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_communication_logs WHERE id = ?", [id]);
    return created(res, mapLog(row, false), "Email sent and logged");
  }
);

// ── Send SMS via Africa's Talking ─────────────────────────────────────────────
router.post(
  "/send-sms",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "CorporateSales", "Telesales", "Support", "Operations"]),
  async (req: AuthRequest, res) => {
    const { customerId, phoneNumbers, message, linkedTicketId, contactName } = req.body;
    if (!phoneNumbers || !message) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "phoneNumbers and message are required");
    }
    if (!isAtConfigured()) {
      return errorResponse(res, 503, "NOT_CONFIGURED", "Africa's Talking SMS is not configured. Set AT_API_KEY, AT_USERNAME in .env");
    }

    const numbers = Array.isArray(phoneNumbers) ? phoneNumbers : [phoneNumbers];
    const results = await sendSms(numbers, message);

    const now = new Date().toISOString();
    const successSids: string[] = [];
    for (const r of results) {
      const id = uuidv4();
      await pgRun(
        `INSERT INTO crm_communication_logs
           (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
            contact_name, contacted_at, linked_ticket_id, external_id, metadata_json, created_at)
         VALUES (?, ?, 'SMS', 'Outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, customerId || "00000000-0000-0000-0000-000000000000",
          message.substring(0, 200), encryptField(message),
          req.user!.id, req.user!.email,
          contactName || r.recipient,
          now, linkedTicketId || null, r.messageId,
          JSON.stringify({ recipient: r.recipient, status: r.status, cost: r.cost }),
          now,
        ]
      );
      if (r.status === "Success") successSids.push(r.messageId);
    }

    auditLog(req, "SMS_SENT", `crm_sms`, "Info", { count: numbers.length, customerId }).catch(console.error);
    return ok(res, { results, sent: successSids.length, total: numbers.length }, "SMS dispatched");
  }
);

// ── Send WhatsApp via Twilio ───────────────────────────────────────────────────
router.post(
  "/send-whatsapp",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "CorporateSales", "Telesales", "Support", "Operations"]),
  async (req: AuthRequest, res) => {
    const { customerId, phoneNumber, message, mediaUrl, linkedTicketId, contactName } = req.body;
    if (!phoneNumber || !message) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "phoneNumber and message are required");
    }
    if (!isTwilioConfigured()) {
      return errorResponse(res, 503, "NOT_CONFIGURED", "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN in .env");
    }

    const result = await sendWhatsApp(phoneNumber, message, mediaUrl);

    const now = new Date().toISOString();
    const id = uuidv4();
    await pgRun(
      `INSERT INTO crm_communication_logs
         (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
          contact_name, contacted_at, linked_ticket_id, external_id, metadata_json, created_at)
       VALUES (?, ?, 'WhatsApp', 'Outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, customerId || "00000000-0000-0000-0000-000000000000",
        message.substring(0, 200), encryptField(message),
        req.user!.id, req.user!.email,
        contactName || phoneNumber,
        now, linkedTicketId || null, result.sid,
        JSON.stringify({ to: result.to, status: result.status, mediaUrl: mediaUrl || null }),
        now,
      ]
    );

    auditLog(req, "WHATSAPP_SENT", `crm_comm:${id}`, "Info", { phoneNumber, customerId }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_communication_logs WHERE id = ?", [id]);
    return created(res, mapLog(row, false), "WhatsApp message sent and logged");
  }
);

// ── Email sync status ─────────────────────────────────────────────────────────
router.get(
  "/email-sync/status",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (_req: AuthRequest, res) => {
    const rows = await pgAll("SELECT * FROM email_sync_state", []);
    return ok(res, {
      configured: isGraphConfigured(),
      mailboxes: MAILBOXES,
      syncState: rows,
    });
  }
);

// ── syncMailbox: exported for use by scheduler & webhook ─────────────────────
export async function syncMailbox(
  mailboxKey?: string
): Promise<Record<string, { synced: number; errors: number }>> {
  const keys: MailboxKey[] = mailboxKey
    ? [mailboxKey as MailboxKey]
    : (Object.keys(MAILBOXES) as MailboxKey[]);

  const summary: Record<string, { synced: number; errors: number }> = {};

  for (const key of keys) {
    const mbAddr = MAILBOXES[key as MailboxKey];
    if (!mbAddr) continue;
    summary[key] = { synced: 0, errors: 0 };

    try {
      const stateRow = await pgGet("SELECT * FROM email_sync_state WHERE mailbox = ?", [mbAddr]);
      const deltaLink: string | null = stateRow?.last_delta_link ?? null;

      const { messages, nextDeltaLink } = await fetchUnreadEmails(mbAddr, deltaLink);

      for (const msg of messages) {
        const existing = await pgGet(
          "SELECT id FROM crm_communication_logs WHERE external_id = ?",
          [msg.id]
        );
        if (existing) continue;

        const fromAddr = msg.from?.emailAddress?.address || "";

        // Skip emails sent from any of our own mailboxes (e.g. system notifications
        // delivered back into the same inbox — these have no customer context).
        const allMailboxAddrs = Object.values(MAILBOXES).map((a) => a.toLowerCase());
        if (allMailboxAddrs.includes(fromAddr.toLowerCase())) {
          continue;
        }

        const contact = await pgGet(
          `SELECT customer_id, name FROM crm_customer_users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
          [fromAddr]
        );

        const now = new Date().toISOString();
        const customerId = contact?.customer_id ?? null;

        // Skip emails from senders not yet linked to a customer record — inserting
        // with a NULL customer_id would violate the NOT NULL constraint.  The email
        // remains in the mailbox and will be picked up again once a customer record
        // with a matching e-mail address is created.
        if (!customerId) {
          console.warn(
            `[emailSync] Skipping unmatched inbound email from <${fromAddr}> – not found in crm_customer_users (subject: "${msg.subject || "(no subject)"}")`
          );
          continue;
        }

        await pgRun(
          `INSERT INTO crm_communication_logs
             (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
              contact_name, contacted_at, external_id, mailbox, metadata_json, created_at)
           VALUES (?, ?, 'Email', 'Inbound', ?, ?, 'system', ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(), customerId,
            msg.subject || "(no subject)",
            encryptField(msg.body?.content || msg.bodyPreview || ""),
            mbAddr,
            msg.from?.emailAddress?.name || fromAddr,
            msg.receivedDateTime || now,
            msg.id, mbAddr,
            JSON.stringify({
              from: fromAddr,
              to: msg.toRecipients?.map((r: any) => r.emailAddress.address),
              bodyPreview: msg.bodyPreview?.substring(0, 500),
            }),
            now,
          ]
        );

        summary[key].synced++;
      }

      // Persist delta link for incremental future syncs
      if (nextDeltaLink) {
        await pgRun(
          `INSERT INTO email_sync_state (mailbox, last_synced_at, last_delta_link)
           VALUES (?, ?, ?)
           ON CONFLICT(mailbox) DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at, last_delta_link = EXCLUDED.last_delta_link`,
          [mbAddr, new Date().toISOString(), nextDeltaLink]
        );
      }
    } catch (err) {
      console.error(`[emailSync] Error syncing ${key}:`, err);
      summary[key].errors++;
    }
  }

  return summary;
}

export default router;
