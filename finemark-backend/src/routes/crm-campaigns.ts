import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { sendSms, isAtConfigured } from "../services/smsService.js";
import { sendWhatsAppBatch, isTwilioConfigured } from "../services/whatsappService.js";
import { encryptField, decryptField } from "../services/cryptoService.js";
import { sendEmailViaGraph, isGraphConfigured, MAILBOXES } from "../services/graphMailService.js";

const router = Router();

function mapCampaign(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    segmentCriteria: row.segment_criteria_json ? JSON.parse(row.segment_criteria_json) : {},
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    targetCount: row.target_count,
    sentCount: row.sent_count,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── List campaigns ─────────────────────────────────────────────────────────────
router.get(
  "/",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const { search, status, type, page = "1", pageSize = "50" } = req.query as any;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
    const offset = (pageNum - 1) * sizeNum;

    const filters: string[] = [];
    const params: any[] = [];

    if (search) { filters.push("name ILIKE ?"); params.push(`%${search}%`); }
    if (status) { filters.push("status = ?"); params.push(status); }
    if (type) { filters.push("type = ?"); params.push(type); }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = await pgAll(
      `SELECT * FROM crm_campaigns ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, sizeNum, offset]
    );
    const totalRow = await pgGet(`SELECT COUNT(*) AS total FROM crm_campaigns ${where}`, params);
    return ok(res, { data: rows.map(mapCampaign), meta: { total: Number(totalRow?.total ?? 0) } });
  }
);

// ── Create campaign ────────────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const { name, description, type, segmentCriteria, startDate, endDate } = req.body;
    if (!name) return errorResponse(res, 400, "VALIDATION_ERROR", "name is required");

    const now = new Date().toISOString();
    const id = uuidv4();
    await pgRun(
      `INSERT INTO crm_campaigns
         (id, name, description, type, segment_criteria_json, status, start_date, end_date, target_count, sent_count, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Draft', ?, ?, 0, 0, ?, ?, ?)`,
      [id, name, description || null, type || "Upsell", JSON.stringify(segmentCriteria || {}), startDate || null, endDate || null, req.user!.id, now, now]
    );

    auditLog(req, "CRM_CAMPAIGN_CREATED", `crm_campaign:${id}`, "Info", { name, type }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_campaigns WHERE id = ?", [id]);
    return created(res, mapCampaign(row), "Campaign created");
  }
);

// ── Get campaign ───────────────────────────────────────────────────────────────
router.get(
  "/:id",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const row = await pgGet("SELECT * FROM crm_campaigns WHERE id = ?", [req.params.id]);
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Campaign not found");
    return ok(res, mapCampaign(row));
  }
);

// ── Update campaign ────────────────────────────────────────────────────────────
router.patch(
  "/:id",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const now = new Date().toISOString();
    const { name, description, type, segmentCriteria, status, startDate, endDate } = req.body;
    const row = await pgGet("SELECT * FROM crm_campaigns WHERE id = ?", [req.params.id]);
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Campaign not found");

    await pgRun(
      `UPDATE crm_campaigns SET
         name = COALESCE(?, name), description = COALESCE(?, description),
         type = COALESCE(?, type),
         segment_criteria_json = COALESCE(?, segment_criteria_json),
         status = COALESCE(?, status),
         start_date = COALESCE(?, start_date), end_date = COALESCE(?, end_date),
         updated_at = ?
       WHERE id = ?`,
      [name || null, description || null, type || null,
       segmentCriteria ? JSON.stringify(segmentCriteria) : null,
       status || null, startDate || null, endDate || null, now, req.params.id]
    );

    auditLog(req, "CRM_CAMPAIGN_UPDATED", `crm_campaign:${req.params.id}`, "Info", { status }).catch(console.error);
    const updated = await pgGet("SELECT * FROM crm_campaigns WHERE id = ?", [req.params.id]);
    return ok(res, mapCampaign(updated), "Campaign updated");
  }
);

