import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import QRCode from "qrcode";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { listInvoicesQuerySchema, createInvoiceSchema, updateInvoiceSchema } from "../utils/financeValidators.js";
import { listInvoices, createInvoice, updateInvoice, getArAggregations, updateInvoiceStatusFromPayments, mapInvoice } from "../services/invoiceService.js";
import { pgGet, pgAll, pgRun } from "../db.js";
import { sendMail } from "../utils/mailer.js";
import { buildInvoiceEmail } from "../utils/emailTemplates.js";
import { renderQuotePdf } from "../utils/quoteTemplate.js";
import { decryptField } from "../services/cryptoService.js";
import { sendWhatsApp } from "../services/whatsappService.js";
import { submitToEtims, buildEtimsPayload, isEtimsConfigured } from "../services/etimsService.js";
import { sendReminderForInvoice } from "../services/reminderService.js";

// ── Schema migrations for new invoice columns ────────────────────────────────
const INVOICE_MIGRATIONS = [
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quote_id TEXT`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS proforma_id TEXT`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id TEXT`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_signed BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_control_no TEXT`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_receipt_no TEXT`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_signed_at TEXT`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS etims_signed_by TEXT`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_whatsapp_at TEXT`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_email_at TEXT`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_sms_at TEXT`,
];
for (const sql of INVOICE_MIGRATIONS) pgRun(sql, []).catch(() => {});

