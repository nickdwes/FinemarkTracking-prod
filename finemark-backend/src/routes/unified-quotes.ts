import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse, ok, created } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { pgGet, pgAll, pgRun } from "../db.js";
import { IdGenerator } from "../utils/idGenerator.js";
import { sendMail } from "../utils/mailer.js";
import { buildQuoteEmail } from "../utils/emailTemplates.js";
import { renderCommercialPdf } from "../utils/commercialPdfTemplate.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// TABLE BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
const initTables = async () => {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      quote_number TEXT UNIQUE NOT NULL,
      customer_id TEXT NOT NULL,
      lead_id TEXT,
      sales_rep_id TEXT NOT NULL,
      sales_rep_email TEXT,
      status TEXT DEFAULT 'Draft',
      quote_date TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      revision_number INTEGER DEFAULT 1,
      subtotal REAL NOT NULL DEFAULT 0,
      tax_rate REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      discount_type TEXT,
      total_amount REAL NOT NULL DEFAULT 0,
      terms_conditions TEXT,
      notes TEXT,
      accepted_at TEXT,
      accepted_by TEXT,
      rejected_reason TEXT,
      sent_at TEXT,
      sent_to_email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `, []).catch(e => console.error("[quotes] init:", e));

  await pgRun(`
    CREATE TABLE IF NOT EXISTS quote_items (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      description TEXT,
      quantity REAL NOT NULL,
      unit TEXT DEFAULT 'unit',
      unit_price REAL NOT NULL,
      discount_percent REAL DEFAULT 0,
      line_total REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(quote_id) REFERENCES quotes(id)
    )
  `, []).catch(e => console.error("[quote_items] init:", e));

  await pgRun(`
    CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes(customer_id)
  `, []).catch(() => {});

  await pgRun(`
    CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status)
  `, []).catch(() => {});
};

initTables().catch(e => console.error("[initTables]", e));

// ─────────────────────────────────────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Sales", "BDM", "BDMCorporate", "Admin", "Finance", "Telesales"]), async (req: AuthRequest, res) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || "1"), 10), 1);
    const pageSize = Math.min(parseInt(String(req.query.pageSize || "50"), 10), 200);
    const offset = (page - 1) * pageSize;
    const status = req.query.status as string;

    let query = `SELECT q.* FROM quotes q WHERE q.deleted_at IS NULL`;
    const params: any[] = [];

    if (status) {
      query += ` AND q.status = ?`;
      params.push(status);
    }

    query += ` ORDER BY q.created_at DESC LIMIT ? OFFSET ?`;
    params.push(pageSize, offset);

    const rows = await pgAll(query, params);
    const countResult = await pgGet(`SELECT COUNT(*) as total FROM quotes WHERE deleted_at IS NULL`, []);

    return res.json({
      data: rows.map(row => ({
        id: row.id,
        quoteNumber: row.quote_number,
        customerId: row.customer_id,
        status: row.status,
        totalAmount: row.total_amount,
        quoteDate: row.quote_date,
        validUntil: row.valid_until,
        revisionNumber: row.revision_number,
        createdAt: row.created_at
      })),
      meta: { total: countResult?.total || 0, page, pageSize }
    });
  } catch (err: any) {
    console.error("[Quote GET /]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole(["Sales", "BDM", "BDMCorporate", "Admin", "Finance", "Telesales"]), async (req: AuthRequest, res) => {
  try {
    const quote = await pgGet(
      `SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found");

    const items = await pgAll(
      `SELECT * FROM quote_items WHERE quote_id = ? ORDER BY created_at`,
      [quote.id]
    );

    return res.json({
      id: quote.id,
      quoteNumber: quote.quote_number,
      customerId: quote.customer_id,
      leadId: quote.lead_id,
      salesRepId: quote.sales_rep_id,
      salesRepEmail: quote.sales_rep_email,
      status: quote.status,
      quoteDate: quote.quote_date,
      validUntil: quote.valid_until,
      revisionNumber: quote.revision_number,
      subtotal: quote.subtotal,
      taxRate: quote.tax_rate,
      taxAmount: quote.tax_amount,
      discountAmount: quote.discount_amount,
      discountType: quote.discount_type,
      totalAmount: quote.total_amount,
      termsConditions: quote.terms_conditions,
      notes: quote.notes,
      acceptedAt: quote.accepted_at,
      acceptedBy: quote.accepted_by,
      rejectedReason: quote.rejected_reason,
      sentAt: quote.sent_at,
      sentToEmail: quote.sent_to_email,
      items: items.map(item => ({
        id: item.id,
        productName: item.product_name,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unit_price,
        discountPercent: item.discount_percent,
        lineTotal: item.line_total
      })),
      createdAt: quote.created_at,
      updatedAt: quote.updated_at
    });
  } catch (err: any) {
    console.error("[Quote GET /:id]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole(["Sales", "BDM", "BDMCorporate", "Admin", "Telesales"]), async (req: AuthRequest, res) => {
  try {
    const { customerId, leadId, validUntil, items, termsConditions, notes, taxRate } = req.body;

    if (!customerId || !Array.isArray(items) || items.length === 0) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Missing customerId or items");
    }

    const quoteId = uuidv4();
    const quoteNumber = IdGenerator.generateId("quote");
    const now = new Date().toISOString();

    // Calculate totals
    let subtotal = 0;
    const itemIds: string[] = [];

    for (const item of items) {
      const lineTotal = item.quantity * item.unitPrice * (1 - (item.discountPercent || 0) / 100);
      subtotal += lineTotal;
      itemIds.push(uuidv4());
    }

    const taxAmount = subtotal * (taxRate || 0);
    const totalAmount = subtotal + taxAmount;

    // Insert quote
    await pgRun(
      `INSERT INTO quotes 
       (id, quote_number, customer_id, lead_id, sales_rep_id, sales_rep_email, status, quote_date, valid_until, subtotal, tax_rate, tax_amount, total_amount, terms_conditions, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [quoteId, quoteNumber, customerId, leadId || null, req.user!.id, req.user!.email, "Draft", now, validUntil, subtotal, taxRate || 0, taxAmount, totalAmount, termsConditions || null, notes || null, now, now]
    );

    // Insert items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const lineTotal = item.quantity * item.unitPrice * (1 - (item.discountPercent || 0) / 100);
      await pgRun(
        `INSERT INTO quote_items (id, quote_id, product_name, description, quantity, unit, unit_price, discount_percent, line_total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemIds[i], quoteId, item.productName, item.description || null, item.quantity, item.unit || "unit", item.unitPrice, item.discountPercent || 0, lineTotal, now]
      );
    }

    await auditLog(req, "quote_created", "quote", "Info", { quoteNumber, customerId, totalAmount });

    return res.status(201).json({
      id: quoteId,
      quoteNumber,
      status: "Draft",
      totalAmount,
      createdAt: now
    });
  } catch (err: any) {
    console.error("[Quote POST /]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id", requireAuth, requireRole(["Sales", "BDM", "BDMCorporate", "Admin"]), async (req: AuthRequest, res) => {
  try {
    const quote = await pgGet(
      `SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL AND status IN ('Draft', 'Sent')`,
      [req.params.id]
    );

    if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found or cannot be edited");

    const { validUntil, termsConditions, notes } = req.body;
    const now = new Date().toISOString();

    await pgRun(
      `UPDATE quotes SET valid_until = ?, terms_conditions = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [validUntil || quote.valid_until, termsConditions ?? quote.terms_conditions, notes ?? quote.notes, now, quote.id]
    );

    await auditLog(req, "quote_updated", "quote", "Info", { quoteId: quote.id });

    return res.json({ success: true, updatedAt: now });
  } catch (err: any) {
    console.error("[Quote PATCH /:id]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/send
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/send", requireAuth, requireRole(["Sales", "BDM", "BDMCorporate", "Admin"]), async (req: AuthRequest, res) => {
  try {
    const quote = await pgGet(
      `SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found");

    const { customerEmail } = req.body;
    if (!customerEmail) return errorResponse(res, 400, "VALIDATION_ERROR", "Customer email required");

    // Update status
    const now = new Date().toISOString();
    await pgRun(
      `UPDATE quotes SET status = ?, sent_at = ?, sent_to_email = ?, updated_at = ?
       WHERE id = ?`,
      ["Sent", now, customerEmail, now, quote.id]
    );

    // Send email
    const emailData = {
      to: customerEmail,
      subject: `Your Quote: ${quote.quote_number}`,
      quoteNumber: quote.quote_number,
      totalAmount: quote.total_amount,
      validUntil: quote.valid_until
    };

    try {
      // await sendMail(customerEmail, `Quote ${quote.quote_number}`, buildQuoteEmail(emailData));
    } catch (e: any) {
      console.error("[Quote email send failed]", e);
    }

    await auditLog(req, "quote_sent", "quote", "Info", { quoteNumber: quote.quote_number });

    return res.json({ success: true, status: "Sent", sentAt: now });
  } catch (err: any) {
    console.error("[Quote POST /:id/send]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/accept
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/accept", requireAuth, async (req: AuthRequest, res) => {
  try {
    const quote = await pgGet(
      `SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL AND status = 'Sent'`,
      [req.params.id]
    );

    if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found or not in Sent status");

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE quotes SET status = ?, accepted_at = ?, accepted_by = ?, updated_at = ?
       WHERE id = ?`,
      ["Accepted", now, req.user!.email, now, quote.id]
    );

    await auditLog(req, "quote_accepted", "quote", "Info", { quoteNumber: quote.quote_number });

    return res.json({ success: true, status: "Accepted", acceptedAt: now });
  } catch (err: any) {
    console.error("[Quote POST /:id/accept]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  try {
    const quote = await pgGet(
      `SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL AND status = 'Draft'`,
      [req.params.id]
    );

    if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found or cannot be deleted");

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE quotes SET deleted_at = ? WHERE id = ?`,
      [now, quote.id]
    );

    await auditLog(req, "quote_deleted", "quote", "Info", { quoteNumber: quote.quote_number });

    return res.json({ success: true });
  } catch (err: any) {
    console.error("[Quote DELETE /:id]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

export default router;