// ── Segment builder: fetch matching customers ──────────────────────────────────
// criteria: { type, region, status, subscriptionStatus, subscriptionService, renewingIn }
router.post(
  "/:id/segment",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const campaign = await pgGet("SELECT * FROM crm_campaigns WHERE id = ?", [req.params.id]);
    if (!campaign) return errorResponse(res, 404, "NOT_FOUND", "Campaign not found");

    const criteria = req.body.criteria || (campaign.segment_criteria_json ? JSON.parse(campaign.segment_criteria_json) : {});

    const filters: string[] = ["c.deleted_at IS NULL"];
    const params: any[] = [];

    if (criteria.type) { filters.push("c.type = ?"); params.push(criteria.type); }
    if (criteria.region) { filters.push("c.region ILIKE ?"); params.push(`%${criteria.region}%`); }
    if (criteria.status) { filters.push("c.status = ?"); params.push(criteria.status); }
    if (criteria.subscriptionStatus || criteria.subscriptionService) {
      filters.push("EXISTS (SELECT 1 FROM crm_subscriptions s WHERE s.customer_id = c.id"
        + (criteria.subscriptionStatus ? " AND s.status = ?" : "")
        + (criteria.subscriptionService ? " AND s.service_type ILIKE ?" : "")
        + ")");
      if (criteria.subscriptionStatus) params.push(criteria.subscriptionStatus);
      if (criteria.subscriptionService) params.push(`%${criteria.subscriptionService}%`);
    }
    if (criteria.renewingIn) {
      const days = parseInt(criteria.renewingIn, 10) || 30;
      const future = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      filters.push("EXISTS (SELECT 1 FROM crm_subscriptions s WHERE s.customer_id = c.id AND s.status='Active' AND s.end_date BETWEEN ? AND ?)");
      params.push(today, future);
    }

    const where = `WHERE ${filters.join(" AND ")}`;
    const rows = await pgAll(
      `SELECT c.id, c.account_no, c.type, COALESCE(ind.full_name, corp.company_name) AS display_name
       FROM crm_customers c
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
       ${where} ORDER BY c.created_at DESC LIMIT 500`,
      params
    );

    // Update campaign segment_criteria and target_count
    await pgRun(
      "UPDATE crm_campaigns SET segment_criteria_json = ?, target_count = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(criteria), rows.length, new Date().toISOString(), req.params.id]
    );

    return ok(res, { customers: rows, total: rows.length });
  }
);

// ── Add members to campaign ────────────────────────────────────────────────────
router.post(
  "/:id/members",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const { customerIds } = req.body;
    if (!Array.isArray(customerIds) || customerIds.length === 0) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "customerIds array is required");
    }

    const now = new Date().toISOString();
    let added = 0;
    for (const cid of customerIds) {
      const existing = await pgGet("SELECT id FROM crm_campaign_members WHERE campaign_id = ? AND customer_id = ?", [req.params.id, cid]);
      if (!existing) {
        await pgRun(
          `INSERT INTO crm_campaign_members (id, campaign_id, customer_id, status, created_at) VALUES (?, ?, ?, 'Pending', ?)`,
          [uuidv4(), req.params.id, cid, now]
        );
        added++;
      }
    }

    // Update target_count
    const countRow = await pgGet("SELECT COUNT(*) AS n FROM crm_campaign_members WHERE campaign_id = ?", [req.params.id]);
    await pgRun("UPDATE crm_campaigns SET target_count = ?, updated_at = ? WHERE id = ?",
      [Number(countRow?.n ?? 0), now, req.params.id]);

    return ok(res, { added, total: Number(countRow?.n ?? 0) }, `${added} members added`);
  }
);

// ── List campaign members ──────────────────────────────────────────────────────
router.get(
  "/:id/members",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const rows = await pgAll(
      `SELECT cm.*, COALESCE(ind.full_name, corp.company_name) AS customer_name, c.account_no, c.type
       FROM crm_campaign_members cm
       JOIN crm_customers c ON c.id = cm.customer_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = cm.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = cm.customer_id
       WHERE cm.campaign_id = ?
       ORDER BY cm.created_at`,
      [req.params.id]
    );
    return ok(res, rows.map((r: any) => ({
      id: r.id, customerId: r.customer_id, customerName: r.customer_name,
      accountNo: r.account_no, type: r.type, status: r.status,
      sentAt: r.sent_at, outcome: r.outcome, notes: r.notes,
    })));
  }
);