// ── Schema migration for invoice_reminders ledger ──────────────────────────
const REMINDER_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS invoice_reminders (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
    segment_key TEXT,
    recipient TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Sent' CHECK (status IN ('Sent', 'Failed')),
    error TEXT,
    sent_by TEXT,
    auto BOOLEAN DEFAULT FALSE,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_reminders_invoice_id ON invoice_reminders(invoice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_reminders_segment ON invoice_reminders(segment_key, sent_at)`,
  `CREATE INDEX IF NOT EXISTS idx_invoice_reminders_sent_at ON invoice_reminders(sent_at)`,
];
for (const sql of REMINDER_MIGRATIONS) pgRun(sql, []).catch(() => {});

const router = Router();

router.get("/", requireAuth, requireRole(["Finance", "Admin", "BDM", "BDMCorporate", "Sales", "Telesales", "FieldSales", "CorporateSales"]), async (req: AuthRequest, res) => {
  const parsed = listInvoicesQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const from = parsed.data.startDate || parsed.data.from;
  const to = parsed.data.endDate || parsed.data.to;
  const page = Math.max(parseInt(parsed.data.page || "1", 10) || 1, 1);
  const pageSize = Math.min(parseInt(parsed.data.pageSize || "50", 10) || 50, 200);
  const isSalesRole = ["Sales", "Telesales", "FieldSales", "CorporateSales"].includes(req.user!.role);
  const salesPerson = isSalesRole ? req.user!.email : parsed.data.salesPerson;
  const { rows, total } = await listInvoices({ search: parsed.data.search, status: parsed.data.status, from, to, bank: parsed.data.bank, salesPerson, rep: parsed.data.rep, page, pageSize });
  return res.status(200).json({ data: rows, meta: { total } });
});

// ── GET /for-sales ── invoices created by the current user's email ───────────
router.get("/for-sales", requireAuth, requireRole(["Sales", "Telesales", "FieldSales", "Admin"]), async (req: AuthRequest, res) => {
  const page = Math.max(parseInt(String(req.query.page || "1"), 10), 1);
  const pageSize = Math.min(parseInt(String(req.query.pageSize || "50"), 10), 200);
  const offset = (page - 1) * pageSize;
  const email = req.user!.email;
  const rows = await pgAll(
    `SELECT * FROM invoices WHERE sales_person = ? ORDER BY issued_on DESC, created_at DESC LIMIT ? OFFSET ?`,
    [email, pageSize, offset]
  );
  const countRow = await pgGet(`SELECT COUNT(*) as total FROM invoices WHERE sales_person = ?`, [email]);
  return res.status(200).json({ data: rows, meta: { total: Number(countRow?.total ?? 0) } });
});

// ── GET /for-customer/:customerId ─────────────────────────────────────────────
router.get("/for-customer/:customerId", requireAuth, requireRole(["Finance", "Admin", "BDM", "BDMCorporate", "Sales", "Telesales", "FieldSales", "Technical"]), async (req, res) => {
  const page = Math.max(parseInt(String(req.query.page || "1"), 10), 1);
  const pageSize = Math.min(parseInt(String(req.query.pageSize || "50"), 10), 200);
  const offset = (page - 1) * pageSize;
  const rows = await pgAll(
    `SELECT * FROM invoices WHERE customer_id = ? ORDER BY issued_on DESC, created_at DESC LIMIT ? OFFSET ?`,
    [req.params.customerId, pageSize, offset]
  );
  const countRow = await pgGet(`SELECT COUNT(*) as total FROM invoices WHERE customer_id = ?`, [req.params.customerId]);
  return res.status(200).json({ data: rows, meta: { total: Number(countRow?.total ?? 0) } });
});

// ── GET /for-partner/:partnerId ───────────────────────────────────────────────
router.get("/for-partner/:partnerId", requireAuth, requireRole(["Finance", "Admin", "BDM", "BDMCorporate", "Sales", "Telesales", "FieldSales"]), async (req, res) => {
  const page = Math.max(parseInt(String(req.query.page || "1"), 10), 1);
  const pageSize = Math.min(parseInt(String(req.query.pageSize || "50"), 10), 200);
  const offset = (page - 1) * pageSize;
  // Invoices linked through customers who belong to this partner (via crm_customer_vehicles.partner_id)
  const rows = await pgAll(
    `SELECT DISTINCT i.*
     FROM invoices i
     LEFT JOIN crm_customers cust ON cust.id = i.customer_id
     LEFT JOIN crm_customer_vehicles v ON v.customer_id = cust.id
     WHERE v.partner_id = ?
     ORDER BY i.issued_on DESC, i.created_at DESC
     LIMIT ? OFFSET ?`,
    [req.params.partnerId, pageSize, offset]
  );
  const cntRow = await pgGet(
    `SELECT COUNT(DISTINCT i.id) as total
     FROM invoices i
     LEFT JOIN crm_customers cust ON cust.id = i.customer_id
     LEFT JOIN crm_customer_vehicles v ON v.customer_id = cust.id
     WHERE v.partner_id = ?`,
    [req.params.partnerId]
  );
  return res.status(200).json({ data: rows.map((r: any) => ({
    id: r.id, invoiceNumber: r.invoice_number, customer: r.customer,
    amount: r.amount, total: r.total, currency: r.currency, status: r.status,
    issuedOn: r.issued_on, dueOn: r.due_on,
    etimsSigned: r.etims_signed, etimsControlNo: r.etims_control_no,
    createdAt: r.created_at,
  })), meta: { total: Number(cntRow?.total ?? 0) } });
});

router.post("/", requireAuth, requireRole(["Finance", "Admin", "BDM", "BDMCorporate", "Sales", "Telesales", "FieldSales"]), async (req: AuthRequest, res) => {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());
  const customerName = parsed.data.customerName || parsed.data.customer;
  if (!customerName) return errorResponse(res, 400, "VALIDATION_ERROR", "Customer name is required.");
  const VAT_RATE = 0.16;
  let invoice: any;
  try {
    const taxDate = parsed.data.taxDate || parsed.data.issuedOn;
    const pinNo = parsed.data.pinNo || "P051961922E";
    const paymentPaybill = parsed.data.paymentPaybill || "4048569";
    const paymentAccountHint = parsed.data.paymentAccountHint || "vehicle registration";
    const bankName = parsed.data.bankName || "COOP BANK";
    const bankAccountNo = parsed.data.bankAccountNo || "01101172442001";
    const vatMode = parsed.data.vatMode;
    const amount = parsed.data.amount;
    const subtotal = vatMode === "inclusive" ? amount / (1 + VAT_RATE) : amount;
    const vatTotal = vatMode === "inclusive" ? amount - subtotal : amount * VAT_RATE;
    const total = vatMode === "inclusive" ? amount : subtotal + vatTotal;
    const items = parsed.data.items && parsed.data.items.length
      ? parsed.data.items
      : [{ item: "Service", description: customerName, qty: 1, rate: subtotal, amount: subtotal, vat: vatTotal }];
    invoice = await createInvoice({
      invoiceNumber: parsed.data.invoiceNumber, customer: customerName, representative: parsed.data.representative,
      vatMode: parsed.data.vatMode, taxDate, jobCardNo: parsed.data.jobCardNo, pinNo, subtotal, vatTotal, total,
      paymentPaybill, paymentAccountHint, bankName, bankAccountNo, amount, currency: "KES",
      status: parsed.data.status, issuedOn: parsed.data.issuedOn, dueOn: parsed.data.dueOn,
      bank: parsed.data.bank, salesPerson: parsed.data.salesPerson,
      details: { ...(parsed.data.details || {}), representative: parsed.data.representative, vatMode: parsed.data.vatMode, taxDate, jobCardNo: parsed.data.jobCardNo || null },
      crmRecordId: parsed.data.crmRecordId,
    });
    for (const item of items) {
      await pgRun(
        `INSERT INTO invoice_items (id, invoice_id, item, description, qty, rate, amount, vat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), invoice.id, item.item, item.description || null, item.qty, item.rate, item.amount, item.vat]
      );
    }
  } catch (error: any) {
    if (error?.code === "23505") return errorResponse(res, 409, "CONFLICT", "Invoice number already exists.");
    return errorResponse(res, 500, "INTERNAL", "Failed to create invoice.");
  }
  auditLog(req, "INVOICE_CREATED", `invoice:${invoice.id}`, "Info", { invoiceNumber: invoice.invoiceNumber, customer: invoice.customer, vatMode: parsed.data.vatMode }).catch(console.error);
  const summary = { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, amount: invoice.amount, currency: "KES", status: invoice.status, issuedOn: invoice.issuedOn, dueOn: invoice.dueOn, bank: invoice.bank || null, salesPerson: invoice.salesPerson || null };
  const now = new Date().toISOString();
  let crmRecordId = parsed.data.crmRecordId || invoice.crmRecordId;
  if (crmRecordId) {
    const existing = await pgGet("SELECT * FROM crm_records WHERE id = ?", [crmRecordId]);
    if (existing) {
      let details: any = {};
      try { details = existing.details_json ? JSON.parse(existing.details_json) : {}; } catch (_) { details = {}; }
      await pgRun("UPDATE crm_records SET details_json = ?, status = ?, updated_at = ? WHERE id = ?", [JSON.stringify({ ...details, invoice: summary, ...(parsed.data.details || {}) }), "Submitted", now, crmRecordId]);
      auditLog(req, "CRM_RECORD_UPDATED", `crm_record:${crmRecordId}`, "Info", { invoiceId: invoice.id, status: "Submitted" }).catch(console.error);
    } else {
      await pgRun(`INSERT INTO crm_records (id, type, customer, location, status, owner_email, created_by_user_id, customer_phone, customer_email, details_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [crmRecordId, "invoice", invoice.customer, parsed.data.details?.location || "Unknown", "Submitted", req.user?.email, req.user?.id, null, null, JSON.stringify({ invoice: summary, ...(parsed.data.details || {}) }), now, now]);
      auditLog(req, "CRM_RECORD_CREATED", `crm_record:${crmRecordId}`, "Info", { type: "invoice", customer: invoice.customer }).catch(console.error);
    }
  } else {
    crmRecordId = uuidv4();
    await pgRun(`INSERT INTO crm_records (id, type, customer, location, status, owner_email, created_by_user_id, customer_phone, customer_email, details_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [crmRecordId, "invoice", invoice.customer, parsed.data.details?.location || "Unknown", "Submitted", req.user?.email, req.user?.id, null, null, JSON.stringify({ invoice: summary, ...(parsed.data.details || {}) }), now, now]);
    auditLog(req, "CRM_RECORD_CREATED", `crm_record:${crmRecordId}`, "Info", { type: "invoice", customer: invoice.customer }).catch(console.error);
  }
  if (crmRecordId && crmRecordId !== invoice.crmRecordId) {
    await pgRun("UPDATE invoices SET crm_record_id = $1, updated_at = $2 WHERE id = $3", [crmRecordId, now, invoice.id]);
    const row = await pgGet("SELECT * FROM invoices WHERE id = $1", [invoice.id]);
    invoice = { id: row.id, invoiceNumber: row.invoice_number, crmRecordId: row.crm_record_id, customer: row.customer, amount: row.amount, currency: row.currency, status: row.status, issuedOn: row.issued_on, dueOn: row.due_on, bank: row.bank, salesPerson: row.sales_person, details: row.details_json ? JSON.parse(row.details_json) : null, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  // Set relational FK columns (customer_id, quote_id, proforma_id) when provided
  const fkFields: Record<string, string> = {};
  if (req.body.customerId) fkFields.customer_id = req.body.customerId;
  if (req.body.quoteId) fkFields.quote_id = req.body.quoteId;
  if (req.body.proformaId) fkFields.proforma_id = req.body.proformaId;
  if (Object.keys(fkFields).length) {
    const sets = Object.keys(fkFields).map(k => `${k} = ?`).join(", ");
    await pgRun(`UPDATE invoices SET ${sets}, updated_at = ? WHERE id = ?`,
      [...Object.values(fkFields), now, invoice.id]);
  }
  return res.status(201).json({ data: invoice, message: "Invoice created" });
});

/**
 * GET /invoices/ar-summary
 * Returns AR KPIs and aggregations (aging, segments, by-customer-type, at-risk top 10)
 */
router.get("/ar-summary", requireAuth, requireRole(ROLE_GROUPS.PROFORMA_APPROVE), async (req: AuthRequest, res) => {
  try {
    const { customerType } = req.query;
    const data = await getArAggregations({ customerType: customerType as string });
    return res.status(200).json({ data });
  } catch (err) {
    console.error("[AR Summary] Error:", err);
    return errorResponse(res, 500, "AGGREGATION_ERROR", "Failed to fetch AR summary");
  }
});

router.get("/:id", requireAuth, requireRole(["Finance", "Admin", "BDM", "BDMCorporate", "Sales", "Telesales", "FieldSales", "Technical"]), async (req, res) => {
  const row = await pgGet("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");
  const items = await pgAll("SELECT item, description, qty, rate, amount, vat FROM invoice_items WHERE invoice_id = ?", [req.params.id]);

  let bankPartnerName: string | null = null;
  let bankAccountInfo: { bankName: string; accountName: string; accountNumber: string } | null = null;
  let vehicleInfo: { registration?: string; make?: string; model?: string } | null = null;
  let ticketNoInfo: string | null = null;
  let preparedByInfo: string | null = null;
  let salesRepNameInfo: string | null = null;
  let technicianNameInfo: string | null = null;
  let jobCardStatusInfo: string | null = null;
  let installDateInfo: string | null = null;
  let installTimeInfo: string | null = null;
  if (row.proforma_id) {
    const pf = await pgGet("SELECT vehicle_id, vehicle_registration, installation_ticket_id, sales_rep_id FROM crm_proforma_invoices WHERE id = ?", [row.proforma_id]).catch(() => null);
    if (pf) {
      // Sales rep from retail lead's submitter (via users table, not partner_users)
      if (pf.installation_ticket_id) {
        const it = await pgGet("SELECT ticket_no, status, assigned_to_email, technician_signed_off_at, engineer_signed_off_at, assigned_at, retail_lead_id FROM installation_tickets WHERE id = ?", [pf.installation_ticket_id]).catch(() => null);
        if (it) {
          ticketNoInfo = it.ticket_no || null;
          jobCardStatusInfo = it.status || null;
          if (it.assigned_to_email) {
            const techUser = await pgGet("SELECT name FROM users WHERE email = ?", [it.assigned_to_email]).catch(() => null);
            technicianNameInfo = techUser?.name || it.assigned_to_email;
          }
          const installDt = it.technician_signed_off_at || it.engineer_signed_off_at || it.assigned_at || null;
          if (installDt) {
            const dt = new Date(installDt);
            installDateInfo = dt.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
            installTimeInfo = dt.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", hour12: true });
          }
          if (it.retail_lead_id) {
            const rl = await pgGet("SELECT sales_rep_id, bank_partner_name, partner_name FROM retail_leads WHERE id = ?", [it.retail_lead_id]).catch(() => null);
            if (rl?.sales_rep_id) {
              const repUser = await pgGet("SELECT name FROM users WHERE id::text = ?", [String(rl.sales_rep_id)]).catch(() => null);
              if (repUser?.name) salesRepNameInfo = repUser.name;
            }
            bankPartnerName = rl?.bank_partner_name || rl?.partner_name || null;
            if (bankPartnerName) {
              const keyword = bankPartnerName.split(" ")[0];
              const ba = await pgGet(
                "SELECT account_name, bank_name, account_number FROM bank_accounts WHERE (bank_name ILIKE ? OR account_name ILIKE ?) AND is_active = true ORDER BY created_at LIMIT 1",
                [`%${keyword}%`, `%${keyword}%`]
              ).catch(() => null);
              if (ba) bankAccountInfo = { bankName: ba.bank_name, accountName: ba.account_name, accountNumber: ba.account_number };
            }
          }
        }
      }
      // Prepared-by: proforma sales_rep → users table
      if (pf.sales_rep_id) {
        const pu = await pgGet("SELECT name FROM users WHERE id::text = ?", [String(pf.sales_rep_id)]).catch(() => null);
        if (pu?.name) preparedByInfo = pu.name;
      }
      if (!preparedByInfo && row.sales_person) {
        const pu = await pgGet("SELECT name FROM users WHERE email = ?", [row.sales_person]).catch(() => null);
        if (pu?.name) preparedByInfo = pu.name;
      }
      if (pf.vehicle_id) {
        const v = await pgGet("SELECT registration, make, model FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL", [pf.vehicle_id]).catch(() => null);
        if (v) vehicleInfo = { registration: v.registration || null, make: v.make || null, model: v.model || null };
      } else if (pf.vehicle_registration) {
        vehicleInfo = { registration: pf.vehicle_registration };
      }
    }
  }

  return res.status(200).json({ data: { invoice: { id: row.id, invoiceNumber: row.invoice_number, customerId: row.customer_id || null, customer: row.customer, representative: row.representative, vatMode: row.vat_mode, taxDate: row.tax_date || row.issued_on, jobCardNo: row.job_card_no || ticketNoInfo, ticketNo: ticketNoInfo, jobCardStatus: jobCardStatusInfo, installationDate: installDateInfo, installationTime: installTimeInfo, salesRepName: salesRepNameInfo, technicianName: technicianNameInfo, pinNo: row.pin_no || "P051961922E", subtotal: row.subtotal, vatTotal: row.vat_total, total: row.total, currency: row.currency, issuedOn: row.issued_on, dueOn: row.due_on, bank: row.bank, salesPerson: row.sales_person, paymentPaybill: row.payment_paybill, paymentAccountHint: row.payment_account_hint, bankName: row.bank_name, bankAccountNo: row.bank_account_no, bankPartnerName, bankAccount: bankAccountInfo, vehicle: vehicleInfo, preparedBy: preparedByInfo, etrReceiptNo: row.etr_receipt_no || null, etimsSigned: row.etims_signed || false, etimsControlNo: row.etims_control_no || null, etimsReceiptNo: row.etims_receipt_no || null, etimsSignedAt: row.etims_signed_at || null, etimsSignedBy: row.etims_signed_by || null, createdAt: row.created_at, updatedAt: row.updated_at }, items } });
});

export const renderInvoicePdf = async (invoice: any, items: any[], options: { debug?: boolean; grid?: boolean } = {}, vehicle?: { registration?: string; make?: string; model?: string } | null) => {
  const subtotal   = Number(invoice.subtotal || 0);
  const vatTotal   = Number(invoice.vatTotal || 0);
  const grandTotal = Number(invoice.total || 0);

  const paybill    = invoice.paymentPaybill || "4048569";
  const vehicleRef = vehicle?.registration || invoice.paymentAccountHint || "Finemark Tracking";

  // Build payment options in the standard format matching the invoice spec
  const paymentOptions: Array<{ label: string; value: string }> = [
    { label: "MPESA PAYBILL",      value: `Paybill: ${paybill} | Account: ${vehicleRef}` },
    { label: "MPESA TILL NUMBER",  value: `Till: 5620852` },
  ];
  // Bank account row: prefer explicit bankName/bankAccountNo, then look up via bankAccount object
  if (invoice.bankName && invoice.bankAccountNo) {
    paymentOptions.push({ label: invoice.bankName, value: invoice.bankAccountNo });
  } else if (invoice.bankAccount) {
    const ba = invoice.bankAccount;
    const label = `${ba.bankName} \u2014 ${ba.accountName}`;
    paymentOptions.push({ label, value: ba.accountNumber });
  }

  let pdfBytes = await renderQuotePdf({
    mode: "invoice",
    documentTitle: vatTotal > 0 ? "TAX INVOICE" : "INVOICE",
    documentNoLabel: "Invoice No:",
    documentNo: invoice.invoiceNumber,
    issueDate: invoice.taxDate || invoice.issuedOn,
    expiryDate: invoice.dueOn || invoice.issuedOn,
    jobCardNo: invoice.jobCardNo || invoice.ticketNo || null,
    jobCardStatus: invoice.jobCardStatus || null,
    installationDate: invoice.installationDate || null,
    installationTime: invoice.installationTime || null,
    status: invoice.status || null,
    preparedBy: invoice.preparedBy || null,
    customerName: invoice.customer || "-",
    customerKraPin: invoice.pinNo || null,
    customerPhone: invoice.customerPhone || null,
    customerEmail: invoice.customerEmail || null,
    customerAddress: invoice.customerAddress || null,
    salesRep: invoice.salesRepName || invoice.representative || null,
    technicianName: invoice.technicianName || null,
    notes: invoice.notes || null,
    subtotal,
    vatTotal,
    grandTotal,
    vehicle: vehicle || null,
    paymentOptions,
    lineItems: items.map((item: any, idx: number) => ({
      code: item.item || `LN-${idx + 1}`,
      description: item.description || "",
      quantity: Number(item.qty || 0),
      unitPrice: Number(item.rate || 0),
      lineTotal: Number(item.amount || 0),
      totalAmount: Number(item.amount || 0),
      vatAmount: Number(item.vat || 0),
    })),
  });

  // If eTIMS signed, overlay KRA receipt section at bottom of PDF
  if (invoice.etimsControlNo || invoice.etrReceiptNo) {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const page = pdfDoc.getPages()[0];
    const { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontReg = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Background band for KRA section
    const bandH = 64;
    const bandY = 30;
    page.drawRectangle({ x: 30, y: bandY, width: width - 60, height: bandH, color: rgb(0.97, 0.98, 1), borderColor: rgb(0.8, 0.86, 0.96), borderWidth: 0.8 });

    const textY = bandY + bandH - 14;
    page.drawText("KRA eTIMS VERIFIED", { x: 40, y: textY, size: 7, font, color: rgb(0.15, 0.3, 0.7) });
    if (invoice.etimsControlNo) {
      page.drawText(`Control No: ${invoice.etimsControlNo}`, { x: 40, y: textY - 11, size: 6.5, font: fontReg, color: rgb(0.2, 0.2, 0.2) });
    }
    if (invoice.etrReceiptNo || invoice.etimsReceiptNo) {
      page.drawText(`Receipt No: ${invoice.etrReceiptNo || invoice.etimsReceiptNo}`, { x: 40, y: textY - 21, size: 6.5, font: fontReg, color: rgb(0.2, 0.2, 0.2) });
    }
    if (invoice.etimsSignedAt) {
      page.drawText(`Signed: ${String(invoice.etimsSignedAt).slice(0, 19).replace("T", " ")}`, { x: 40, y: textY - 31, size: 6.5, font: fontReg, color: rgb(0.4, 0.4, 0.4) });
    }

    // KRA logo watermark
    try {
      const kraLogoBytes = readFileSync(join(__dirname, "../../assets/kra-logo.png"));
      const kraLogo = await pdfDoc.embedPng(kraLogoBytes);
      const logoH = 50;
      const logoW = logoH * (842 / 595);
      page.drawImage(kraLogo, { x: width - 100 - logoW - 12, y: bandY + (bandH - logoH) / 2, width: logoW, height: logoH, opacity: 0.45 });
    } catch (_) { /* logo optional */ }

    // QR code
    const qrData = [invoice.etimsControlNo, invoice.etrReceiptNo || invoice.etimsReceiptNo, invoice.invoiceNumber].filter(Boolean).join("|");
    try {
      const qrDataUrl = await QRCode.toDataURL(qrData, { margin: 1, width: 120 });
      const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, "");
      const qrImg = await pdfDoc.embedPng(Buffer.from(qrBase64, "base64"));
      const qrSize = 58;
      page.drawImage(qrImg, { x: width - 100, y: bandY + 3, width: qrSize, height: qrSize });
    } catch (_) { /* QR optional */ }

    return pdfDoc.save();
  }

  return pdfBytes;
};

router.get("/:id/pdf", requireAuth, requireRole(["Finance", "Admin", "BDM", "BDMCorporate", "Sales", "Telesales", "FieldSales"]), async (req: any, res) => {
  const row = await pgGet("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");
  const items = await pgAll("SELECT item, description, qty, rate, amount, vat FROM invoice_items WHERE invoice_id = ?", [req.params.id]);
  // ── Resolve vehicle + bank partner via proforma link ────────────────────────
  let vehicleForPdf: { registration?: string; make?: string; model?: string } | null = null;
  let bankPartnerNameForPdf: string | null = null;
  let bankAccountForPdf: { bankName: string; accountName: string; accountNumber: string } | null = null;
  let ticketNoForPdf: string | null = null;
  let preparedByForPdf: string | null = null;
  let salesRepNameForPdf: string | null = null;
  let technicianNameForPdf: string | null = null;
  let jobCardStatusForPdf: string | null = null;
  let installDateForPdf: string | null = null;
  let installTimeForPdf: string | null = null;
  if (row.proforma_id) {
    const pf = await pgGet("SELECT vehicle_id, vehicle_registration, installation_ticket_id, sales_rep_id FROM crm_proforma_invoices WHERE id = ?", [row.proforma_id]).catch(() => null);
    if (pf) {
      if (pf.installation_ticket_id) {
        const it = await pgGet("SELECT ticket_no, status, assigned_to_email, technician_signed_off_at, engineer_signed_off_at, assigned_at, retail_lead_id FROM installation_tickets WHERE id = ?", [pf.installation_ticket_id]).catch(() => null);
        if (it) {
          ticketNoForPdf = it.ticket_no || null;
          jobCardStatusForPdf = it.status || null;
          if (it.assigned_to_email) {
            const techUser = await pgGet("SELECT name FROM users WHERE email = ?", [it.assigned_to_email]).catch(() => null);
            technicianNameForPdf = techUser?.name || it.assigned_to_email;
          }
          const installDt = it.technician_signed_off_at || it.engineer_signed_off_at || it.assigned_at || null;
          if (installDt) {
            const dt = new Date(installDt);
            installDateForPdf = dt.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
            installTimeForPdf = dt.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", hour12: true });
          }
          if (it.retail_lead_id) {
            const rl = await pgGet("SELECT sales_rep_id, bank_partner_name, partner_name FROM retail_leads WHERE id = ?", [it.retail_lead_id]).catch(() => null);
            if (rl?.sales_rep_id) {
              const repUser = await pgGet("SELECT name FROM users WHERE id::text = ?", [String(rl.sales_rep_id)]).catch(() => null);
              if (repUser?.name) salesRepNameForPdf = repUser.name;
            }
            bankPartnerNameForPdf = rl?.bank_partner_name || rl?.partner_name || null;
            if (bankPartnerNameForPdf) {
              const keyword = bankPartnerNameForPdf.split(" ")[0];
              const ba = await pgGet(
                "SELECT account_name, bank_name, account_number FROM bank_accounts WHERE (bank_name ILIKE ? OR account_name ILIKE ?) AND is_active = true ORDER BY created_at LIMIT 1",
                [`%${keyword}%`, `%${keyword}%`]
              ).catch(() => null);
              if (ba) bankAccountForPdf = { bankName: ba.bank_name, accountName: ba.account_name, accountNumber: ba.account_number };
            }
          }
        }
      }
      // Prepared-by: proforma sales_rep → users table
      if (pf.sales_rep_id) {
        const pu = await pgGet("SELECT name FROM users WHERE id::text = ?", [String(pf.sales_rep_id)]).catch(() => null);
        if (pu?.name) preparedByForPdf = pu.name;
      }
      if (!preparedByForPdf && row.sales_person) {
        const pu = await pgGet("SELECT name FROM users WHERE email = ?", [row.sales_person]).catch(() => null);
        if (pu?.name) preparedByForPdf = pu.name;
      }
      if (pf.vehicle_id) {
        const v = await pgGet("SELECT registration, make, model FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL", [pf.vehicle_id]).catch(() => null);
        if (v) vehicleForPdf = { registration: v.registration || undefined, make: v.make || undefined, model: v.model || undefined };
      } else if (pf.vehicle_registration) {
        vehicleForPdf = { registration: pf.vehicle_registration };
      }
    }
  }

  // ── Fetch customer profile (phone/email/address) for Bill To section ──────
  let invCustomerPhone: string | null = null;
  let invCustomerEmail: string | null = null;
  let invCustomerAddress: string | null = null;
  if (row.customer_id) {
    const cust = await pgGet("SELECT type FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [row.customer_id]).catch(() => null);
    if (cust?.type === "individual") {
      const ip = await pgGet("SELECT phone_enc, email_enc, address_enc FROM crm_individual_profiles WHERE customer_id = ?", [row.customer_id]).catch(() => null);
      if (ip) {
        invCustomerPhone = decryptField(ip.phone_enc) || null;
        invCustomerEmail = decryptField(ip.email_enc) || null;
        invCustomerAddress = decryptField(ip.address_enc) || null;
      }
    } else if (cust?.type === "corporate") {
      const corp = await pgGet("SELECT physical_address FROM crm_corporate_profiles WHERE customer_id = ?", [row.customer_id]).catch(() => null);
      invCustomerAddress = corp?.physical_address || null;
      const cp = await pgGet("SELECT phone_enc, email_enc FROM crm_contact_persons WHERE customer_id = ? ORDER BY is_primary DESC, created_at LIMIT 1", [row.customer_id]).catch(() => null);
      if (cp) {
        invCustomerPhone = decryptField(cp.phone_enc) || null;
        invCustomerEmail = decryptField(cp.email_enc) || null;
      }
    }
  }

  const inv = {
    invoiceNumber: row.invoice_number, customer: row.customer,
    representative: row.representative, vatMode: row.vat_mode,
    taxDate: row.tax_date || row.issued_on, jobCardNo: row.job_card_no, ticketNo: ticketNoForPdf,
    jobCardStatus: jobCardStatusForPdf, installationDate: installDateForPdf, installationTime: installTimeForPdf,
    salesRepName: salesRepNameForPdf, technicianName: technicianNameForPdf,
    pinNo: row.pin_no || "P051961922E", subtotal: row.subtotal,
    vatTotal: row.vat_total, total: row.total,
    paymentPaybill: row.payment_paybill, paymentAccountHint: row.payment_account_hint,
    bankName: row.bank_name, bankAccountNo: row.bank_account_no,
    bankAccount: bankAccountForPdf,
    preparedBy: preparedByForPdf,
    issuedOn: row.issued_on, dueOn: row.due_on,
    status: row.status || null,
    customerPhone: invCustomerPhone,
    customerEmail: invCustomerEmail,
    customerAddress: invCustomerAddress,
    // eTIMS fields for QR overlay
    etimsControlNo: row.etims_control_no || null,
    etimsReceiptNo: row.etims_receipt_no || null,
    etrReceiptNo: row.etr_receipt_no || null,
    etimsSignedAt: row.etims_signed_at || null,
  };
  const pdfBytes = await renderInvoicePdf(inv, items, { debug: String(req.query.debug || "") === "1", grid: String(req.query.grid || "") === "1" }, vehicleForPdf);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.disposition === "attachment" ? "attachment" : "inline"}; filename="Invoice_${row.invoice_number}.pdf"`);
  // Allow this PDF to be embedded in an iframe served from the UI origin
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  auditLog(req, "INVOICE_PDF_VIEWED", `invoice:${req.params.id}`, "Info", { invoiceNumber: row.invoice_number }).catch(console.error);
  return res.send(Buffer.from(pdfBytes));
});

router.post("/:id/email", requireAuth, requireRole(["Finance", "Admin", "BDM", "BDMCorporate", "Sales", "Telesales", "FieldSales"]), async (req: AuthRequest, res) => {
  const { toEmail, subject, message } = req.body || {};
  if (!toEmail) return errorResponse(res, 400, "VALIDATION_ERROR", "Recipient email is required.");
  const row = await pgGet("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");
  const items = await pgAll("SELECT item, description, qty, rate, amount, vat FROM invoice_items WHERE invoice_id = ?", [req.params.id]);

  let vehicleForEmail: { registration?: string; make?: string; model?: string } | null = null;
  let bankAccountForEmail: { bankName: string; accountName: string; accountNumber: string } | null = null;
  let ticketNoForEmail: string | null = null;
  let preparedByForEmail: string | null = null;
  let salesRepNameForEmail: string | null = null;
  let technicianNameForEmail: string | null = null;
  let jobCardStatusForEmail: string | null = null;
  let installDateForEmail: string | null = null;
  let installTimeForEmail: string | null = null;
  if (row.proforma_id) {
    const pf = await pgGet("SELECT vehicle_id, vehicle_registration, installation_ticket_id, sales_rep_id FROM crm_proforma_invoices WHERE id = ?", [row.proforma_id]).catch(() => null);
    if (pf) {
      if (pf.installation_ticket_id) {
        const it = await pgGet("SELECT ticket_no, status, assigned_to_email, technician_signed_off_at, engineer_signed_off_at, assigned_at, retail_lead_id FROM installation_tickets WHERE id = ?", [pf.installation_ticket_id]).catch(() => null);
        if (it) {
          ticketNoForEmail = it.ticket_no || null;
          jobCardStatusForEmail = it.status || null;
          if (it.assigned_to_email) {
            const techUser = await pgGet("SELECT name FROM users WHERE email = ?", [it.assigned_to_email]).catch(() => null);
            technicianNameForEmail = techUser?.name || it.assigned_to_email;
          }
          const installDt = it.technician_signed_off_at || it.engineer_signed_off_at || it.assigned_at || null;
          if (installDt) {
            const dt = new Date(installDt);
            installDateForEmail = dt.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
            installTimeForEmail = dt.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", hour12: true });
          }
          if (it.retail_lead_id) {
            const rl = await pgGet("SELECT sales_rep_id, bank_partner_name, partner_name FROM retail_leads WHERE id = ?", [it.retail_lead_id]).catch(() => null);
            if (rl?.sales_rep_id) {
              const repUser = await pgGet("SELECT name FROM users WHERE id::text = ?", [String(rl.sales_rep_id)]).catch(() => null);
              if (repUser?.name) salesRepNameForEmail = repUser.name;
            }
            const bpName = rl?.bank_partner_name || rl?.partner_name || null;
            if (bpName) {
              const keyword = bpName.split(" ")[0];
              const ba = await pgGet(
                "SELECT account_name, bank_name, account_number FROM bank_accounts WHERE (bank_name ILIKE ? OR account_name ILIKE ?) AND is_active = true ORDER BY created_at LIMIT 1",
                [`%${keyword}%`, `%${keyword}%`]
              ).catch(() => null);
              if (ba) bankAccountForEmail = { bankName: ba.bank_name, accountName: ba.account_name, accountNumber: ba.account_number };
            }
          }
        }
      }
      // Prepared-by: proforma sales_rep → users table
      if (pf.sales_rep_id) {
        const pu = await pgGet("SELECT name FROM users WHERE id::text = ?", [String(pf.sales_rep_id)]).catch(() => null);
        if (pu?.name) preparedByForEmail = pu.name;
      }
      if (!preparedByForEmail && row.sales_person) {
        const pu = await pgGet("SELECT name FROM users WHERE email = ?", [row.sales_person]).catch(() => null);
        if (pu?.name) preparedByForEmail = pu.name;
      }
      if (pf.vehicle_id) {
        const v = await pgGet("SELECT registration, make, model FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL", [pf.vehicle_id]).catch(() => null);
        if (v) vehicleForEmail = { registration: v.registration || undefined, make: v.make || undefined, model: v.model || undefined };
      } else if (pf.vehicle_registration) {
        vehicleForEmail = { registration: pf.vehicle_registration };
      }
    }
  }

  // ── Fetch customer profile (phone/email/address) for Bill To section ──────
  let emailCustPhone: string | null = null;
  let emailCustEmail: string | null = null;
  let emailCustAddress: string | null = null;
  if (row.customer_id) {
    const cust = await pgGet("SELECT type FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [row.customer_id]).catch(() => null);
    if (cust?.type === "individual") {
      const ip = await pgGet("SELECT phone_enc, email_enc, address_enc FROM crm_individual_profiles WHERE customer_id = ?", [row.customer_id]).catch(() => null);
      if (ip) {
        emailCustPhone = decryptField(ip.phone_enc) || null;
        emailCustEmail = decryptField(ip.email_enc) || null;
        emailCustAddress = decryptField(ip.address_enc) || null;
      }
    } else if (cust?.type === "corporate") {
      const corp = await pgGet("SELECT physical_address FROM crm_corporate_profiles WHERE customer_id = ?", [row.customer_id]).catch(() => null);
      emailCustAddress = corp?.physical_address || null;
      const cp = await pgGet("SELECT phone_enc, email_enc FROM crm_contact_persons WHERE customer_id = ? ORDER BY is_primary DESC, created_at LIMIT 1", [row.customer_id]).catch(() => null);
      if (cp) {
        emailCustPhone = decryptField(cp.phone_enc) || null;
        emailCustEmail = decryptField(cp.email_enc) || null;
      }
    }
  }

  const inv = { invoiceNumber: row.invoice_number, customer: row.customer, representative: row.representative, vatMode: row.vat_mode, taxDate: row.tax_date || row.issued_on, jobCardNo: row.job_card_no, ticketNo: ticketNoForEmail, jobCardStatus: jobCardStatusForEmail, installationDate: installDateForEmail, installationTime: installTimeForEmail, salesRepName: salesRepNameForEmail, technicianName: technicianNameForEmail, pinNo: row.pin_no || "P051961922E", subtotal: row.subtotal, vatTotal: row.vat_total, total: row.total, paymentPaybill: row.payment_paybill, paymentAccountHint: row.payment_account_hint, bankName: row.bank_name, bankAccountNo: row.bank_account_no, bankAccount: bankAccountForEmail, preparedBy: preparedByForEmail, issuedOn: row.issued_on, dueOn: row.due_on, customerPhone: emailCustPhone, customerEmail: emailCustEmail, customerAddress: emailCustAddress,
    status: row.status || null,
    etimsControlNo: row.etims_control_no || null,
    etimsReceiptNo: row.etims_receipt_no || null,
    etrReceiptNo: row.etr_receipt_no || null,
    etimsSignedAt: row.etims_signed_at || null,
  };
  const pdfBytes = await renderInvoicePdf(inv, items, {}, vehicleForEmail);
  const emailSubject = subject || `Invoice ${row.invoice_number} — ${row.customer}`;
  const emailBody = message || `Dear ${row.customer},\n\nPlease find attached invoice ${row.invoice_number} for KES ${Number(row.total || row.amount).toLocaleString()}.\n\nDue: ${row.due_on}\n\nThank you for choosing Finemark Tracking.`;
  const emailHtml = buildInvoiceEmail({ customerName: row.customer, invoiceNo: row.invoice_number, total: Number(row.total || row.amount || 0), dueOn: row.due_on, message: message || undefined });
  await sendMail({ to: toEmail, subject: emailSubject, text: emailBody, html: emailHtml, attachments: [{ filename: `Invoice_${row.invoice_number}.pdf`, content: Buffer.from(pdfBytes), contentType: "application/pdf" }] });
  const now = new Date().toISOString();
  await pgRun(`UPDATE invoices SET sent_email_at = ?, updated_at = ? WHERE id = ?`, [now, now, req.params.id]);
  auditLog(req, "INVOICE_EMAILED", `invoice:${req.params.id}`, "Info", { invoiceNumber: row.invoice_number, to: toEmail }).catch(console.error);
  return res.status(200).json({ message: "Email sent" });
});

// ── POST /:id/whatsapp ── send invoice download link via WhatsApp ───────────────
router.post("/:id/whatsapp", requireAuth, requireRole(["Finance", "Admin", "BDM", "BDMCorporate", "Sales", "Telesales", "FieldSales"]), async (req: AuthRequest, res) => {
  const { phone, message } = req.body || {};
  if (!phone) return errorResponse(res, 400, "VALIDATION_ERROR", "Recipient phone number is required.");
  const row = await pgGet("SELECT * FROM invoices WHERE id = $1", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");
  const body = message || `Dear ${row.customer},\n\nPlease find your invoice *${row.invoice_number}* for *KES ${Number(row.total || row.amount).toLocaleString()}*.\n\nDue: ${row.due_on}\n\nThank you for choosing Finemark Tracking.`;
  await sendWhatsApp(phone, body);
  const now = new Date().toISOString();
  await pgRun(`UPDATE invoices SET sent_whatsapp_at = ?, updated_at = ? WHERE id = ?`, [now, now, req.params.id]);
  auditLog(req, "INVOICE_WHATSAPP_SENT", `invoice:${req.params.id}`, "Info", { invoiceNumber: row.invoice_number, phone }).catch(console.error);
  return res.status(200).json({ message: "WhatsApp message sent" });
});

// ── POST /:id/etims-sign ── sign invoice with KRA eTIMS ────────────────────────
router.post("/:id/etims-sign", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT * FROM invoices WHERE id = $1", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");
  if (row.status === "Cancelled") {
    return errorResponse(res, 409, "INVOICE_CANCELLED", "Cannot sign a cancelled invoice with eTIMS.");
  }
  if (row.etims_signed) {
    return res.status(200).json({
      message: "Invoice already signed",
      data: { etimsControlNo: row.etims_control_no, etimsReceiptNo: row.etims_receipt_no, etimsSignedAt: row.etims_signed_at },
    });
  }
  const items = await pgAll("SELECT * FROM invoice_items WHERE invoice_id = $1", [req.params.id]);
  const invoiceData = {
    invoiceNumber: row.invoice_number,
    buyerPin: req.body.buyerPin || null,
    total: Number(row.total || row.amount),
    vatTotal: Number(row.vat_total || 0),
    items: items.map((it: any) => ({
      item: it.item, description: it.description,
      qty: Number(it.qty), rate: Number(it.rate), amount: Number(it.amount), vat: Number(it.vat),
    })),
  };
  let result: { invoiceControlNumber: string; receiptNumber: string; timestamp: string };
  if (isEtimsConfigured()) {
    try {
      const payload = buildEtimsPayload(invoiceData);
      result = await submitToEtims(payload);
    } catch (etimsErr) {
      const { manualControlNo, manualReceiptNo } = req.body || {};
      if (manualControlNo && manualReceiptNo) {
        result = { invoiceControlNumber: manualControlNo, receiptNumber: manualReceiptNo, timestamp: new Date().toISOString() };
      } else {
        const msg = (etimsErr as Error).message || "unreachable";
        return errorResponse(res, 503, "ETIMS_UNAVAILABLE",
          `eTIMS gateway is not configured. Provide manualControlNo and manualReceiptNo to sign manually. (${msg})`);
      }
    }
  } else {
    const { manualControlNo, manualReceiptNo } = req.body || {};
    if (!manualControlNo || !manualReceiptNo) {
      return errorResponse(res, 503, "ETIMS_UNAVAILABLE",
        "eTIMS gateway is not configured. Provide manualControlNo and manualReceiptNo to sign manually.");
    }
    result = { invoiceControlNumber: manualControlNo, receiptNumber: manualReceiptNo, timestamp: new Date().toISOString() };
  }
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE invoices SET etims_signed = TRUE, etims_control_no = ?, etims_receipt_no = ?, etr_receipt_no = ?, etims_signed_at = ?, etims_signed_by = ?, updated_at = ? WHERE id = ?`,
    [result.invoiceControlNumber, result.receiptNumber, result.receiptNumber, result.timestamp, req.user!.email, now, req.params.id]
  );
  auditLog(req, "INVOICE_ETIMS_SIGNED", `invoice:${req.params.id}`, "Info",
    { invoiceNumber: row.invoice_number, controlNo: result.invoiceControlNumber, receiptNo: result.receiptNumber }).catch(console.error);
  return res.status(200).json({
    message: "Invoice signed with eTIMS",
    data: { etimsControlNo: result.invoiceControlNumber, etimsReceiptNo: result.receiptNumber, etimsSignedAt: result.timestamp },
  });
});

router.patch("/:id", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req, res) => {
  const parsed = updateInvoiceSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());
  const invoice = await updateInvoice(req.params.id, parsed.data);
  if (!invoice) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");
  auditLog(req, "INVOICE_UPDATED", `invoice:${req.params.id}`, "Info", parsed.data).catch(console.error);
  return res.status(200).json({ data: invoice, message: "Invoice updated" });
});

