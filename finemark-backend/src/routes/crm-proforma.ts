import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, hasCrmFullVisibility, userCanAccessRecord, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { decryptField } from "../services/cryptoService.js";
import { sendEmailViaGraph, MAILBOXES, isGraphConfigured } from "../services/graphMailService.js";
import { sendMail } from "../utils/mailer.js";
import { createNotification } from "./notifications.js";
import { buildProformaEmail } from "../utils/emailTemplates.js";
import { renderQuotePdf } from "../utils/quoteTemplate.js";
import { createInvoice } from "../services/invoiceService.js";
import { IdGenerator } from "../utils/idGenerator.js";

const router = Router();

// ── Table bootstrap ──────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_proforma_invoices (
    id TEXT PRIMARY KEY,
    proforma_no TEXT UNIQUE NOT NULL,
    customer_id TEXT NOT NULL,
    quote_id TEXT,
    lead_id TEXT,
    sales_rep_id TEXT,
    status TEXT NOT NULL DEFAULT 'Draft',
    installation_cost REAL NOT NULL DEFAULT 0,
    subscription_fee REAL NOT NULL DEFAULT 0,
    tax_rate REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    notes TEXT,
    approved_by TEXT,
    approved_at TEXT,
    rejected_by TEXT,
    rejected_at TEXT,
    rejected_reason TEXT,
    converted_to_installation_id TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[crm_proforma_invoices] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS crm_proforma_items (
    id TEXT PRIMARY KEY,
    proforma_id TEXT NOT NULL,
    device_model TEXT NOT NULL,
    device_type TEXT,
    description TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    total_price REAL NOT NULL DEFAULT 0,
    stock_item_id TEXT,
    created_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_proforma_items] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_pf_customer ON crm_proforma_invoices(customer_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_pf_items ON crm_proforma_items(proforma_id)`, []).catch(() => {});
// Allow vi_installations to be created without a vehicle (vehicle known later)
pgRun(`ALTER TABLE vi_installations ALTER COLUMN vehicle_id DROP NOT NULL`, []).catch(() => {});
// ETR/eTIMS receipt number on invoices (optional)
pgRun(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etr_receipt_no TEXT`, []).catch(() => {});
// Link invoice back to proforma
pgRun(`ALTER TABLE crm_proforma_invoices ADD COLUMN IF NOT EXISTS invoice_id TEXT`, []).catch(() => {});
// Retail auto-proforma columns
pgRun(`ALTER TABLE crm_proforma_invoices ADD COLUMN IF NOT EXISTS installation_ticket_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE crm_proforma_invoices ADD COLUMN IF NOT EXISTS auto_generated INTEGER NOT NULL DEFAULT 0`, []).catch(() => {});
pgRun(`ALTER TABLE crm_proforma_invoices ADD COLUMN IF NOT EXISTS pricing_missing INTEGER NOT NULL DEFAULT 0`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_pf_install_ticket ON crm_proforma_invoices(installation_ticket_id)`, []).catch(() => {});

// ── Customer approval columns ─────────────────────────────────────────────────
pgRun(`ALTER TABLE crm_proforma_invoices ADD COLUMN IF NOT EXISTS customer_approved_at TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE crm_proforma_invoices ADD COLUMN IF NOT EXISTS customer_approval_method TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE crm_proforma_invoices ADD COLUMN IF NOT EXISTS approval_method TEXT`, []).catch(() => {});

// ── One-time customer approval tokens ────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_proforma_approval_tokens (
    id TEXT PRIMARY KEY,
    proforma_id TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    customer_ip TEXT,
    created_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_proforma_approval_tokens] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_pf_tokens_proforma ON crm_proforma_approval_tokens(proforma_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_pf_tokens_hash ON crm_proforma_approval_tokens(token_hash)`, []).catch(() => {});

const PORTAL_BASE = (process.env.FRONTEND_URL || "https://portal.finemarktracking.co.ke").replace(/\/$/, "");

async function buildPaymentOptions(
  partnerName: string | null,
  vehicleReg: string | null,
): Promise<Array<{ label: string; value: string }>> {
  const reg = (vehicleReg || "").trim() || "(Vehicle Reg.)";
  const opts: Array<{ label: string; value: string }> = [
    { label: "MPESA PAYBILL",     value: `Paybill: 4048569 | Account: ${reg}` },
    { label: "MPESA TILL NUMBER", value: "Till: 5620852" },
  ];
  if (partnerName) {
    const key = partnerName.trim().split(/\s+/)[0];
    if (key) {
      const bankRow = await pgGet(
        `SELECT account_name, bank_name, account_number FROM bank_accounts
         WHERE is_active = true AND LOWER(bank_name) LIKE LOWER(?) ORDER BY created_at LIMIT 1`,
        [`%${key}%`]
      ).catch(() => null);
      if (bankRow) {
        opts.push({
          label: bankRow.bank_name
            ? `${bankRow.bank_name} — ${bankRow.account_name}`
            : bankRow.account_name,
          value: String(bankRow.account_number),
        });
      }
    }
  }
  return opts;
}

function nextPfNo(): string {
  return IdGenerator.generateId("proforma");
}

// ── ABAC: row-level ownership check ──────────────────────────────────────────
// Full-visibility roles bypass; KAM is scoped via the linked quote's partner
// account manager; everyone else must be the assigned rep or the creator.
async function assertProformaAccess(role: string, userId: string, pf: any): Promise<boolean> {
  if (hasCrmFullVisibility(role)) return true;
  let kamId: string | null = null;
  if (pf.quote_id) {
    const quote = await pgGet(`SELECT partner_id FROM crm_quotes WHERE id = ?`, [pf.quote_id]).catch(() => null);
    if (quote?.partner_id) {
      const partner = await pgGet(`SELECT key_account_manager_id FROM partners WHERE id::text = ?`, [String(quote.partner_id)]);
      kamId = partner?.key_account_manager_id ?? null;
    }
  }
  return userCanAccessRecord({
    role,
    userId,
    recordOwnerId: pf.sales_rep_id,
    recordCreatorId: pf.created_by_user_id,
    kamId,
  });
}