// ── Update member outcome ──────────────────────────────────────────────────────
router.patch(
  "/:id/members/:memberId",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const { status, outcome, notes } = req.body;
    const now = new Date().toISOString();
    await pgRun(
      `UPDATE crm_campaign_members SET
         status = COALESCE(?, status),
         sent_at = CASE WHEN ? = 'Sent' THEN ? ELSE sent_at END,
         outcome = COALESCE(?, outcome),
         notes = COALESCE(?, notes)
       WHERE id = ? AND campaign_id = ?`,
      [status || null, status, now, outcome || null, notes || null, req.params.memberId, req.params.id]
    );

    if (status === "Sent") {
      await pgRun(
        "UPDATE crm_campaigns SET sent_count = (SELECT COUNT(*) FROM crm_campaign_members WHERE campaign_id = ? AND status = 'Sent'), updated_at = ? WHERE id = ?",
        [req.params.id, now, req.params.id]
      );
    }

    const row = await pgGet("SELECT * FROM crm_campaign_members WHERE id = ?", [req.params.memberId]);
    return ok(res, { id: row.id, status: row.status, outcome: row.outcome }, "Member updated");
  }
);

// ── Mass SMS send ─────────────────────────────────────────────────────────────
// Fetches all campaign members with phone contacts → sends SMS via Africa's Talking.
router.post(
  "/:id/send-sms",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const { message, dryRun } = req.body;
    if (!message) return errorResponse(res, 400, "VALIDATION_ERROR", "message is required");

    const campaign = await pgGet("SELECT * FROM crm_campaigns WHERE id = ?", [req.params.id]);
    if (!campaign) return errorResponse(res, 404, "NOT_FOUND", "Campaign not found");

    if (!isAtConfigured()) {
      return errorResponse(res, 503, "NOT_CONFIGURED", "Africa's Talking SMS is not configured. Set AT_API_KEY, AT_USERNAME in .env");
    }

    // Collect phone numbers from campaign members via their primary contact
    const members = await pgAll(
      `SELECT cm.id AS member_id, cm.customer_id,
              COALESCE(ind.full_name, corp.company_name) AS customer_name,
              cc.phone
       FROM crm_campaign_members cm
       JOIN crm_customers c ON c.id = cm.customer_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = cm.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = cm.customer_id
       LEFT JOIN crm_customer_contacts cc ON cc.customer_id = cm.customer_id AND cc.is_primary = true
       WHERE cm.campaign_id = ? AND cm.status != 'Sent'`,
      [req.params.id]
    );

    const eligible = members.filter((m: any) => m.phone);
    if (eligible.length === 0) {
      return errorResponse(res, 422, "NO_RECIPIENTS", "No campaign members with phone numbers found");
    }

    if (dryRun) {
      return ok(res, {
        dryRun: true,
        total: eligible.length,
        recipients: eligible.map((m: any) => ({ customerId: m.customer_id, name: m.customer_name, phone: m.phone })),
      }, "Dry run — no messages sent");
    }

    // Send in batches of 100 (AT limit per request)
    const phones = eligible.map((m: any) => m.phone);
    const BATCH = 100;
    let totalSent = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < phones.length; i += BATCH) {
      const batch = phones.slice(i, i + BATCH);
      const results = await sendSms(batch, message);

      for (const r of results) {
        const m = eligible.find((x: any) => x.phone === r.recipient);
        if (!m) continue;

        const logId = uuidv4();
        await pgRun(
          `INSERT INTO crm_communication_logs
             (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
              contact_name, contacted_at, external_id, metadata_json, created_at)
           VALUES (?, ?, 'SMS', 'Outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            logId, m.customer_id,
            message.substring(0, 200), encryptField(message),
            req.user!.id, req.user!.email,
            m.customer_name || r.recipient,
            now, r.messageId,
            JSON.stringify({ campaignId: req.params.id, recipient: r.recipient, status: r.status, cost: r.cost }),
            now,
          ]
        );

        if (r.status === "Success") {
          await pgRun(
            `UPDATE crm_campaign_members SET status = 'Sent', sent_at = ? WHERE id = ?`,
            [now, m.member_id]
          );
          totalSent++;
        }
      }
    }

    // Update campaign sent_count
    await pgRun(
      "UPDATE crm_campaigns SET sent_count = (SELECT COUNT(*) FROM crm_campaign_members WHERE campaign_id = ? AND status = 'Sent'), updated_at = ? WHERE id = ?",
      [req.params.id, now, req.params.id]
    );

    auditLog(req, "CAMPAIGN_SMS_SENT", `crm_campaign:${req.params.id}`, "Info", { totalSent, total: eligible.length }).catch(console.error);
    return ok(res, { total: eligible.length, sent: totalSent, failed: eligible.length - totalSent }, "SMS campaign dispatched");
  }
);

// ── Mass WhatsApp send ────────────────────────────────────────────────────────
router.post(
  "/:id/send-whatsapp",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const { message, mediaUrl, dryRun } = req.body;
    if (!message) return errorResponse(res, 400, "VALIDATION_ERROR", "message is required");

    const campaign = await pgGet("SELECT * FROM crm_campaigns WHERE id = ?", [req.params.id]);
    if (!campaign) return errorResponse(res, 404, "NOT_FOUND", "Campaign not found");

    if (!isTwilioConfigured()) {
      return errorResponse(res, 503, "NOT_CONFIGURED", "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN in .env");
    }

    const members = await pgAll(
      `SELECT cm.id AS member_id, cm.customer_id,
              COALESCE(ind.full_name, corp.company_name) AS customer_name,
              cc.phone
       FROM crm_campaign_members cm
       JOIN crm_customers c ON c.id = cm.customer_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = cm.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = cm.customer_id
       LEFT JOIN crm_customer_contacts cc ON cc.customer_id = cm.customer_id AND cc.is_primary = true
       WHERE cm.campaign_id = ? AND cm.status != 'Sent'`,
      [req.params.id]
    );

    const eligible = members.filter((m: any) => m.phone);
    if (eligible.length === 0) {
      return errorResponse(res, 422, "NO_RECIPIENTS", "No campaign members with phone numbers found");
    }

    if (dryRun) {
      return ok(res, {
        dryRun: true,
        total: eligible.length,
        recipients: eligible.map((m: any) => ({ customerId: m.customer_id, name: m.customer_name, phone: m.phone })),
      }, "Dry run — no messages sent");
    }

    const phones = eligible.map((m: any) => m.phone);
    const results = await sendWhatsAppBatch(phones, message, mediaUrl);
    const now = new Date().toISOString();
    let totalSent = 0;

    for (const r of results) {
      const rawPhone = r.to.replace(/^whatsapp:/, "");
      const m = eligible.find((x: any) => x.phone === rawPhone || r.to.endsWith(x.phone));
      if (!m) continue;

      const logId = uuidv4();
      await pgRun(
        `INSERT INTO crm_communication_logs
           (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
            contact_name, contacted_at, external_id, metadata_json, created_at)
         VALUES (?, ?, 'WhatsApp', 'Outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          logId, m.customer_id,
          message.substring(0, 200), encryptField(message),
          req.user!.id, req.user!.email,
          m.customer_name || rawPhone,
          now, r.sid || null,
          JSON.stringify({ campaignId: req.params.id, to: r.to, status: r.status, error: r.error || null }),
          now,
        ]
      );

      if (!r.error && r.status !== "failed") {
        await pgRun(
          `UPDATE crm_campaign_members SET status = 'Sent', sent_at = ? WHERE id = ?`,
          [now, m.member_id]
        );
        totalSent++;
      }
    }

    await pgRun(
      "UPDATE crm_campaigns SET sent_count = (SELECT COUNT(*) FROM crm_campaign_members WHERE campaign_id = ? AND status = 'Sent'), updated_at = ? WHERE id = ?",
      [req.params.id, now, req.params.id]
    );

    auditLog(req, "CAMPAIGN_WHATSAPP_SENT", `crm_campaign:${req.params.id}`, "Info", { totalSent, total: eligible.length }).catch(console.error);
    return ok(res, { total: eligible.length, sent: totalSent, failed: eligible.length - totalSent }, "WhatsApp campaign dispatched");
  }
);