/**
 * GET /invoices/segment/:segmentKey
 * Returns all invoices in a segment (dueToday, dueThisWeek, etc.)
 * Segments: dueToday, dueThisWeek, dueThisMonth, overdue1_7, overdue8_30, overdue31_60, atRisk60Plus, partiallyPaid
 */
router.get("/segment/:segmentKey", requireAuth, requireRole(ROLE_GROUPS.PROFORMA_APPROVE), async (req: AuthRequest, res) => {
  try {
    const { segmentKey } = req.params;
    const { customerType } = req.query;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    let whereClause = "WHERE i.status IN ('Unpaid', 'PartiallyPaid', 'Overdue', 'Pending')";
    const params: any[] = [];
    // customerType filter intentionally omitted (column not present in current schema)
    void customerType;

    let additionalWhere = "";
    switch (segmentKey) {
      case "dueToday":
        additionalWhere = `AND i.due_on = ?`;
        params.push(today);
        break;
      case "dueThisWeek":
        const weekFromNow = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
        additionalWhere = `AND i.due_on > ? AND i.due_on <= ?`;
        params.push(today, weekFromNow);
        break;
      case "dueThisMonth":
        const weekFromNow2 = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
        const monthFromNow = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
        additionalWhere = `AND i.due_on > ? AND i.due_on <= ?`;
        params.push(weekFromNow2, monthFromNow);
        break;
      case "partiallyPaid":
        additionalWhere = `AND i.status = 'PartiallyPaid'`;
        break;
      // Overdue segments require calculating days from due date (no direct column)
      // These will be filtered post-query
      case "overdue1_7":
      case "overdue8_30":
      case "overdue31_60":
      case "atRisk60Plus":
      default:
        // Fetch all overdue, filter post-query
        additionalWhere = `AND i.due_on < ?`;
        params.push(today);
    }

    const allRows = await pgAll(
      `SELECT i.*, (SELECT SUM(amount) FROM payments WHERE invoice_id = i.id AND status = 'Completed') as paid_amount FROM invoices i ${whereClause} ${additionalWhere} ORDER BY i.due_on ASC`,
      params
    );

    // Post-filter for overdue segments (requires daysOverdue calculation)
    let filtered = allRows;
    if (["overdue1_7", "overdue8_30", "overdue31_60", "atRisk60Plus"].includes(segmentKey)) {
      filtered = allRows.filter((row) => {
        const daysOverdue = Math.floor((now.getTime() - new Date(row.due_on).getTime()) / 86400000);
        switch (segmentKey) {
          case "overdue1_7":
            return daysOverdue > 0 && daysOverdue <= 7;
          case "overdue8_30":
            return daysOverdue > 7 && daysOverdue <= 30;
          case "overdue31_60":
            return daysOverdue > 30 && daysOverdue <= 60;
          case "atRisk60Plus":
            return daysOverdue > 60;
          default:
            return false;
        }
      });
    }

    const data = filtered.map(mapInvoice);
    return res.status(200).json({ data, segment: segmentKey, count: data.length });
  } catch (err) {
    console.error("[Segment] Error:", err);
    return errorResponse(res, 500, "SEGMENT_FETCH_ERROR", "Failed to fetch segment");
  }
});