async function getItems(pfId: string) {
  return pgAll(`SELECT * FROM crm_proforma_items WHERE proforma_id = ? ORDER BY created_at`, [pfId]);
}

/**
 * Single source of truth for the proforma PDF: the same bytes are used for
 * "View PDF" (GET /:id/pdf) and the emailed attachment (POST /:id/send).
 * Keeping this in one place means those two can never silently drift apart —
 * previously each route independently re-queried and re-built the payload,
 * which was a duplication risk (e.g. one route getting a field-mapping fix
 * the other didn't).
 */
async function buildProformaPdf(pfId: string): Promise<{ pf: any; items: any[]; pdfBytes: Uint8Array } | null> {
  const pf = await pgGet(
    `SELECT p.*, COALESCE(i.full_name, corp.company_name) AS customer_name,
            i.email_enc AS customer_email_enc,
            COALESCE(i.kra_pin_enc, corp.kra_pin_enc) AS customer_kra_pin_enc,
            i.phone_enc AS ind_phone_enc,
            i.email_enc AS ind_email_enc,
            i.address_enc AS ind_address_enc,
            corp.physical_address AS corp_address,
            (SELECT cp.phone_enc FROM crm_contact_persons cp WHERE cp.customer_id = c.id ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) AS corp_contact_phone_enc,
            (SELECT cp.email_enc FROM crm_contact_persons cp WHERE cp.customer_id = c.id ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) AS corp_contact_email_enc,
            c.type AS customer_type,
            u.name AS sales_rep_name, u.email AS sales_rep_email,
            q.expiry_date AS quote_expiry_date,
            v.make AS vehicle_make, v.model AS vehicle_model,
            v.registration AS vehicle_reg_from_db,
            c.affiliate_partner_name
     FROM crm_proforma_invoices p
     JOIN crm_customers c ON c.id = p.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     LEFT JOIN users u ON u.id::text = p.sales_rep_id
     LEFT JOIN crm_quotes q ON q.id = p.quote_id
     LEFT JOIN crm_customer_vehicles v ON v.id = COALESCE(p.vehicle_id, q.vehicle_id)
     WHERE p.id = ? AND p.deleted_at IS NULL`,
    [pfId]
  );
  if (!pf) return null;

  // Decrypt customer contact details
  const customerKraPin = decryptField(pf.customer_kra_pin_enc) || null;
  const customerPhone = decryptField(pf.customer_type === 'individual' ? pf.ind_phone_enc : pf.corp_contact_phone_enc) || null;
  const customerEmail = decryptField(pf.customer_type === 'individual' ? pf.ind_email_enc : pf.corp_contact_email_enc) || null;
  const customerAddress = pf.customer_type === 'individual'
    ? (decryptField(pf.ind_address_enc) || null)
    : (pf.corp_address || null);

  // ── Fetch installation ticket data for detail rows ───────────────────────
  let salesRepName: string | null = null;
  let technicianName: string | null = null;
  let jobCardNo: string | null = null;
  let jobCardStatus: string | null = null;
  let installDate: string | null = null;
  let installTime: string | null = null;
  if (pf.installation_ticket_id) {
    const it = await pgGet(
      "SELECT ticket_no, status, assigned_to_email, technician_signed_off_at, engineer_signed_off_at, assigned_at, retail_lead_id FROM installation_tickets WHERE id = ? AND deleted_at IS NULL",
      [pf.installation_ticket_id]
    ).catch(() => null);
    if (it) {
      jobCardNo = it.ticket_no || null;
      jobCardStatus = it.status || null;
      if (it.assigned_to_email) {
        const techUser = await pgGet("SELECT name FROM users WHERE email = ?", [it.assigned_to_email]).catch(() => null);
        technicianName = techUser?.name || it.assigned_to_email;
      }
      const installDt = it.technician_signed_off_at || it.engineer_signed_off_at || it.assigned_at || null;
      if (installDt) {
        const dt = new Date(installDt);
        installDate = dt.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
        installTime = dt.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", hour12: true });
      }
      if (it.retail_lead_id) {
        const rl = await pgGet("SELECT sales_rep_id FROM retail_leads WHERE id = ?", [it.retail_lead_id]).catch(() => null);
        if (rl?.sales_rep_id) {
          const repUser = await pgGet("SELECT name FROM users WHERE id::text = ?", [String(rl.sales_rep_id)]).catch(() => null);
          if (repUser?.name) salesRepName = repUser.name;
        }
      }
    }
  }

  const items = await getItems(pfId);
  const taxRate = Number(pf.tax_rate || 0);
  const lineItems = items.length
    ? items.map((item: any, idx: number) => {
        const qty = Number(item.quantity || 0);
        const unitPrice = Number(item.unit_price || 0);
        const lineSub = qty * unitPrice;
        return {
          code: item.device_model || `ITM-${idx + 1}`,
          name: item.device_type || "",
          description: item.description || item.device_type || "",
          quantity: qty,
          unitPrice,
          discountPct: 0,
          vatPct: taxRate,
          lineTotal: lineSub,
        };
      })
    : [{
        code: "SERVICE",
        name: "",
        description: pf.notes || "Proforma service",
        quantity: 1,
        unitPrice: Number(pf.installation_cost || 0),
        discountPct: 0,
        vatPct: taxRate,
        lineTotal: Number(pf.installation_cost || 0),
      }];

  const subtotal = Number(pf.installation_cost || 0) + Number(pf.subscription_fee || 0) - Number(pf.discount_amount || 0);
  const vatTotal = Number(pf.total_amount || 0) - subtotal;
  const vehicleReg = pf.vehicle_registration || pf.vehicle_reg_from_db || null;
  const paymentOptions = await buildPaymentOptions(pf.affiliate_partner_name || null, vehicleReg);

  const pdfBytes = await renderQuotePdf({
    documentTitle:    "PROFORMA INVOICE",
    documentNoLabel:  "Proforma No:",
    documentNo:       pf.proforma_no,
    issueDate:        pf.created_at,
    expiryDate:       pf.quote_expiry_date || null,
    customerName:     pf.customer_name || pf.customer_id,
    customerKraPin,
    customerPhone,
    customerEmail,
    customerAddress,
    salesRep:         salesRepName || pf.sales_rep_name || pf.sales_rep_email || "",
    technicianName:   technicianName || null,
    jobCardNo:        jobCardNo || null,
    jobCardStatus:    jobCardStatus || null,
    installationDate: installDate || null,
    installationTime: installTime || null,
    notes:            pf.notes || "",
    subtotal,
    vatTotal,
    grandTotal:       Number(pf.total_amount || 0),
    taxRate,
    vehicle:          vehicleReg ? { registration: vehicleReg, make: pf.vehicle_make || undefined, model: pf.vehicle_model || undefined } : null,
    paymentOptions,
    lineItems,
  });

  return { pf, items, pdfBytes };
}

