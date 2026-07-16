/**
 * Retail Leads – Business Development Retail Segment
 *
 * Flow:
 *   Sales / BDM creates retail lead  (POST /)
 *   → On submit: auto-creates installation ticket (RTL-XXXXX numbering)
 *   → Pushes to technical pipeline
 *   → Notifies technical team, BDM, Finance, Sales person
 *   → Triggers quote creation hook
 *
 * Tables:
 *   retail_leads         – main lead record
 *   retail_lead_vehicles – vehicle detail linked to lead
 */

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun }            from "../db.js";
import { requireAuth, AuthRequest }        from "../middleware/auth.js";
import { requireRole }                     from "../middleware/rbac.js";
import { ok, created, errorResponse }      from "../utils/responses.js";
import { auditLog }                        from "../services/auditService.js";
import { encryptField }                    from "../services/cryptoService.js";
import { IdGenerator }                     from "../utils/idGenerator.js";
import { createNotification }              from "./notifications.js";
import {
  isGraphConfigured,
  sendEmailViaGraph,
  MAILBOXES,
}                                          from "../services/graphMailService.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { sendSms, isAtConfigured }         from "../services/smsService.js";
import { sendWhatsApp, isTwilioConfigured } from "../services/whatsappService.js";
import { materializeRetailQuoteForTicket, materializeBankFinancedQuoteForLead } from "../services/retailQuoteAutomation.js";
import { isValidKePhone, isValidEmail } from "../utils/validators.js";
import { findDuplicateCustomers } from "../services/customerDedupeService.js";
import { invalidateCustomerCaches } from "../services/customerCacheService.js";

const router = Router();

// ── Document upload setup ──────────────────────────────────────────────────────
const LEAD_DOCS_DIR = path.resolve(process.cwd(), "uploads/lead-attachments");
fs.mkdirSync(LEAD_DOCS_DIR, { recursive: true });

const docStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LEAD_DOCS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type ${file.mimetype} not allowed`));
  },
});

// ── retail_lead_documents table ────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS retail_lead_documents (
    id         TEXT PRIMARY KEY,
    lead_id    TEXT NOT NULL,
    doc_type   TEXT NOT NULL,
    label      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    notes      TEXT,
    file_name  TEXT,
    file_path  TEXT,
    file_size  INTEGER,
    mime_type  TEXT,
    uploaded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`).catch(console.error);

// ─────────────────────────────────────────────────────────────────────────────
// Schema bootstrap
// ─────────────────────────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS retail_leads (
    id                     TEXT PRIMARY KEY,
    lead_no                TEXT UNIQUE NOT NULL,
    customer_type          TEXT NOT NULL DEFAULT 'new_customer',
    lead_source            TEXT NOT NULL DEFAULT 'Direct',
    partner_id             TEXT,
    partner_name           TEXT,
    secondary_partner_id   TEXT,
    secondary_partner_name TEXT,
    referrer_name          TEXT,
    referrer_phone         TEXT,
    service_interest       TEXT NOT NULL DEFAULT '[]',
    service_other          TEXT,
    product_id             TEXT,
    product_name           TEXT,
    customer_id            TEXT,
    customer_name          TEXT NOT NULL,
    customer_phone         TEXT,
    customer_email         TEXT,
    customer_location      TEXT,
    customer_notes         TEXT,
    status                 TEXT NOT NULL DEFAULT 'New',
    sales_rep_id           TEXT NOT NULL,
    sales_rep_name         TEXT,
    bdm_id                 TEXT,
    bdm_name               TEXT,
    installation_ticket_id TEXT,
    installation_ticket_no TEXT,
    quote_id               TEXT,
    submitted_at           TEXT,
    created_by_user_id     TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    deleted_at             TEXT
  )
