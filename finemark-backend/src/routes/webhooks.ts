/**
 * Inbound webhooks:
 *   POST /api/webhooks/sms-inbound        — Africa's Talking delivery reports & inbound SMS
 *   POST /api/webhooks/whatsapp-inbound   — Twilio WhatsApp / SMS inbound
 *   POST /api/webhooks/email-sync         — Manually trigger email sync (protected)
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, errorResponse } from "../utils/responses.js";
import { parseTwilioInbound } from "../services/whatsappService.js";
import { encryptField } from "../services/cryptoService.js";
import { auditLog } from "../services/auditService.js";
import { syncMailbox } from "./crm-communications.js";

const router = Router();

// ── Twilio inbound (WhatsApp + SMS) ───────────────────────────────────────────
// Twilio calls this URL when a message arrives on your number.
// No auth header — validate by checking twilio signature in production.
router.post("/whatsapp-inbound", async (req: Request, res: Response) => {
  try {
    const msg = parseTwilioInbound(req.body as Record<string, string>);

    // Try to match by phone — look up customer contact
    const contact = await pgGet(
      `SELECT cc.customer_id, cc.name
       FROM crm_customer_contacts cc
       WHERE cc.phone = ? OR cc.phone = ?
       LIMIT 1`,
      [msg.from, `+${msg.from.replace(/^\+/, "")}`]
    );

    const customerId = contact?.customer_id ?? null;
    const now = new Date().toISOString();
    const id = uuidv4();

    await pgRun(
      `INSERT INTO crm_communication_logs
         (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
          contact_name, contacted_at, external_id, mailbox, metadata_json, created_at)
       VALUES (?, ?, ?, 'Inbound', ?, ?, 'system', 'system@finemark', ?, ?, ?, ?, ?, ?)`,
      [
        id,
        customerId || "00000000-0000-0000-0000-000000000000",
        msg.channel,
        msg.body?.substring(0, 200) || "(media)",
        encryptField(msg.body || ""),
        contact?.name || msg.from,
        msg.receivedAt,
        msg.messageSid,
        null,
        JSON.stringify({ from: msg.from, to: msg.to, mediaUrl: msg.mediaUrl }),
        now,
      ]
    );

    // Twilio expects a TwiML response (even if empty)
    res.set("Content-Type", "text/xml");
    res.send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  } catch (err) {
    console.error("[webhook:whatsapp-inbound]", err);
    res.set("Content-Type", "text/xml");
    res.send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  }
});

// ── Africa's Talking SMS delivery report ──────────────────────────────────────
router.post("/sms-inbound", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, string>;
    const isDelivery = !!body.id && !!body.status && !body.text;

    if (isDelivery) {
      // Delivery report — update metadata on the log matching external_id
      await pgRun(
        `UPDATE crm_communication_logs
         SET metadata_json = JSON_SET(COALESCE(metadata_json, '{}'), '$.deliveryStatus', ?, '$.deliveryAt', ?)
         WHERE external_id = ?`,
        [body.status, new Date().toISOString(), body.id]
      );
      return res.sendStatus(200);
    }

    // Inbound SMS
    const from = body.from || body.phoneNumber || "";
    const text = body.text || "";
    const atMsgId = body.id || uuidv4();

    // Deduplicate by external_id
    const existing = await pgGet(
      "SELECT id FROM crm_communication_logs WHERE external_id = ?",
      [atMsgId]
    );
    if (existing) return res.sendStatus(200);

    const contact = await pgGet(
      `SELECT customer_id, name FROM crm_customer_contacts WHERE phone = ? LIMIT 1`,
      [from]
    );

    const customerId = contact?.customer_id ?? "00000000-0000-0000-0000-000000000000";
    const now = new Date().toISOString();
    await pgRun(
      `INSERT INTO crm_communication_logs
         (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
          contact_name, contacted_at, external_id, metadata_json, created_at)
       VALUES (?, ?, 'SMS', 'Inbound', ?, ?, 'system', 'system@finemark', ?, ?, ?, ?, ?)`,
      [
        uuidv4(), customerId, text.substring(0, 200), encryptField(text),
        contact?.name || from, now, atMsgId,
        JSON.stringify({ from, linkId: body.linkId, shortCode: body.to }),
        now,
      ]
    );

    return res.sendStatus(200);
  } catch (err) {
    console.error("[webhook:sms-inbound]", err);
    return res.sendStatus(200); // Always 200 to AT
  }
});

// ── Manual email sync trigger ─────────────────────────────────────────────────
router.post(
  "/email-sync",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const { mailbox } = req.body as { mailbox?: string };
    try {
      const results = await syncMailbox(mailbox);
      auditLog(req, "EMAIL_SYNC_TRIGGERED", "system", "Info", { mailbox, results }).catch(console.error);
      return ok(res, results, "Email sync completed");
    } catch (err: any) {
      return errorResponse(res, 502, "SYNC_ERROR", err?.message ?? "Email sync failed");
    }
  }
);

export default router;