function mapItem(r: any) {
  return {
    id: r.id, proformaId: r.proforma_id, deviceModel: r.device_model, deviceType: r.device_type,
    description: r.description, quantity: r.quantity, unitPrice: r.unit_price,
    totalPrice: r.total_price, stockItemId: r.stock_item_id, createdAt: r.created_at,
  };
}

function mapPF(row: any, items: any[] = []) {
  return {
    id: row.id, proformaNo: row.proforma_no, customerId: row.customer_id,
    quoteId: row.quote_id, leadId: row.lead_id, salesRepId: row.sales_rep_id,
    status: row.status, installationCost: row.installation_cost,
    subscriptionFee: row.subscription_fee, taxRate: row.tax_rate,
    discountAmount: row.discount_amount, totalAmount: row.total_amount,
    notes: row.notes, approvedBy: row.approved_by, approvedAt: row.approved_at,
    approvalMethod: row.approval_method,
    customerApprovedAt: row.customer_approved_at,
    customerApprovalMethod: row.customer_approval_method,
    rejectedBy: row.rejected_by, rejectedAt: row.rejected_at, rejectedReason: row.rejected_reason,
    convertedToInstallationId: row.converted_to_installation_id,
    vehicleId: row.vehicle_id || null, vehicleRegistration: row.vehicle_registration || null,
    createdByUserId: row.created_by_user_id, createdAt: row.created_at, updatedAt: row.updated_at,
    items: items.map(mapItem),
  };
}

// ── GET /customer-approve ─ public one-time approval link ────────────────────
// No auth required — customer clicks this from their email
router.get("/customer-approve", async (req, res) => {
  const raw = String(req.query.token || "").trim();
  if (!raw) return res.status(400).json({ ok: false, message: "Missing token." });

  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const record = await pgGet(
    "SELECT * FROM crm_proforma_approval_tokens WHERE token_hash = ?",
    [tokenHash]
  );

  if (!record) return res.status(404).json({ ok: false, message: "Invalid or unrecognised approval link." });
  if (record.used_at) return res.status(409).json({ ok: false, message: "This approval link has already been used.", alreadyUsed: true });
  if (new Date(record.expires_at) < new Date()) return res.status(410).json({ ok: false, message: "This approval link has expired. Please contact your sales representative." });

  const pf = await pgGet("SELECT * FROM crm_proforma_invoices WHERE id = ? AND deleted_at IS NULL", [record.proforma_id]);
  if (!pf) return res.status(404).json({ ok: false, message: "Proforma not found." });
  if (!["Draft", "Pending Approval"].includes(pf.status)) {
    return res.status(409).json({ ok: false, message: `This proforma has already been ${pf.status.toLowerCase()}.`, alreadyProcessed: true, status: pf.status });
  }

  const now = new Date().toISOString();
  const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "");

  // Mark token used
  await pgRun("UPDATE crm_proforma_approval_tokens SET used_at = ?, customer_ip = ? WHERE id = ?", [now, clientIp, record.id]);

  // Record customer approval on the proforma (does NOT trigger the full approval flow — that still needs BDM/Finance)
  await pgRun(
    `UPDATE crm_proforma_invoices SET customer_approved_at = ?, customer_approval_method = 'customer_link', updated_at = ? WHERE id = ?`,
    [now, now, pf.id]
  );

  // Notify sales rep in-app
  if (pf.sales_rep_id) {
    createNotification({
      targetUserId: pf.sales_rep_id,
      type: "approval",
      title: `Customer approved ${pf.proforma_no}`,
      body: `The customer clicked the approval link for proforma ${pf.proforma_no} (${new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES" }).format(pf.total_amount)}).`,
      link: `crm-proforma.html`,
    }).catch(console.error);
  }

  // Notify BDM/Finance role for internal action
  createNotification({
    targetRole: "Finance",
    type: "approval",
    title: `Customer approved ${pf.proforma_no} — ready for internal approval`,
    body: `Customer has digitally approved proforma ${pf.proforma_no}. Please review and formally approve to generate the invoice and ticket.`,
    link: `crm-proforma.html`,
  }).catch(console.error);
  createNotification({
    targetRole: "BDM",
    type: "approval",
    title: `Customer approved ${pf.proforma_no} — ready for internal approval`,
    body: `Customer has digitally approved proforma ${pf.proforma_no}. Please review and formally approve to generate the invoice and ticket.`,
    link: `crm-proforma.html`,
  }).catch(console.error);
  createNotification({
    targetRole: "BDMCorporate",
    type: "approval",
    title: `Customer approved ${pf.proforma_no} — ready for internal approval`,
    body: `Customer has digitally approved proforma ${pf.proforma_no}. Please review and formally approve to generate the invoice and ticket.`,
    link: `crm-proforma.html`,
  }).catch(console.error);

  auditLog(
    { user: { id: "customer", role: "Customer", email: "—" }, ip: clientIp } as any,
    "PROFORMA_CUSTOMER_APPROVED",
    "crm_proforma_invoices",
    "Info",
    { pfId: pf.id, proformaNo: pf.proforma_no }
  ).catch(console.error);

  return ok(res, {
    ok: true,
    message: "Thank you! Your approval has been recorded. Our team will be in touch to arrange the next steps.",
    proformaNo: pf.proforma_no,
    totalAmount: pf.total_amount,
  });
});

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","Sales","Telesales","FieldSales","Technical"]), async (req: AuthRequest, res) => {
  const { customerId, quoteId, status, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset  = (pageNum - 1) * sizeNum;

  const filters: string[] = ["p.deleted_at IS NULL"];
  const params: any[]     = [];

  if (!hasCrmFullVisibility(req.user!.role)) { filters.push("p.sales_rep_id = ?"); params.push(req.user!.id); }
  if (customerId) { filters.push("p.customer_id = ?"); params.push(customerId); }
  if (quoteId)    { filters.push("p.quote_id = ?");    params.push(quoteId); }
  if (status)     { filters.push("p.status = ?");      params.push(status); }

  const where = `WHERE ${filters.join(" AND ")}`;
  const rows = await pgAll(
    `SELECT p.*, COALESCE(i.full_name, corp.company_name) as customer_name,
            u.name AS sales_rep_name, u.email AS sales_rep_email
     FROM crm_proforma_invoices p
     JOIN crm_customers c ON c.id = p.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     LEFT JOIN users u ON u.id = p.sales_rep_id
     ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM crm_proforma_invoices p ${where}`, params);
  const data = rows.map(r => ({ ...mapPF(r), customerName: r.customer_name, salesRepName: r.sales_rep_name || null, salesRepEmail: r.sales_rep_email || null }));
  return ok(res, { data, meta: { total: Number(totalRow?.total ?? 0) } });
});