`, []).catch(e => console.error("[retail_leads] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS retail_lead_vehicles (
    id                 TEXT PRIMARY KEY,
    lead_id            TEXT NOT NULL UNIQUE,
    registration_known BOOLEAN NOT NULL DEFAULT FALSE,
    registration       TEXT,
    chassis_no         TEXT,
    make               TEXT,
    model              TEXT,
    year               TEXT,
    color              TEXT,
    engine_no          TEXT,
    vehicle_id         TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  )
`, []).catch(e => console.error("[retail_lead_vehicles] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_retail_leads_status  ON retail_leads(status)`,  []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_retail_leads_sales   ON retail_leads(sales_rep_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_retail_lead_vehicles ON retail_lead_vehicles(lead_id)`, []).catch(() => {});

// Migrate: add missing columns
setTimeout(async () => {
  for (const col of [
    "customer_email TEXT",
    "customer_location TEXT",
    "installation_financer TEXT",
    "installation_contact_name TEXT",
    "installation_contact_phone TEXT",
    "installation_county TEXT",
    "location_description TEXT",
    "bank_partner_name TEXT",
    "customer_entity_type TEXT",
  ]) {
    await pgRun(`ALTER TABLE retail_leads ADD COLUMN IF NOT EXISTS ${col}`, []).catch(() => {});
  }
  await pgRun(`ALTER TABLE retail_lead_vehicles ADD COLUMN IF NOT EXISTS loan_term_months INTEGER`, []).catch(() => {});
  await pgRun(`ALTER TABLE retail_lead_vehicles ADD COLUMN IF NOT EXISTS vehicle_category TEXT NOT NULL DEFAULT 'motor_vehicle'`, []).catch(() => {});
}, 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function mapLead(row: any, vehicle?: any, ticket?: any, invoice?: any) {
  return {
    id:                   row.id,
    leadNo:               row.lead_no,
    customerType:         row.customer_type,
    leadSource:           row.lead_source,
    partnerId:            row.partner_id       || null,
    partnerName:          row.partner_name     || null,
    secondaryPartnerId:   row.secondary_partner_id   || null,
    secondaryPartnerName: row.secondary_partner_name || null,
    referrerName:         row.referrer_name    || null,
    referrerPhone:        row.referrer_phone   || null,
    serviceInterest:      (() => { try { return JSON.parse(row.service_interest || "[]"); } catch { return []; } })(),
    serviceOther:         row.service_other    || null,
    productId:            row.product_id       || null,
    productName:          row.product_name     || null,
    customerId:           row.customer_id      || null,
    customerName:         row.customer_name,
    customerPhone:        row.customer_phone   || null,
    customerEmail:        row.customer_email   || null,
    customerLocation:     row.customer_location || null,
    customerNotes:        row.customer_notes   || null,
    customerEntityType:   row.customer_entity_type || "individual",
    status:               row.status ? row.status.toLowerCase().replace(/ /g, "_") : "new",
    salesRepId:           row.sales_rep_id,
    salesRepName:         row.sales_rep_name   || null,
    bdmId:                row.bdm_id           || null,
    bdmName:              row.bdm_name         || null,
    installationFinancer:     row.installation_financer       || null,
    installationContactName:  row.installation_contact_name   || null,
    installationContactPhone: row.installation_contact_phone  || null,
    installationCounty:       row.installation_county         || null,
    locationDescription:      row.location_description        || null,
    bankPartnerName:          row.bank_partner_name           || null,
    installationTicketId: row.installation_ticket_id || null,
    installationTicketNo: row.installation_ticket_no || null,
    installationTicketStatus: ticket?.status || null,
    installationTicketStage: ticket?.stage ?? null,
    invoiceId: invoice?.id || null,
    invoiceNumber: invoice?.invoice_number || null,
    invoiceStatus: invoice?.status || null,
    quoteId:              row.quote_id         || null,
    submittedAt:          row.submitted_at     || null,
    createdAt:            row.created_at,
    updatedAt:            row.updated_at,
    vehicle: vehicle ? {
      id:                vehicle.id,
      registrationKnown: Boolean(vehicle.registration_known),
      registration:      vehicle.registration  || null,
      chassisNo:         vehicle.chassis_no    || null,
      make:              vehicle.make          || null,
      model:             vehicle.model         || null,
      year:              vehicle.year          || null,
      color:             vehicle.color         || null,
      engineNo:        vehicle.engine_no      || null,
      vehicleId:       vehicle.vehicle_id     || null,
      loanTermMonths:  vehicle.loan_term_months != null ? Number(vehicle.loan_term_months) : null,
      vehicleCategory: vehicle.vehicle_category || "motor_vehicle",
    } : null,
  };
}

/** Returns the email address to use for notifications.
 *  In dev/test mode (DEV_NOTIFY_EMAIL env), all outbound emails go there instead. */
function notifyEmail(actual: string): string {
  return process.env.DEV_NOTIFY_EMAIL || actual;
}

/** Dev-mode indicator: true when DEV_NOTIFY_EMAIL is set */
function isDevMode(): boolean {
  return !!process.env.DEV_NOTIFY_EMAIL;
}

function nextRetailLeadNo(): string {
  return IdGenerator.generateId("retail_lead");
}

function nextRetailTicketNo(): string {
  return IdGenerator.generateId("retail_ticket");
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /  – list retail leads
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const { status, search, salesRepId, page = "1", pageSize = "50" } = req.query as any;
  const user = req.user!;
  const isBDM = ["Admin", "BDM", "Finance"].includes(user.role);

  const limit  = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const conditions: string[] = ["l.deleted_at IS NULL"];
  const params: any[]        = [];

  if (!isBDM) {
    conditions.push("l.sales_rep_id = ?");
    params.push(user.id);
  } else if (salesRepId) {
    conditions.push("l.sales_rep_id = ?");
    params.push(salesRepId);
  }

  // "Ready to invoice" is driven by the linked TICKET's own status, not
  // l.status — a lead whose installation is genuinely done should show up
  // here even if nobody has clicked "Close Lead" on it yet (that button
  // marks the lead record itself closed, a separate bookkeeping step from
  // "is the install actually finished"). Invoiced/Paid stay keyed off the
  // quote→invoice link regardless of the lead's own status.
  if (status === "closed_ready") {
    conditions.push("EXISTS (SELECT 1 FROM installation_tickets t WHERE t.id = l.installation_ticket_id AND t.status = 'Completed')");
    conditions.push("NOT EXISTS (SELECT 1 FROM invoices i WHERE i.quote_id = l.quote_id)");
  } else if (status === "invoiced") {
    conditions.push("EXISTS (SELECT 1 FROM invoices i WHERE i.quote_id = l.quote_id AND i.status != 'Paid')");
  } else if (status === "paid") {
    conditions.push("EXISTS (SELECT 1 FROM invoices i WHERE i.quote_id = l.quote_id AND i.status = 'Paid')");
  } else if (status) {
    // Case-insensitive — live data has "cancelled" stored lowercase
    // alongside "New"/"Submitted"/"Completed" capitalized, so a plain
    // equality match silently returns zero rows for that tab.
    conditions.push("LOWER(l.status) = LOWER(?)");
    params.push(status);
  }

  if (search) {
    conditions.push("(l.customer_name LIKE ? OR l.lead_no LIKE ? OR l.customer_phone LIKE ?)");
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows, countRow] = await Promise.all([
    pgAll(`SELECT l.* FROM retail_leads l ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]),
    pgGet(`SELECT COUNT(*) AS total FROM retail_leads l ${where}`, params),
  ]);

  const leadIds = rows.map((r: any) => r.id);
  let vehicleMap: Record<string, any> = {};
  if (leadIds.length) {
    const placeholders = leadIds.map(() => "?").join(",");
    const vehicles = await pgAll(
      `SELECT * FROM retail_lead_vehicles WHERE lead_id IN (${placeholders})`,
      leadIds
    );
    vehicleMap = Object.fromEntries((vehicles as any[]).map(v => [v.lead_id, v]));
  }

  const ticketIds = [...new Set((rows as any[]).map((r) => r.installation_ticket_id).filter(Boolean))];
  let ticketMap: Record<string, any> = {};
  if (ticketIds.length) {
    const placeholders = ticketIds.map(() => "?").join(",");
    const tickets = await pgAll(
      `SELECT id, status, stage FROM installation_tickets WHERE id IN (${placeholders})`,
      ticketIds
    );
    ticketMap = Object.fromEntries((tickets as any[]).map((t) => [t.id, t]));
  }

  // A quote can in principle collect more than one invoice over time (e.g. a
  // reissue) — DISTINCT ON picks the most recent per quote_id so segmentation
  // reflects current reality, not a stale earlier attempt.
  const quoteIds = [...new Set((rows as any[]).map((r) => r.quote_id).filter(Boolean))];
  let invoiceMap: Record<string, any> = {};
  if (quoteIds.length) {
    const placeholders = quoteIds.map(() => "?").join(",");
    const invoices = await pgAll(
      `SELECT DISTINCT ON (quote_id) quote_id, id, invoice_number, status, created_at
       FROM invoices WHERE quote_id IN (${placeholders}) ORDER BY quote_id, created_at DESC`,
      quoteIds
    );
    invoiceMap = Object.fromEntries((invoices as any[]).map((i) => [i.quote_id, i]));
  }

  return ok(res, {
    leads: (rows as any[]).map((r) => mapLead(r, vehicleMap[r.id], ticketMap[r.installation_ticket_id], invoiceMap[r.quote_id])),
    total: Number(countRow?.total || 0),
    page: Math.max(parseInt(page, 10) || 1, 1),
    pageSize: limit,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /stats
// ─────────────────────────────────────────────────────────────────────────────
router.get("/stats", requireAuth, async (req: AuthRequest, res) => {
  const user   = req.user!;
  const isBDM  = ["Admin", "BDM", "Finance"].includes(user.role);
  const filter = isBDM ? "l.deleted_at IS NULL" : "l.deleted_at IS NULL AND l.sales_rep_id = ?";
  const params = isBDM ? [] : [user.id];

  const [statusRows, closedRow, invoicedRow, paidRow] = await Promise.all([
    pgAll<{ status: string; cnt: string }>(
      `SELECT status, COUNT(*) AS cnt FROM retail_leads l WHERE ${filter} GROUP BY status`, params
    ),
    // "Closed" (ready to invoice) keys off the linked ticket's own status —
    // not l.status, which only flips once someone clicks "Close Lead" — so a
    // lead whose install is genuinely done shows up here immediately, not
    // only after that separate manual bookkeeping step. Invoiced/Paid are
    // keyed off the quote→invoice link, independent of the lead's status.
    pgGet<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM retail_leads l WHERE ${filter}
       AND EXISTS (SELECT 1 FROM installation_tickets t WHERE t.id = l.installation_ticket_id AND t.status = 'Completed')
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.quote_id = l.quote_id)`, params
    ),
    pgGet<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM retail_leads l WHERE ${filter}
       AND EXISTS (SELECT 1 FROM invoices i WHERE i.quote_id = l.quote_id AND i.status != 'Paid')`, params
    ),
    pgGet<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM retail_leads l WHERE ${filter}
       AND EXISTS (SELECT 1 FROM invoices i WHERE i.quote_id = l.quote_id AND i.status = 'Paid')`, params
    ),
  ]);

  const stats: Record<string, number> = {
    New: 0, Submitted: 0, InProgress: 0, Completed: 0, Cancelled: 0,
    Closed: 0, Invoiced: 0, Paid: 0,
  };
  // Case-insensitive match — live data has "cancelled" lowercase alongside
  // "New"/"Submitted" capitalized, which a plain stats[r.status] lookup
  // silently misses (adds a stray lowercase key instead of incrementing
  // the real one), leaving the Cancelled card permanently stuck at 0.
  (statusRows as any[]).forEach((r) => {
    const key = Object.keys(stats).find((k) => k.toLowerCase() === String(r.status).toLowerCase());
    if (key) stats[key] += Number(r.cnt);
  });
  stats.Closed = Number(closedRow?.cnt || 0);
  stats.Invoiced = Number(invoicedRow?.cnt || 0);
  stats.Paid = Number(paidRow?.cnt || 0);
  return ok(res, { stats });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id  – single lead with vehicle
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req: AuthRequest, res) => {
  const lead = await pgGet(
    `SELECT * FROM retail_leads WHERE id = ? AND deleted_at IS NULL`, [req.params.id]
  );
  if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Retail lead not found.");

  const vehicle = await pgGet(
    `SELECT * FROM retail_lead_vehicles WHERE lead_id = ?`, [req.params.id]
  ).catch(() => null);

  const ticket = lead.installation_ticket_id
    ? await pgGet(`SELECT status, stage FROM installation_tickets WHERE id = ?`, [lead.installation_ticket_id]).catch(() => null)
    : null;

  return ok(res, { lead: mapLead(lead, vehicle, ticket) });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /  – create lead (draft, not yet submitted)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireRole(["Sales", "Admin", "BDM", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const user = req.user!;
    const {
      customerType, leadSource,
      partnerId, partnerName, secondaryPartnerId, secondaryPartnerName,
      referrerName, referrerPhone,
      serviceInterest, serviceOther,
      productId, productName,
      customerName, customerPhone, customerNotes, customerId,
      customerEmail, customerLocation, customerEntityType,
      bdmId, bdmName,
      installationFinancer, installationContactName, installationContactPhone,
      installationCounty, locationDescription, bankPartnerName,
      vehicle,
    } = req.body || {};

    if (!customerName?.trim()) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "customerName is required.");
    }
    if (!leadSource?.trim()) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "leadSource is required.");
    }
    if (customerPhone?.trim() && !isValidKePhone(customerPhone)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Customer phone number is not a valid Kenyan mobile number (e.g. 0712 345678 or +254712345678).");
    }
    if (customerEmail?.trim() && !isValidEmail(customerEmail)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Customer email address is not valid.");
    }
    if (referrerPhone?.trim() && !isValidKePhone(referrerPhone)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Referrer phone number is not a valid Kenyan mobile number.");
    }
    if (installationContactPhone?.trim() && !isValidKePhone(installationContactPhone)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Installation contact phone number is not a valid Kenyan mobile number.");
    }

    const now    = new Date().toISOString();
    const id     = uuidv4();
    const leadNo = nextRetailLeadNo();

    await pgRun(
      `INSERT INTO retail_leads
         (id, lead_no, customer_type, lead_source,
          partner_id, partner_name, secondary_partner_id, secondary_partner_name,
          referrer_name, referrer_phone,
          service_interest, service_other, product_id, product_name,
          customer_id, customer_name, customer_phone, customer_notes,
          status, sales_rep_id, sales_rep_name, bdm_id, bdm_name,
          customer_email, customer_location, customer_entity_type,
          installation_financer, installation_contact_name, installation_contact_phone,
          installation_county, location_description, bank_partner_name,
          created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, leadNo, customerType || "new_customer", leadSource,
        partnerId || null, partnerName || null,
        secondaryPartnerId || null, secondaryPartnerName || null,
        referrerName || null, referrerPhone || null,
        JSON.stringify(serviceInterest || []), serviceOther || null,
        productId || null, productName || null,
        customerId || null, customerName.trim(), customerPhone || null, customerNotes || null,
        "New", user.id, user.email || null, bdmId || null, bdmName || null,
        customerEmail || null, customerLocation || null,
        customerEntityType === "corporate" ? "corporate" : "individual",
        installationFinancer || null, installationContactName || null, installationContactPhone || null,
        installationCounty || null, locationDescription || null, bankPartnerName || null,
        user.id, now, now,
      ]
    );

    // Save vehicle details if provided
    if (vehicle) {
      await pgRun(
        `INSERT INTO retail_lead_vehicles
           (id, lead_id, registration_known, registration, chassis_no,
            make, model, year, color, engine_no, vehicle_id, vehicle_category, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          uuidv4(), id,
          vehicle.registrationKnown ? 1 : 0,
          vehicle.registration  || null,
          vehicle.chassisNo     || null,
          vehicle.make          || null,
          vehicle.model         || null,
          vehicle.year          || null,
          vehicle.color         || null,
          vehicle.engineNo      || null,
          vehicle.vehicleId     || null,
          vehicle.vehicleCategory || "motor_vehicle",
          now, now,
        ]
      );
      // Save loan term on vehicle row
      if (vehicle.loanTermMonths != null) {
        await pgRun(
          `UPDATE retail_lead_vehicles SET loan_term_months = ? WHERE lead_id = ?`,
          [Number(vehicle.loanTermMonths) || 0, id]
        ).catch(() => {});
      }
    }

    await auditLog(req, "RETAIL_LEAD_CREATED", `retail_lead:${id}`, "Info", { leadNo, customerName, leadSource });

    const newLead = await pgGet(`SELECT * FROM retail_leads WHERE id = ?`, [id]);
    const newVehicle = vehicle ? await pgGet(`SELECT * FROM retail_lead_vehicles WHERE lead_id = ?`, [id]) : null;
    return created(res, { lead: mapLead(newLead, newVehicle) });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id  – update lead fields
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  "/:id",
  requireAuth,
  requireRole(["Sales", "Admin", "BDM", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet(
      `SELECT * FROM retail_leads WHERE id = ? AND deleted_at IS NULL`, [req.params.id]
    );
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Retail lead not found.");

    const phoneFields: Record<string, string> = {
      customer_phone: "Customer phone number",
      referrer_phone: "Referrer phone number",
      installation_contact_phone: "Installation contact phone number",
    };
    for (const [field, label] of Object.entries(phoneFields)) {
      const val = req.body[field];
      if (typeof val === "string" && val.trim() && !isValidKePhone(val)) {
        return errorResponse(res, 400, "VALIDATION_ERROR", `${label} is not a valid Kenyan mobile number (e.g. 0712 345678 or +254712345678).`);
      }
    }
    if (typeof req.body.customer_email === "string" && req.body.customer_email.trim() && !isValidEmail(req.body.customer_email)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Customer email address is not valid.");
    }

    const allowed = [
      "customer_type","lead_source","partner_id","partner_name",
      "secondary_partner_id","secondary_partner_name",
      "referrer_name","referrer_phone",
      "service_interest","service_other","product_id","product_name",
      "customer_id","customer_name","customer_phone","customer_email","customer_location","customer_notes","customer_entity_type",
      "status","bdm_id","bdm_name",
      "installation_financer","installation_contact_name","installation_contact_phone",
      "installation_county","location_description","bank_partner_name",
    ];

    const updates: string[] = [];
    const values: any[]     = [];

    for (const field of allowed) {
      if (field in req.body) {
        updates.push(`${field} = ?`);
        let val = req.body[field];
        if (field === "service_interest" && Array.isArray(val)) val = JSON.stringify(val);
        values.push(val ?? null);
      }
    }

    if (!updates.length) return ok(res, { lead: mapLead(lead) });

    const now = new Date().toISOString();
    updates.push("updated_at = ?");
    values.push(now, req.params.id);

    await pgRun(`UPDATE retail_leads SET ${updates.join(", ")} WHERE id = ?`, values);

    // Update or upsert vehicle if provided
    if (req.body.vehicle) {
      const v = req.body.vehicle;
      const existing = await pgGet(`SELECT id FROM retail_lead_vehicles WHERE lead_id = ?`, [req.params.id]);
      if (existing) {
        await pgRun(
          `UPDATE retail_lead_vehicles SET
             registration_known=?, registration=?, chassis_no=?,
             make=?, model=?, year=?, color=?, engine_no=?, vehicle_id=?, vehicle_category=?, updated_at=?
           WHERE lead_id=?`,
          [v.registrationKnown ? 1 : 0, v.registration||null, v.chassisNo||null,
           v.make||null, v.model||null, v.year||null, v.color||null, v.engineNo||null,
           v.vehicleId||null, v.vehicleCategory||"motor_vehicle", now, req.params.id]
        );
      } else {
        await pgRun(
          `INSERT INTO retail_lead_vehicles
             (id, lead_id, registration_known, registration, chassis_no,
              make, model, year, color, engine_no, vehicle_id, vehicle_category, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [uuidv4(), req.params.id, v.registrationKnown?1:0,
           v.registration||null,v.chassisNo||null,v.make||null,v.model||null,
           v.year||null,v.color||null,v.engineNo||null,v.vehicleId||null,
           v.vehicleCategory||"motor_vehicle",now,now]
        );
      }
    }

    const updated = await pgGet(`SELECT * FROM retail_leads WHERE id = ?`, [req.params.id]);
    const updVeh  = await pgGet(`SELECT * FROM retail_lead_vehicles WHERE lead_id = ?`, [req.params.id]).catch(() => null);
    return ok(res, { lead: mapLead(updated, updVeh) });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/submit  – finalise lead → create installation ticket → notify
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/submit",
  requireAuth,
  requireRole(["Sales", "Admin", "BDM", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet(
      `SELECT * FROM retail_leads WHERE id = ? AND deleted_at IS NULL`, [req.params.id]
    );
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Retail lead not found.");
    if (lead.submitted_at) return errorResponse(res, 409, "ALREADY_SUBMITTED", "This lead has already been submitted.");

    const vehicle = await pgGet(`SELECT * FROM retail_lead_vehicles WHERE lead_id = ?`, [req.params.id]).catch(() => null);
    const user    = req.user!;
    const now     = new Date().toISOString();

    // ── Validate required fields before submission ───────────────────────────
    if (!lead.customer_name?.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "Customer name is required before submission.");
    // Individual customers auto-created below require a phone number
    // (crm_individual_profiles.phone_enc is NOT NULL) — check this up front so
    // the failure is a clear, actionable message instead of a raw DB error.
    if (!lead.customer_id && lead.customer_entity_type !== "corporate" && !lead.customer_phone?.trim()) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Customer phone number is required before submission. Click \"Edit\" above to add it.");
    }
    // Format, not just presence — a garbled number (stray letter, wrong digit
    // count) would otherwise sail through and silently fail SMS/notification
    // delivery later with no clear error pointing back at this lead.
    if (lead.customer_phone?.trim() && !isValidKePhone(lead.customer_phone)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Customer phone number is not a valid Kenyan mobile number. Click \"Edit\" above to fix it.");
    }
    if (lead.customer_email?.trim() && !isValidEmail(lead.customer_email)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Customer email address is not valid. Click \"Edit\" above to fix it.");
    }
    // Installation location and on-site contact are mandatory before a lead can
    // become an installation ticket — the technician needs these to do the job.
    if (!req.body.locationName?.trim()) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Location / Partner Yard Name is required before submission.");
    }
    if (!lead.installation_contact_name?.trim()) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Installation Contact Name is required before submission.");
    }
    if (!lead.installation_contact_phone?.trim()) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Installation Contact Phone is required before submission.");
    }
    if (!isValidKePhone(lead.installation_contact_phone)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Installation Contact Phone is not a valid Kenyan mobile number.");
    }

    const locationName  = req.body.locationName  || null;
    const locationNotes = req.body.locationNotes || null;

    // ── Generate retail installation ticket ─────────────────────────────────
    const ticketId = uuidv4();
    const ticketNo = nextRetailTicketNo();

    const ticketNotes = [
      locationName  ? `Location: ${locationName}` : null,
      locationNotes ? `Instructions: ${locationNotes}` : null,
      lead.customer_notes ? `Customer notes: ${lead.customer_notes}` : null,
    ].filter(Boolean).join("\n");

    const installLocation = [
      lead.installation_county,
      lead.location_description,
    ].filter(Boolean).join(" — ") || locationName || null;

    // Carry the lead's captured vehicle data into the ticket's own vehicleDetails
    // blob (same shape job-card.html's Stage 1 reads/writes) so the job card
    // pre-fills accurately from day one, including the Registered/Not
    // Registered state — not just whatever crm_customer_vehicles ends up with.
    const vehicleDetailsJson = vehicle ? JSON.stringify({
      registration: vehicle.registration || "",
      regStatus: vehicle.registration_known ? "registered" : "not_registered",
      make: vehicle.make || "",
      model: vehicle.model || "",
      colour: vehicle.color || "",
      year: vehicle.year || "",
      vin: vehicle.chassis_no || "",
      engineNo: vehicle.engine_no || "",
      vehicleCategory: vehicle.vehicle_category || "motor_vehicle",
    }) : null;

    await pgRun(
      `INSERT INTO installation_tickets
         (id, ticket_no, customer_id, customer_name, vehicle_id, vehicle_registration, vehicle_details_json,
          notes, devices_json, status, stage, created_by_user_id, created_at, updated_at,
          retail_lead_id, installation_location, installation_contact_name, installation_contact_phone,
          sales_notes, installation_financer)
       VALUES (?,?,?,?,?,?,?,?, '[]', 'Pending', 0, ?,?,?,?,?,?,?,?,?)`,
      [
        ticketId, ticketNo,
        lead.customer_id || null, lead.customer_name,
        vehicle?.vehicle_id || null, vehicle?.registration || null, vehicleDetailsJson,
        ticketNotes || null,
        user.id, now, now,
        lead.id,
        installLocation,
        lead.installation_contact_name || null,
        lead.installation_contact_phone || null,
        lead.customer_notes || null,
        lead.installation_financer || null,
      ]
    );

    // ── Auto-create CRM customer if lead has no existing customer_id ────────
    // This runs unattended as a side effect of submitting a lead — there's no
    // human present to resolve a conflict, so unlike the interactive "Add
    // Customer" form (crm-customers.ts POST /register), a name+phone or
    // name+email match here silently links to the EXISTING customer instead
    // of creating a new one, rather than blocking the submission.
    let resolvedCustomerId = lead.customer_id || null;
    if (!resolvedCustomerId && lead.customer_name?.trim()) {
      const dupMatches = await findDuplicateCustomers({
        name: lead.customer_name, phone: lead.customer_phone, email: lead.customer_email,
      });
      if (dupMatches.length) {
        resolvedCustomerId = dupMatches[0].customerId;
        await pgRun(`UPDATE retail_leads SET customer_id=?, updated_at=? WHERE id=?`, [resolvedCustomerId, now, lead.id]);
        await pgRun(`UPDATE installation_tickets SET customer_id=?, updated_at=? WHERE id=?`, [resolvedCustomerId, now, ticketId]);
        await auditLog(req, "RETAIL_LEAD_CUSTOMER_AUTOLINKED", `retail_lead:${lead.id}`, "Info", {
          customerId: resolvedCustomerId, matchedOn: dupMatches[0].matchedOn,
        }).catch(console.error);
      }
    }
    if (!resolvedCustomerId && lead.customer_name?.trim()) {
      const newCustId    = uuidv4();
      const accountNo    = IdGenerator.generateId("customer");
      const entityType   = lead.customer_entity_type === "corporate" ? "corporate" : "individual";
      await pgRun(
        `INSERT INTO crm_customers
           (id, account_no, type, status, segment, account_manager_id, region, source,
            affiliate_partner_id, affiliate_partner_name,
            created_by_user_id, created_at, updated_at)
         VALUES (?,?,?,'Active','Retail',?,?,?,?,?,?,?,?)`,
        [newCustId, accountNo, entityType,
         lead.bdm_id || user.id, null, lead.lead_source || null,
         lead.partner_id || null, lead.partner_name || null,
         user.id, now, now]
      );
      if (entityType === "corporate") {
        await pgRun(
          `INSERT INTO crm_corporate_profiles
             (id, customer_id, company_name, reg_number_enc, kra_pin_enc, industry, physical_address, website, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [uuidv4(), newCustId,
           lead.customer_name.trim(),
           encryptField(null), encryptField(null),
           null, null, null, now, now]
        );
        // Create primary contact person with phone/email from the lead form
        if (lead.customer_phone?.trim() || lead.customer_email?.trim()) {
          await pgRun(
            `INSERT INTO crm_contact_persons
               (id, customer_id, name, role_label, phone_enc, email_enc, is_primary, is_billing, is_operations, created_at, updated_at)
             VALUES (?,?,?,?,?,?,1,1,0,?,?)`,
            [uuidv4(), newCustId,
             lead.customer_name.trim(),
             "Primary Contact",
             encryptField(lead.customer_phone?.trim() || null),
             encryptField(lead.customer_email?.trim() || null),
             now, now]
          );
        }
      } else {
        await pgRun(
          `INSERT INTO crm_individual_profiles
             (id, customer_id, full_name, full_name_enc, phone_enc, email_enc,
              national_id_enc, passport_no_enc, kra_pin_enc, address_enc, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [uuidv4(), newCustId,
           lead.customer_name.trim(),
           encryptField(lead.customer_name.trim()),
           encryptField(lead.customer_phone?.trim() || null),
           encryptField(lead.customer_email?.trim() || null),
           encryptField(null), encryptField(null), encryptField(null), encryptField(null),
           now, now]
        );
      }
      resolvedCustomerId = newCustId;
      await pgRun(
        `UPDATE retail_leads SET customer_id=?, updated_at=? WHERE id=?`,
        [newCustId, now, lead.id]
      );
      await pgRun(
        `UPDATE installation_tickets SET customer_id=?, updated_at=? WHERE id=?`,
        [newCustId, now, ticketId]
      );
      invalidateCustomerCaches();
    }

    // ── Create vi_installations record so the ticket appears in the Technical
    // Pipeline. Placed immediately after customer resolution (rather than
    // after the partner-sync/vehicle-creation steps below) and wrapped in its
    // own try/catch so it only depends on work that has already succeeded —
    // an unrelated failure further down previously left tickets permanently
    // orphaned from the pipeline with no way to retry. vehicle_id is
    // backfilled below once/if a new vehicle record is created.
    let viId: string | null = null;
    if (resolvedCustomerId) {
      try {
        viId = uuidv4();
        await pgRun(
          `INSERT INTO vi_installations
             (id, vehicle_id, customer_id, ticket_ref, status, stage,
              created_by_user_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [viId, vehicle?.vehicle_id || null, resolvedCustomerId, ticketNo,
           'Pending', 0, user.id, now, now]
        );
        await pgRun(
          `UPDATE installation_tickets SET vi_installation_id=?, updated_at=? WHERE id=?`,
          [viId, now, ticketId]
        );
      } catch (err) {
        viId = null;
        console.error(`[retail-leads submit] vi_installations creation failed for ticket ${ticketNo}:`, err);
      }
    }

    // ── Sync lead partner to customer if customer has no partner set yet ────────
    if (resolvedCustomerId && lead.partner_id) {
      await pgRun(
        `UPDATE crm_customers SET affiliate_partner_id=?, affiliate_partner_name=?, updated_at=?
         WHERE id=? AND (affiliate_partner_id IS NULL OR affiliate_partner_id='')`,
        [lead.partner_id, lead.partner_name || null, now, resolvedCustomerId]
      );
    }

    // ── Create/resolve crm_customer_vehicles record ──────────────────────────
    let resolvedVehicleId = vehicle?.vehicle_id || null;
    if (vehicle && resolvedCustomerId) {
      if (!resolvedVehicleId) {
        // No existing vehicle record — create one in crm_customer_vehicles.
        // registration stays NULL (not backfilled with the chassis number —
        // that conflated the two fields and defeated any later "is this
        // vehicle actually registered?" check) when the lead captured it as
        // not-yet-registered; registration_known carries that state instead.
        const newVehicleId = uuidv4();
        const isRegistered = !!vehicle.registration_known;
        await pgRun(
          `INSERT INTO crm_customer_vehicles
             (id, customer_id, registration, registration_known, make, model, color, year_of_manufacture,
              chassis_number, engine_number, loan_tenure_months, partner_id, vehicle_category, created_by_user_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            newVehicleId, resolvedCustomerId,
            isRegistered ? (vehicle.registration?.trim() || null) : null,
            isRegistered,
            vehicle.make || null, vehicle.model || null,
            vehicle.color || null,
            vehicle.year ? parseInt(vehicle.year, 10) || null : null,
            vehicle.chassis_no || null, vehicle.engine_no || null,
            vehicle.loanTermMonths != null ? Number(vehicle.loanTermMonths) || null : null,
            lead.partner_id || null,
            vehicle.vehicle_category || "motor_vehicle",
            user.id, now, now,
          ]
        );
        resolvedVehicleId = newVehicleId;
        // Back-fill vehicle_id on the retail_lead_vehicles row
        await pgRun(
          `UPDATE retail_lead_vehicles SET vehicle_id=? WHERE lead_id=?`,
          [newVehicleId, lead.id]
        );
        // Update the installation ticket with the real vehicle id
        await pgRun(
          `UPDATE installation_tickets SET vehicle_id=?, updated_at=? WHERE id=?`,
          [newVehicleId, now, ticketId]
        );
        if (viId) {
          await pgRun(`UPDATE vi_installations SET vehicle_id=?, updated_at=? WHERE id=?`, [newVehicleId, now, viId]);
        }
      } else {
        // Vehicle already exists — ensure customer_id is correct and update loan tenure if provided
        const loanMonths = vehicle.loanTermMonths != null ? Number(vehicle.loanTermMonths) || null : null;
        await pgRun(
          `UPDATE crm_customer_vehicles
           SET customer_id=?, loan_tenure_months=COALESCE(?,loan_tenure_months),
               vehicle_category=COALESCE(?,vehicle_category), updated_at=?
           WHERE id=?`,
          [resolvedCustomerId, loanMonths, vehicle.vehicle_category || null, now, resolvedVehicleId]
        );
      }
    }

    // ── Mark lead as submitted ───────────────────────────────────────────────
    await pgRun(
      `UPDATE retail_leads SET status='Submitted', submitted_at=?, installation_ticket_id=?,
       installation_ticket_no=?, updated_at=? WHERE id=?`,
      [now, ticketId, ticketNo, now, lead.id]
    );

    await auditLog(req, "RETAIL_LEAD_SUBMITTED", `retail_lead:${lead.id}`, "Info", { ticketNo, status: "Submitted" });

    // ── Bank-financed auto-quote — fire-and-forget, must never block submission ──
    materializeBankFinancedQuoteForLead(lead.id, { userId: user.id, email: user.email })
      .then((r) => { if (r) console.log(`[bankFinancedQuoteAuto] Created ${r.quoteNo} for lead ${lead.lead_no}.`); })
      .catch((e: any) => console.error("[bankFinancedQuoteAuto] failed (non-fatal):", e?.message));

    // ── Notifications ────────────────────────────────────────────────────────
    const devNote = isDevMode() ? " [DEV MODE — redirected]" : "";

    // Bell notifications
    await createNotification({ targetRole: "Technical",    type: "info",    title: `New Retail Job: ${ticketNo}`, body: `Customer: ${lead.customer_name}`, link: `installation-ticket.html?id=${ticketId}` });
    await createNotification({ targetRole: "InstallOffice", type: "info",   title: `New Retail Job: ${ticketNo}`, body: `Customer: ${lead.customer_name}`, link: `installation-ticket.html?id=${ticketId}` });
    await createNotification({ targetRole: "Admin",         type: "info",   title: `New Retail Job: ${ticketNo}`, body: `Customer: ${lead.customer_name} | ${lead.lead_no}`, link: `installation-ticket.html?id=${ticketId}` });
    await createNotification({ targetRole: "Finance",       type: "info",    title: `New Retail Lead Submitted: ${lead.lead_no}`, body: `Customer: ${lead.customer_name} | Ticket: ${ticketNo}`, link: `retail-lead-detail.html?id=${lead.id}` });
    await createNotification({ targetRole: "BDM",           type: "info",    title: `New Retail Lead: ${lead.lead_no}`, body: `By ${user.email} — Customer: ${lead.customer_name}`,  link: `retail-lead-detail.html?id=${lead.id}` });
    if (lead.sales_rep_id !== user.id) {
      await createNotification({ targetUserId: lead.sales_rep_id, type: "success", title: `Lead ${lead.lead_no} submitted`, body: `Ticket ${ticketNo} created and pushed to pipeline.`, link: `retail-lead-detail.html?id=${lead.id}` });
    }

    // Email notifications (via Graph)
    if (isGraphConfigured()) {
      const subject = `[Retail] New Installation Job: ${ticketNo} – ${lead.customer_name}`;
      const body    = `
        <p>A new retail lead has been submitted and an installation ticket created.</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Lead #</td><td>${lead.lead_no}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Ticket #</td><td>${ticketNo}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Customer</td><td>${lead.customer_name}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Phone</td><td>${lead.customer_phone || "—"}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Vehicle</td><td>${vehicle?.registration || vehicle?.chassis_no || "Not specified"}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Lead Source</td><td>${lead.lead_source}${lead.partner_name ? " — "+lead.partner_name : ""}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Location</td><td>${locationName || "—"}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Submitted by</td><td>${user.email}</td></tr>
        </table>
        ${devNote ? `<p style="color:orange;font-style:italic">DEV MODE — original recipient replaced.</p>` : ""}
      `;

      // Notify ISOs / InstallOffice via notification mailbox
      sendEmailViaGraph({ fromMailbox: MAILBOXES.notification, to: notifyEmail(MAILBOXES.notification), subject, htmlBody: body })
        .catch(e => console.error("[retail] email ISO:", e));

      // Notify BDM if assigned
      if (lead.bdm_id) {
        const bdmUser = await pgGet(`SELECT email FROM users WHERE id=?`, [lead.bdm_id]).catch(() => null);
        if (bdmUser?.email) {
          sendEmailViaGraph({ fromMailbox: MAILBOXES.notification, to: notifyEmail(bdmUser.email), subject: `[Retail] New Lead Submitted: ${lead.lead_no}`, htmlBody: body })
            .catch(e => console.error("[retail] email BDM:", e));
        }
      }
    }

    // SMS / WhatsApp to sales rep
    const salesRep = await pgGet(`SELECT phone, name FROM users WHERE id=?`, [lead.sales_rep_id]).catch(() => null);
    const smsText  = `Finemark: Your retail lead ${lead.lead_no} (${lead.customer_name}) has been submitted. Ticket ${ticketNo} created.`;

    if (salesRep?.phone) {
      if (isAtConfigured()) {
        sendSms([salesRep.phone], isDevMode() ? `[DEV→${salesRep.phone}] ${smsText}` : smsText)
          .catch(e => console.error("[retail] SMS:", e));
      } else if (isTwilioConfigured()) {
        sendWhatsApp(salesRep.phone, isDevMode() ? `[DEV→${salesRep.phone}] ${smsText}` : smsText)
          .catch(e => console.error("[retail] WhatsApp:", e));
      }
    }

    const updated = await pgGet(`SELECT * FROM retail_leads WHERE id=?`, [lead.id]);
    return ok(res, {
      lead:           mapLead(updated, vehicle),
      ticketId,
      ticketNo,
      message:        `Lead submitted. Installation ticket ${ticketNo} created and pushed to pipeline.`,
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/close  – mark a lead Completed once its linked installation
// ticket is actually done. This is the correlation the generic PATCH /:id
// (which lets "status" be set to anything) doesn't enforce — closing a lead
// must go through here so the server itself verifies the ticket is Completed
// rather than trusting the client to only offer the button at the right time.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/close",
  requireAuth,
  requireRole(["Sales", "Admin", "BDM", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet(
      `SELECT * FROM retail_leads WHERE id = ? AND deleted_at IS NULL`, [req.params.id]
    );
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Retail lead not found.");
    if (lead.status === "cancelled") {
      return errorResponse(res, 409, "INVALID_STATE", "Cancelled leads cannot be closed.");
    }
    if (lead.status === "Completed") {
      return errorResponse(res, 409, "ALREADY_CLOSED", "This lead is already closed.");
    }
    if (!lead.installation_ticket_id) {
      return errorResponse(res, 409, "NO_TICKET", "This lead has no installation ticket yet — it can't be closed until one exists and is completed.");
    }

    const ticket = await pgGet<{ status: string }>(`SELECT status FROM installation_tickets WHERE id = ?`, [lead.installation_ticket_id]);
    if (!ticket || ticket.status !== "Completed") {
      return errorResponse(
        res, 409, "TICKET_NOT_COMPLETE",
        `The installation ticket ${lead.installation_ticket_no || ""} must be Completed before this lead can be closed (current status: ${ticket?.status || "unknown"}).`
      );
    }

    const now = new Date().toISOString();
    await pgRun(`UPDATE retail_leads SET status='Completed', updated_at=? WHERE id=?`, [now, req.params.id]);
    await auditLog(req, "RETAIL_LEAD_CLOSED", `retail_lead:${lead.id}`, "Info", { installationTicketId: lead.installation_ticket_id });

    const updated = await pgGet(`SELECT * FROM retail_leads WHERE id=?`, [lead.id]);
    const vehicle = await pgGet(`SELECT * FROM retail_lead_vehicles WHERE lead_id = ?`, [req.params.id]).catch(() => null);
    return ok(res, { lead: mapLead(updated, vehicle, ticket), message: "Lead closed." });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/raise-quote  – manual trigger for a closed lead that never got its
// auto-quote (normally materializeRetailQuoteForTicket() fires automatically
// when a technician assigns a device to the installation ticket — see
// installation-tickets.ts). This is the same real, idempotent, properly-priced
// quote+proforma logic, just invoked by a sales rep as a catch-up for the
// edge cases the ticket-status code itself already accounts for (a ticket
// that got a device before this automation existed, or one whose device
// assignment somehow didn't fire the automation).
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/:id/raise-quote",
  requireAuth,
  requireRole(["Sales", "Admin", "BDM", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet(
      `SELECT * FROM retail_leads WHERE id = ? AND deleted_at IS NULL`, [req.params.id]
    );
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Retail lead not found.");
    if (lead.status === "cancelled") {
      return errorResponse(res, 409, "INVALID_STATE", "Cancelled leads can't be quoted.");
    }
    if (lead.quote_id) {
      return errorResponse(res, 409, "ALREADY_QUOTED", "A quotation has already been raised for this lead.");
    }
    if (!lead.installation_ticket_id) {
      return errorResponse(res, 409, "NO_TICKET", "This lead has no installation ticket — it can't be quoted.");
    }
    // Gated on the ticket's own completion, not lead.status — a lead can be
    // quote-eligible before anyone has explicitly clicked "Close Lead" on it.
    const linkedTicket = await pgGet<{ status: string }>(`SELECT status FROM installation_tickets WHERE id = ?`, [lead.installation_ticket_id]);
    if (!linkedTicket || linkedTicket.status !== "Completed") {
      return errorResponse(res, 409, "INVALID_STATE", `The installation ticket must be Completed before this lead can be quoted (current status: ${linkedTicket?.status || "unknown"}).`);
    }

    try {
      const result = await materializeRetailQuoteForTicket(lead.installation_ticket_id, { userId: req.user!.id, email: req.user!.email });
      await auditLog(req, "RETAIL_LEAD_QUOTE_RAISED", `retail_lead:${lead.id}`, "Info", { quoteId: result.quoteId, quoteNo: result.quoteNo, pricingMissing: result.pricingMissing });
      return created(res, { quoteId: result.quoteId, quoteNo: result.quoteNo, pricingMissing: result.pricingMissing }, result.pricingMissing ? "Quotation raised — partner pricing wasn't found, items are at KES 0 pending Finance." : "Quotation raised.");
    } catch (e: any) {
      return errorResponse(res, 409, "QUOTE_GENERATION_FAILED", e?.message || "Failed to generate quotation for this lead's ticket.");
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id  – soft delete
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAuth,
  requireRole(["Admin", "BDM"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet(
      `SELECT id FROM retail_leads WHERE id = ? AND deleted_at IS NULL`, [req.params.id]
    );
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Retail lead not found.");

    const now = new Date().toISOString();
    await pgRun(`UPDATE retail_leads SET deleted_at=?, updated_at=? WHERE id=?`, [now, now, req.params.id]);
    return ok(res, { message: "Deleted." });
  }
);

// ── GET /:id/documents ─────────────────────────────────────────────────────────
router.get(
  "/:id/documents",
  requireAuth,
  async (req: AuthRequest, res) => {
    const lead = await pgGet(`SELECT id FROM retail_leads WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    const rows = await pgAll(
      `SELECT * FROM retail_lead_documents WHERE lead_id = ? ORDER BY created_at ASC`,
      [req.params.id]
    );
    return ok(res, {
      data: rows.map((r: any) => ({
        id: r.id,
        leadId: r.lead_id,
        docType: r.doc_type,
        label: r.label,
        status: r.status,
        notes: r.notes,
        fileName: r.file_name,
        filePath: r.file_path,
        fileSize: r.file_size,
        mimeType: r.mime_type,
        uploadedBy: r.uploaded_by,
        createdAt: r.created_at,
      })),
    });
  }
);

// ── POST /:id/documents ────────────────────────────────────────────────────────
router.post(
  "/:id/documents",
  requireAuth,
  docUpload.single("file") as any,
  async (req: AuthRequest, res) => {
    const lead = await pgGet(`SELECT id FROM retail_leads WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");

    const { docType, label, notes, status } = req.body;
    if (!docType?.trim() || !label?.trim())
      return errorResponse(res, 400, "VALIDATION_ERROR", "docType and label are required");

    const file = req.file as Express.Multer.File | undefined;
    const id   = uuidv4();
    const now  = new Date().toISOString();
    const docStatus = file ? "attached" : (status?.trim() || "collected");

    await pgRun(
      `INSERT INTO retail_lead_documents
         (id, lead_id, doc_type, label, status, notes, file_name, file_path, file_size, mime_type, uploaded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, req.params.id, docType.trim(), label.trim(), docStatus,
        notes?.trim() || null,
        file?.originalname || null,
        file ? `/uploads/lead-attachments/${file.filename}` : null,
        file?.size || null,
        file?.mimetype || null,
        req.user!.email, now, now,
      ]
    );

    auditLog(req, "LEAD_DOCUMENT_UPLOADED", `retail_lead:${req.params.id}`, "Info", { docType, label }).catch(console.error);
    const row = await pgGet("SELECT * FROM retail_lead_documents WHERE id = ?", [id]);
    return created(res, { data: row }, "Document recorded");
  }
);

export default router;