// ── Mass Email send ───────────────────────────────────────────────────────────
// Sends HTML email to all campaign members using customer@finemarktracking.co.ke
router.post(
  "/:id/send-email",
  requireAuth,
  requireRole(["Admin", "Sales", "BDM", "BDMCorporate", "Telesales"]),
  async (req: AuthRequest, res) => {
    const { subject, htmlBody, dryRun } = req.body;
    if (!subject) return errorResponse(res, 400, "VALIDATION_ERROR", "subject is required");
    if (!htmlBody) return errorResponse(res, 400, "VALIDATION_ERROR", "htmlBody is required");

    const campaign = await pgGet("SELECT * FROM crm_campaigns WHERE id = ?", [req.params.id]);
    if (!campaign) return errorResponse(res, 404, "NOT_FOUND", "Campaign not found");

    if (!isGraphConfigured()) {
      return errorResponse(res, 503, "NOT_CONFIGURED", "Microsoft Graph email is not configured. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET in .env");
    }

    // Collect emails from campaign members via individual or corporate contact
    const members = await pgAll(
      `SELECT cm.id AS member_id, cm.customer_id,
              COALESCE(ind.full_name, corp.company_name) AS customer_name,
              COALESCE(ind.email_enc, cp.email_enc) AS email_enc
       FROM crm_campaign_members cm
       JOIN crm_customers c ON c.id = cm.customer_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = cm.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = cm.customer_id
       LEFT JOIN (
         SELECT customer_id, email_enc FROM crm_contact_persons
         WHERE is_primary = true
       ) cp ON cp.customer_id = cm.customer_id
       WHERE cm.campaign_id = ? AND cm.status != 'Sent'`,
      [req.params.id]
    );

    // Decrypt emails and filter valid addresses
    const eligible = members
      .map((m: any) => ({ ...m, email: decryptField(m.email_enc) || null }))
      .filter((m: any) => m.email && m.email !== "—" && m.email.includes("@"));

    if (eligible.length === 0) {
      return errorResponse(res, 422, "NO_RECIPIENTS", "No campaign members with valid email addresses found");
    }

    if (dryRun) {
      return ok(res, {
        dryRun: true,
        total: eligible.length,
        recipients: eligible.map((m: any) => ({ customerId: m.customer_id, name: m.customer_name, email: m.email })),
      }, "Dry run — no emails sent");
    }

    const fromMailbox = MAILBOXES.customer;
    const now = new Date().toISOString();
    let totalSent = 0;
    const errors: string[] = [];

    // Send individually to personalise and track per recipient
    for (const m of eligible) {
      try {
        // Personalise: replace {{name}} placeholder if present
        const personalised = htmlBody.replace(/\{\{\s*name\s*\}\}/gi, m.customer_name || m.email);
        await sendEmailViaGraph({
          fromMailbox,
          to: m.email,
          subject,
          htmlBody: personalised,
        });

        // Log communication
        const logId = uuidv4();
        await pgRun(
          `INSERT INTO crm_communication_logs
             (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
              contact_name, contacted_at, external_id, metadata_json, created_at)
           VALUES (?, ?, 'Email', 'Outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            logId, m.customer_id,
            subject.substring(0, 200), encryptField(htmlBody.replace(/<[^>]*>/g, "").substring(0, 500)),
            req.user!.id, req.user!.email,
            m.customer_name || m.email,
            now, null,
            JSON.stringify({ campaignId: req.params.id, recipient: m.email, from: fromMailbox }),
            now,
          ]
        );

        await pgRun(
          `UPDATE crm_campaign_members SET status = 'Sent', sent_at = ? WHERE id = ?`,
          [now, m.member_id]
        );
        totalSent++;
      } catch (err: any) {
        errors.push(`${m.email}: ${err.message}`);
      }
    }

    await pgRun(
      "UPDATE crm_campaigns SET sent_count = (SELECT COUNT(*) FROM crm_campaign_members WHERE campaign_id = ? AND status = 'Sent'), updated_at = ? WHERE id = ?",
      [req.params.id, now, req.params.id]
    );

    auditLog(req, "CAMPAIGN_EMAIL_SENT", `crm_campaign:${req.params.id}`, "Info", { totalSent, total: eligible.length, errors: errors.length }).catch(console.error);
    return ok(res, { total: eligible.length, sent: totalSent, failed: eligible.length - totalSent, errors }, "Email campaign dispatched");
  }
);

export default router;