// ── POST / ─ create standalone proforma ───────────────────────────────────────
router.post("/", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const {
    customerId, quoteId, leadId, items = [],
    installationCost = 0, subscriptionFee = 0, taxRate = 0, discountAmount = 0, notes,
  } = req.body;

  if (!customerId) return errorResponse(res, 400, "MISSING_FIELD", "customerId required.");

  const cust = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [customerId]);
  if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Customer not found.");

  const now = new Date().toISOString();
  const id  = uuidv4();

  // Derive proforma number from linked quote (QTE-XXXX → PFI-XXXX), else auto-generate
  let pfNo: string;
  if (quoteId) {
    const srcQuote = await pgGet(`SELECT quote_no FROM crm_quotes WHERE id = ?`, [quoteId]);
    pfNo = srcQuote?.quote_no
      ? String(srcQuote.quote_no).replace(/^QTE-/i, "PFI-")
      : nextPfNo();
  } else {
    pfNo = nextPfNo();
  }
  const sub = Number(installationCost) + Number(subscriptionFee);
  const total = Math.round(((sub - Number(discountAmount)) * (1 + Number(taxRate)/100)) * 100) / 100;

  await pgRun(
    `INSERT INTO crm_proforma_invoices
       (id,proforma_no,customer_id,quote_id,lead_id,sales_rep_id,status,
        installation_cost,subscription_fee,tax_rate,discount_amount,total_amount,
        notes,created_by_user_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,pfNo,customerId,quoteId||null,leadId||null,req.user!.id,"Pending Approval",
     installationCost,subscriptionFee,taxRate,discountAmount,total,notes||null,req.user!.id,now,now]
  );

  for (const item of items) {
    await pgRun(
      `INSERT INTO crm_proforma_items (id,proforma_id,device_model,device_type,description,quantity,unit_price,total_price,stock_item_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(),id,item.deviceModel,item.deviceType||null,item.description||null,
       item.quantity||1,item.unitPrice||0,Number(item.quantity||1)*Number(item.unitPrice||0),
       item.stockItemId||null,now]
    );
  }

  const pf = await pgGet("SELECT * FROM crm_proforma_invoices WHERE id = ?", [id]);
  const pfItems = await getItems(id);
  auditLog(req, "PROFORMA_CREATED", "crm_proforma_invoices", "Info", { pfNo, customerId }).catch(console.error);

  // ── Notify Finance & BDM that a new proforma needs approval ─────────────────
  const creatorName = req.user!.email || "A sales rep";
  const custRow = await pgGet(
    `SELECT COALESCE(i.full_name, corp.company_name, 'Unknown') AS cname
     FROM crm_customers c
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     WHERE c.id = ?`,
    [customerId]
  );
  const custName = custRow?.cname || "Unknown";
  const amtFormatted = `KES ${Number(total).toLocaleString()}`;
  const notifTitle = `Proforma ${pfNo} needs your approval`;
  const notifBody  = `${creatorName} created proforma ${pfNo} for ${custName} totalling ${amtFormatted}. Please review and approve.`;
  const notifLink  = `crm-proforma.html`;

  createNotification({ targetRole: "Finance",      type: "approval", title: notifTitle, body: notifBody, link: notifLink }).catch(console.error);
  createNotification({ targetRole: "BDM",          type: "approval", title: notifTitle, body: notifBody, link: notifLink }).catch(console.error);
  createNotification({ targetRole: "BDMCorporate", type: "approval", title: notifTitle, body: notifBody, link: notifLink }).catch(console.error);

  // Email Finance & BDM/BDMCorporate users
  (async () => {
    try {
      const approvers = await pgAll(
        `SELECT email, name FROM users WHERE role IN ('Finance','BDM','BDMCorporate','Admin') AND deleted_at IS NULL AND email IS NOT NULL`,
        []
      );
      const emailHtml = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px;">
  <div style="background:#4f46e5;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;font-size:16px;font-weight:700;">Proforma Approval Required</h2>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;border-top:none;">
    <p style="margin:0 0 12px;color:#374151;font-size:14px;">A new proforma invoice requires your approval:</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
      <tr><td style="padding:6px 8px;color:#6b7280;width:140px;">Proforma No</td><td style="padding:6px 8px;font-weight:700;font-family:monospace;color:#4f46e5;">${pfNo}</td></tr>
      <tr style="background:#f8fafc;"><td style="padding:6px 8px;color:#6b7280;">Customer</td><td style="padding:6px 8px;font-weight:600;">${custName}</td></tr>
      <tr><td style="padding:6px 8px;color:#6b7280;">Total Amount</td><td style="padding:6px 8px;font-weight:700;color:#059669;">${amtFormatted}</td></tr>
      <tr style="background:#f8fafc;"><td style="padding:6px 8px;color:#6b7280;">Created By</td><td style="padding:6px 8px;">${creatorName}</td></tr>
    </table>
    <a href="${PORTAL_BASE}/crm-proforma.html" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">Review &amp; Approve →</a>
    <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;">This is an automated notification from Finemark Tracking.</p>
  </div>
</div>`;
      for (const u of approvers) {
        if (isGraphConfigured()) {
          sendEmailViaGraph({
            fromMailbox: MAILBOXES.customer,
            to: u.email,
            subject: `Action Required: Proforma ${pfNo} needs approval`,
            htmlBody: emailHtml,
          }).catch((e: any) => console.error("[proforma/create] email notify failed:", e?.message));
        } else {
          sendMail({
            from: "Finemark Tracking <customer@finemarktracking.co.ke>",
            to: u.email,
            subject: `Action Required: Proforma ${pfNo} needs approval`,
            html: emailHtml,
          }).catch((e: any) => console.error("[proforma/create] email notify failed:", e?.message));
        }
      }
    } catch (e: any) {
      console.error("[proforma/create] approver email lookup failed:", e?.message);
    }
  })();

  return created(res, { data: mapPF(pf!, pfItems) }, "Proforma invoice created.");
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","Sales","Telesales","FieldSales","Technical"]), async (req: AuthRequest, res) => {
  const row = await pgGet(
    `SELECT p.*, COALESCE(i.full_name, corp.company_name) as customer_name
     FROM crm_proforma_invoices p
     JOIN crm_customers c ON c.id = p.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     WHERE p.id = ? AND p.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Proforma not found.");
  if (!(await assertProformaAccess(req.user!.role, req.user!.id, row))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this proforma.");
  }
  const items = await getItems(req.params.id);
  return ok(res, { data: { ...mapPF(row, items), customerName: row.customer_name } });
});

// ── POST /:id/approve ─ Finance approves, auto-creates ticket + installation ──
router.post(
  "/:id/approve",
  requireAuth,
  requireRole(ROLE_GROUPS.PROFORMA_APPROVE),
  async (req: AuthRequest, res) => {
    const pf = await pgGet("SELECT * FROM crm_proforma_invoices WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!pf) return errorResponse(res, 404, "NOT_FOUND", "Proforma not found.");
    if (pf.status !== "Pending Approval")
      return errorResponse(res, 409, "INVALID_STATE", "Only Pending Approval proformas can be approved.");
    if (pf.created_by_user_id === req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "You cannot approve a proforma you created.");

    const now = new Date().toISOString();
    const { etrReceiptNo } = req.body as { etrReceiptNo?: string };

    // ── 1. Approve the proforma ───────────────────────────────────────────────
    // Determine if customer had already digitally approved via link
    const customerApprovalMethod = pf.customer_approved_at ? "customer_link" : null;
    const approvalMethod = customerApprovalMethod ? "customer_link_confirmed" : "sales_rep";
    await pgRun(
      `UPDATE crm_proforma_invoices SET status='Approved', approved_by=?, approved_at=?, approval_method=?, updated_at=? WHERE id=?`,
      [req.user!.email, now, approvalMethod, now, req.params.id]
    );

    // ── 2. Fetch proforma items for ticket description ────────────────────────
    const pfItems = await getItems(req.params.id);
    const itemLines = pfItems.map((it: any) =>
      `• ${it.quantity}x ${it.device_model}${it.device_type ? ` (${it.device_type})` : ""} @ KES ${Number(it.unit_price).toLocaleString()}`
    ).join("\n");

    // ── 3. Determine lead type and resolve ticket reference ───────────────────
    // Retail leads already have an RTL-XXXXXXXX installation ticket.
    // Normal (corporate) leads get a new CRPT-XXXXXXXX ticket created here.
    const retailLead = await pgGet(
      `SELECT id, installation_ticket_no FROM retail_leads
       WHERE customer_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [pf.customer_id]
    );
    const isRetailLead = !!(retailLead?.installation_ticket_no);
    let ticketNo: string;
    let ticketId: string = uuidv4();

    if (isRetailLead) {
      // Retail lead: reference existing RTL ticket, do NOT create a new one
      ticketNo = String(retailLead.installation_ticket_no);
    } else {
      // Normal (corporate) lead: create new CRPT- ticket in crm_tickets
      ticketNo = IdGenerator.generateId("crpt");
      const slaBreachAt = new Date(Date.now() + 24 * 3600_000).toISOString();
      const ticketSubject = `Installation — ${pf.proforma_no}`;
      const ticketDesc = `Auto-generated on Finance approval of ${pf.proforma_no}.\n\nItems:\n${itemLines}\n\nTotal: KES ${Number(pf.total_amount).toLocaleString()}\nApproved by: ${req.user!.email}`;

      await pgRun(
        `INSERT INTO crm_tickets
           (id, ticket_no, customer_id, subject, description, category, priority, status,
            sla_hours, sla_breach_at, opened_at, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?, ?)`,
        [ticketId, ticketNo, pf.customer_id, ticketSubject, ticketDesc,
         "Installation", "Normal", 24, slaBreachAt, now, req.user!.id, now, now]
      );

      // Opening action
      await pgRun(
        `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, new_status, by_user_id, by_user_email, created_at)
         VALUES (?, ?, 'Opened', ?, 'Open', ?, ?, ?)`,
        [uuidv4(), ticketId, `Ticket opened: ${ticketSubject}`, req.user!.id, req.user!.email, now]
      );
      // Inventory routing action
      await pgRun(
        `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, new_status, by_user_id, by_user_email, created_at)
         VALUES (?, ?, 'Routed', ?, 'Open', ?, ?, ?)`,
        [uuidv4(), ticketId, "Routed to Inventory — pending device checkout and allocation.", req.user!.id, req.user!.email, now]
      );
      // Technical routing action
      await pgRun(
        `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, new_status, by_user_id, by_user_email, created_at)
         VALUES (?, ?, 'Routed', ?, 'Open', ?, ?, ?)`,
        [uuidv4(), ticketId, "Routed to Technical — pending support engineer allocation.", req.user!.id, req.user!.email, now]
      );
    }

    // ── 4. Auto-create invoice ──────────────────────────────────────────────────
    // Lookup customer name for invoice
    const custRow = await pgGet(
      `SELECT COALESCE(i.full_name, corp.company_name) AS name
       FROM crm_customers c
       LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
       WHERE c.id = ?`,
      [pf.customer_id]
    );
    const customerName = custRow?.name || "Customer";

    const VAT_RATE = Number(pf.tax_rate) / 100;
    const grossTotal = Number(pf.total_amount);
    // Reconstruct subtotal/vat from total (tax inclusive)
    const subtotal = VAT_RATE > 0 ? grossTotal / (1 + VAT_RATE) : grossTotal;
    const vatTotal = grossTotal - subtotal;
    const today = now.slice(0, 10);
    const dueDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

    // Derive invoice number: PFI-XXXXX → INV-XXXXX
    const derivedInvoiceNo = /^PFI-/i.test(pf.proforma_no)
      ? String(pf.proforma_no).replace(/^PFI-/i, "INV-")
      : undefined; // fall back to auto-generated number in invoiceService

    const invoiceItems = pfItems.map((it: any) => ({
      item: it.device_model,
      description: it.device_type || null,
      qty: it.quantity,
      rate: Number(it.unit_price),
      amount: Number(it.total_price),
      vat: VAT_RATE > 0 ? Number(it.total_price) * VAT_RATE : 0,
    }));

    let invoiceId: string | null = null;
    let invoiceNumber: string | null = null;
    try {
      const inv = await createInvoice({
        invoiceNumber: derivedInvoiceNo,
        customer: customerName,
        vatMode: "exclusive",
        taxDate: today,
        subtotal,
        vatTotal,
        total: grossTotal,
        amount: grossTotal,
        currency: "KES",
        status: "Unpaid",
        issuedOn: today,
        dueOn: dueDate,
        details: {
          proformaNo: pf.proforma_no,
          ticketNo,
          source: "proforma_approval",
        },
      });
      invoiceId = inv.id;
      invoiceNumber = inv.invoiceNumber;
      // Save invoice items
      for (const it of invoiceItems) {
        await pgRun(
          `INSERT INTO invoice_items (id, invoice_id, item, description, qty, rate, amount, vat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), inv.id, it.item, it.description, it.qty, it.rate, it.amount, it.vat]
        );
      }
      // Link invoice to proforma
      await pgRun(`UPDATE crm_proforma_invoices SET invoice_id=?, updated_at=? WHERE id=?`, [inv.id, now, req.params.id]);
      // Set relational FK columns so Customer 360 / for-customer route works
      // Use the proforma's sales rep email as sales_person (not the approver's email)
      const salesRepUser = pf.sales_rep_id
        ? await pgGet("SELECT email FROM users WHERE id = ?", [pf.sales_rep_id])
        : null;
      const salesPersonEmail = salesRepUser?.email || null;
      await pgRun(
        `UPDATE invoices SET customer_id=?, quote_id=?, proforma_id=?, sales_person=?, updated_at=? WHERE id=?`,
        [pf.customer_id, pf.quote_id || null, req.params.id,
         salesPersonEmail, now, inv.id]
      ).catch((e: any) => console.error("[proforma/approve] invoice FK update failed:", e?.message));
      // Persist ETR / eTIMS receipt number if provided
      if (etrReceiptNo) {
        await pgRun(`UPDATE invoices SET etr_receipt_no=?, updated_at=? WHERE id=?`, [etrReceiptNo, now, inv.id]);
      }
    } catch (e: any) {
      console.error("[proforma/approve] invoice creation failed:", e?.message);
    }

    // ── 5. Auto-create vi_installation for Technical Dashboard ────────────────
    const instId = uuidv4();
    await pgRun(
      `INSERT INTO vi_installations
         (id, vehicle_id, customer_id, ticket_ref, status, stage, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Pending', 0, ?, ?, ?)`,
      [instId, pf.vehicle_id || null, pf.customer_id, pf.proforma_no, req.user!.id, now, now]
    );

    // ── 5b. Auto-create installation_tickets record (normal leads only) ─────────
    // Retail leads already have an RTL- installation ticket — don't create a duplicate.
    if (!isRetailLead) {
      await pgRun(
        `INSERT INTO installation_tickets
           (id, ticket_no, invoice_id, proforma_id, customer_id, customer_name,
            devices_json, status, stage, vi_installation_id, crm_ticket_id,
            created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', 0, ?, ?, ?, ?, ?)`,
        [uuidv4(), ticketNo, invoiceId || null, req.params.id, pf.customer_id, customerName,
         JSON.stringify(pfItems.map((it: any) => ({ deviceModel: it.device_model, deviceType: it.device_type, quantity: it.quantity }))),
         instId, ticketId, req.user!.id, now, now]
      ).catch((e: any) => console.error("[proforma/approve] installation_ticket creation failed:", e?.message));
    } else {
      // For retail leads, link the vi_installation back to the existing RTL installation_ticket if found
      const existingItRow = await pgGet(
        `SELECT id FROM installation_tickets WHERE ticket_no = ? LIMIT 1`,
        [ticketNo]
      ).catch(() => null);
      if (existingItRow?.id) {
        await pgRun(
          `UPDATE installation_tickets SET vi_installation_id=?, invoice_id=?, updated_at=? WHERE id=?`,
          [instId, invoiceId || null, now, existingItRow.id]
        ).catch((e: any) => console.error("[proforma/approve] RTL ticket link failed:", e?.message));
      }
    }

    // Link installation to proforma
    await pgRun(
      `UPDATE crm_proforma_invoices SET converted_to_installation_id=?, updated_at=? WHERE id=?`,
      [instId, now, req.params.id]
    );

    // ── 6. Notify customer via email (best-effort) ────────────────────────────
    if (isGraphConfigured()) {
      try {
        // Get customer primary contact email (encrypted)
        const contact = await pgGet(
          `SELECT COALESCE(ind.email_enc, corp.email_enc) AS email_enc,
                  COALESCE(ind.full_name, corp.company_name) AS name
           FROM crm_customers c
           LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
           LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
           WHERE c.id = ?`,
          [pf.customer_id]
        );
        const customerEmail = contact?.email_enc ? decryptField(contact.email_enc) : null;
        if (customerEmail && customerEmail !== "—") {
          const htmlBody = `
<p>Dear ${contact.name || "Valued Customer"},</p>
<p>Your proforma invoice <strong>${pf.proforma_no}</strong> has been <strong>approved by our Finance team</strong>.</p>
<p>A support ticket <strong>${ticketNo}</strong> has been created to manage your installation. Our inventory and technical teams have been notified and will be in touch to arrange device collection and engineer scheduling.</p>
${invoiceNumber ? `<p>Your invoice <strong>${invoiceNumber}</strong> has also been generated for a total of <strong>KES ${Number(pf.total_amount).toLocaleString()}</strong>, payable within 30 days.</p>` : ""}
<h4>Approved Items</h4>
<ul>${pfItems.map((it: any) => `<li>${it.quantity}x ${it.device_model}${it.device_type ? ` (${it.device_type})` : ""} — KES ${Number(it.unit_price).toLocaleString()}</li>`).join("")}</ul>
<p><strong>Total: KES ${Number(pf.total_amount).toLocaleString()}</strong></p>
<p>If you have any questions, please reply to this email referencing ticket <strong>${ticketNo}</strong>.</p>
<p>Regards,<br/>Finemark Tracking</p>
`;
          await sendEmailViaGraph({
            fromMailbox: MAILBOXES.customer,
            to: customerEmail,
            subject: `Your proforma ${pf.proforma_no} has been approved — Ticket ${ticketNo}${invoiceNumber ? ` | Invoice ${invoiceNumber}` : ""}`,

            htmlBody,
          }).catch((e: any) => console.error("[proforma/approve] email notify failed:", e?.message));
        }
      } catch (e: any) {
        console.error("[proforma/approve] contact lookup failed:", e?.message);
      }
    }

    // ── 7. Push in-app notifications ──────────────────────────────────────────
    createNotification({
      targetRole: "Finance",
      type: "invoice",
      title: `New invoice from proforma ${pf.proforma_no}`,
      body: invoiceNumber
        ? `Invoice ${invoiceNumber} generated for KES ${Number(pf.total_amount).toLocaleString()} — awaiting tax signing.`
        : `Proforma ${pf.proforma_no} approved — no invoice generated.`,
      link: invoiceId ? `invoice-detail.html?id=${invoiceId}` : `crm-proforma.html`,
    }).catch(console.error);

    auditLog(req, "PROFORMA_APPROVED", "crm_proforma_invoices", "Info",
      { pfId: req.params.id, ticketNo, instId, invoiceId, invoiceNumber }).catch(console.error);
    return ok(res, {
      message: "Proforma approved.",
      data: { ticketNo, ticketId, installationId: instId, invoiceId, invoiceNumber },
    });
  }
);