/**
 * GET /invoices/:id/reminders
 * Returns reminder history for an invoice
 */
router.get("/:id/reminders", requireAuth, requireRole(ROLE_GROUPS.PROFORMA_APPROVE), async (req: AuthRequest, res) => {
  try {
    const reminders = await pgAll(
      "SELECT id, invoice_id, channel, segment_key, recipient, subject, body, status, error, sent_by, auto, sent_at, created_at FROM invoice_reminders WHERE invoice_id = ? ORDER BY sent_at DESC",
      [req.params.id]
    );

    return res.status(200).json({ data: reminders });
  } catch (err) {
    console.error("[Invoice Reminders] Error:", err);
    return errorResponse(res, 500, "REMINDER_HISTORY_ERROR", "Failed to fetch reminder history");
  }
});

/**
 * POST /invoices/reminders/send
 * Bulk send reminders to selected invoices
 * Body: { invoiceIds: string[], channels: ("email" | "sms")[], segmentKey: string, messageOverride?: string }
 */
router.post("/reminders/send", requireAuth, requireRole(ROLE_GROUPS.PROFORMA_APPROVE), async (req: AuthRequest, res) => {
  try {
    const { invoiceIds, channels, segmentKey, messageOverride } = req.body;

    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return errorResponse(res, 400, "INVALID_INVOICES", "invoiceIds must be a non-empty array");
    }
    if (!Array.isArray(channels) || channels.length === 0) {
      return errorResponse(res, 400, "INVALID_CHANNELS", "channels must be a non-empty array");
    }
    if (!segmentKey) {
      return errorResponse(res, 400, "INVALID_SEGMENT", "segmentKey is required");
    }

    const results: any = {};

    for (const invoiceId of invoiceIds) {
      try {
        const result = await sendReminderForInvoice(invoiceId, channels, segmentKey, {
          stage: segmentKey,
          sentBy: `user:${req.user!.email}`,
          auto: false,
        });

        results[invoiceId] = {
          success: true,
          channels: result,
        };

        auditLog(req, "REMINDER_SENT", `invoice:${invoiceId}`, "Info", {
          channels,
          segmentKey,
        }).catch(console.error);
      } catch (err) {
        results[invoiceId] = {
          success: false,
          error: (err as Error).message,
        };
      }
    }

    return res.status(200).json({
      message: "Reminders sent",
      data: results,
    });
  } catch (err) {
    console.error("[Bulk Reminder Send] Error:", err);
    return errorResponse(res, 500, "REMINDER_SEND_ERROR", "Failed to send reminders");
  }
});

export default router;