// ── POST /:id/reject ──────────────────────────────────────────────────────────
router.post(
  "/:id/reject",
  requireAuth,
  requireRole(ROLE_GROUPS.PROFORMA_APPROVE),
  async (req: AuthRequest, res) => {
    const pf = await pgGet("SELECT * FROM crm_proforma_invoices WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!pf) return errorResponse(res, 404, "NOT_FOUND", "Proforma not found.");
    if (pf.status !== "Pending Approval")
      return errorResponse(res, 409, "INVALID_STATE", "Only Pending Approval proformas can be rejected.");

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE crm_proforma_invoices SET status='Rejected', rejected_by=?, rejected_at=?, rejected_reason=?, updated_at=? WHERE id=?`,
      [req.user!.email, now, req.body.reason || null, now, req.params.id]
    );
    auditLog(req, "PROFORMA_REJECTED", "crm_proforma_invoices", "Info", { pfId: req.params.id }).catch(console.error);
    return ok(res, { message: "Proforma rejected." });
  }
);

// ── POST /:id/convert-to-ticket ─ create vi_installation from approved PF ─────
router.post(
  "/:id/convert-to-ticket",
  requireAuth,
  requireRole(["Admin","Finance","BDM", "BDMCorporate","Sales","Telesales","FieldSales","Technical"]),
  async (req: AuthRequest, res) => {
    const pf = await pgGet("SELECT * FROM crm_proforma_invoices WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!pf) return errorResponse(res, 404, "NOT_FOUND", "Proforma not found.");
    if (!(await assertProformaAccess(req.user!.role, req.user!.id, pf))) {
      return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this proforma.");
    }
    if (pf.status !== "Approved")
      return errorResponse(res, 409, "INVALID_STATE", "Proforma must be Approved before creating an installation ticket.");
    if (pf.converted_to_installation_id)
      return errorResponse(res, 409, "ALREADY_CONVERTED", "Installation ticket already created for this proforma.");

    const { vehicleId } = req.body;
    if (!vehicleId) return errorResponse(res, 400, "MISSING_FIELD", "vehicleId required.");

    const now = new Date().toISOString();
    const instId = uuidv4();

    // Create vi_installation record
    await pgRun(
      `INSERT INTO vi_installations
         (id, vehicle_id, customer_id, ticket_ref, status, stage, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [instId, vehicleId, pf.customer_id, pf.proforma_no, "Pending", 0, now, now]
    );

    await pgRun(
      `UPDATE crm_proforma_invoices SET status='Converted', converted_to_installation_id=?, updated_at=? WHERE id=?`,
      [instId, now, req.params.id]
    );

    auditLog(req, "PROFORMA_CONVERTED_TO_TICKET", "crm_proforma_invoices", "Info",
      { pfId: req.params.id, instId }).catch(console.error);
    return created(res, { data: { installationId: instId } }, "Installation ticket created.");
  }
);

// ── GET /:id/pdf ─ render proforma as PDF using p-invoice.pdf template ─────────
router.get(
  "/:id/pdf",
  requireAuth,
  requireRole(["Admin","Finance","BDM", "BDMCorporate","Sales","Telesales","FieldSales","Technical"]),
  async (req: AuthRequest, res) => {
    const built = await buildProformaPdf(req.params.id);
    if (!built) return errorResponse(res, 404, "NOT_FOUND", "Proforma not found.");
    const { pf, pdfBytes } = built;
    if (!(await assertProformaAccess(req.user!.role, req.user!.id, pf))) {
      return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this proforma.");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${req.query.disposition === "attachment" ? "attachment" : "inline"}; filename="Proforma_${pf.proforma_no}.pdf"`);
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
    auditLog(req, "PROFORMA_PDF_VIEWED", "crm_proforma_invoices", "Info", { pfId: req.params.id, proformaNo: pf.proforma_no }).catch(console.error);
    return res.send(Buffer.from(pdfBytes));
  }
);

// ── POST /:id/send ─ email proforma to customer (or custom address) ────────────
router.post(
  "/:id/send",
  requireAuth,
  requireRole(["Admin","Finance","BDM", "BDMCorporate","Sales","Telesales","FieldSales"]),
  async (req: AuthRequest, res) => {
    const { toEmail } = req.body || {};
    const built = await buildProformaPdf(req.params.id);
    if (!built) return errorResponse(res, 404, "NOT_FOUND", "Proforma not found.");
    const { pf, items, pdfBytes } = built;
    if (!(await assertProformaAccess(req.user!.role, req.user!.id, pf))) {
      return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this proforma.");
    }

    const recipient: string | null = toEmail ||
      (pf.customer_email_enc ? decryptField(pf.customer_email_enc) : null);
    if (!recipient || recipient === "—") {
      return errorResponse(res, 400, "NO_EMAIL", "No recipient email address available. Please provide toEmail.");
    }

    // ── Generate secure one-time customer approval token ──────────────────────
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000).toISOString(); // 30 days
    const tokenId = uuidv4();
    const nowToken = new Date().toISOString();
    await pgRun(
      `INSERT INTO crm_proforma_approval_tokens (id, proforma_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [tokenId, req.params.id, tokenHash, expiresAt, nowToken]
    );
    const approvalUrl = `${PORTAL_BASE}/crm-proforma-approve.html?token=${rawToken}`;

    const htmlBody = buildProformaEmail({
      customerName: pf.customer_name || "Customer",
      proformaNo: pf.proforma_no,
      totalAmount: pf.total_amount,
      installationCost: pf.installation_cost,
      subscriptionFee: pf.subscription_fee,
      taxRate: pf.tax_rate,
      discountAmount: pf.discount_amount,
      salesRep: pf.sales_rep_name || null,
      status: pf.status,
      notes: pf.notes,
      items: items.map((it: any) => ({
        deviceModel: it.device_model,
        deviceType: it.device_type,
        quantity: it.quantity,
        unitPrice: it.unit_price,
        totalPrice: it.total_price,
      })),
      approvalUrl: approvalUrl,
    });

    await sendMail({
      from: "Finemark Tracking <customer@finemarktracking.co.ke>",
      to: recipient,
      subject: `Proforma Invoice ${pf.proforma_no} — Fine Mark Tracking Limited`,
      html: htmlBody,
      text: `Dear ${pf.customer_name || "Customer"},\n\nPlease find your Proforma Invoice ${pf.proforma_no} for KES ${Number(pf.total_amount).toLocaleString()}.\n\nWarm regards,\nFine Mark Tracking Limited`,
      attachments: [{
        filename: `Proforma_${pf.proforma_no}.pdf`,
        content: Buffer.from(pdfBytes),
        contentType: "application/pdf",
      }],
    });

    auditLog(req, "PROFORMA_EMAILED", "crm_proforma_invoices", "Info",
      { pfId: req.params.id, to: recipient.replace(/(.{2}).+(@.+)/, "$1***$2"), approvalTokenCreated: true }).catch(console.error);
    return ok(res, { message: "Proforma sent by email.", approvalUrl });
  }
);

export default router;
