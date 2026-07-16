import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse, ok, created } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { pgGet, pgAll, pgRun } from "../db.js";
import { IdGenerator } from "../utils/idGenerator.js";
import { sendMail } from "../utils/mailer.js";
import { buildInvoiceEmail } from "../utils/emailTemplates.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// TABLE BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
const initTables = async () => {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS invoices_advanced (
      id TEXT PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      quote_id TEXT,
      po_id TEXT,
      customer_id TEXT NOT NULL,
      customer_name TEXT,
      bill_to_name TEXT,
      bill_to_email TEXT,
      bill_to_phone TEXT,
      bill_to_address TEXT,
      ship_to_name TEXT,
      ship_to_address TEXT,
      invoice_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      payment_terms TEXT DEFAULT 'Net 30',
      status TEXT DEFAULT 'Draft',
      subtotal REAL DEFAULT 0,
      tax_rate REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      discount_type TEXT,
      total_amount REAL DEFAULT 0,
      amount_paid REAL DEFAULT 0,
      notes TEXT,
      reference_number TEXT,
      purchase_order_number TEXT,
      sent_at TEXT,
      viewed_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `, []).catch(e => console.error("[invoices_advanced] init:", e));

  await pgRun(`
    CREATE TABLE IF NOT EXISTS invoice_items_advanced (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT DEFAULT 'unit',
      unit_price REAL NOT NULL,
      discount_percent REAL DEFAULT 0,
      line_total REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices_advanced(id)
    )
  `, []).catch(e => console.error("[invoice_items_advanced] init:", e));

  await pgRun(`
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT,
      reference_number TEXT,
      notes TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices_advanced(id)
    )
  `, []).catch(e => console.error("[invoice_payments] init:", e));

  await pgRun(`
    CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices_advanced(customer_id)
  `, []).catch(() => {});

  await pgRun(`
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices_advanced(status)
  `, []).catch(() => {});

  await pgRun(`
    CREATE INDEX IF NOT EXISTS idx_invoices_quote ON invoices_advanced(quote_id)
  `, []).catch(() => {});
};

initTables().catch(e => console.error("[initTables]", e));

// ─────────────────────────────────────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Finance", "Admin", "Sales", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || "1"), 10), 1);
    const pageSize = Math.min(parseInt(String(req.query.pageSize || "50"), 10), 200);
    const offset = (page - 1) * pageSize;
    const status = req.query.status as string;

    let query = `SELECT * FROM invoices_advanced WHERE deleted_at IS NULL`;
    const params: any[] = [];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(pageSize, offset);

    const rows = await pgAll(query, params);
    const countResult = await pgGet(`SELECT COUNT(*) as total FROM invoices_advanced WHERE deleted_at IS NULL`, []);

    return res.json({
      data: rows.map(row => ({
        id: row.id,
        invoiceNumber: row.invoice_number,
        customerId: row.customer_id,
        customerName: row.customer_name,
        status: row.status,
        totalAmount: row.total_amount,
        amountPaid: row.amount_paid,
        invoiceDate: row.invoice_date,
        dueDate: row.due_date,
        createdAt: row.created_at
      })),
      meta: { total: countResult?.total || 0, page, pageSize }
    });
  } catch (err: any) {
    console.error("[Invoice GET /]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const invoice = await pgGet(
      `SELECT * FROM invoices_advanced WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (!invoice) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");

    const items = await pgAll(
      `SELECT * FROM invoice_items_advanced WHERE invoice_id = ? ORDER BY created_at`,
      [invoice.id]
    );

    const payments = await pgAll(
      `SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY payment_date DESC`,
      [invoice.id]
    );

    return res.json({
      id: invoice.id,
      invoiceNumber: invoice.invoice_number,
      quoteId: invoice.quote_id,
      poId: invoice.po_id,
      customerId: invoice.customer_id,
      customerName: invoice.customer_name,
      billToName: invoice.bill_to_name,
      billToEmail: invoice.bill_to_email,
      billToPhone: invoice.bill_to_phone,
      billToAddress: invoice.bill_to_address,
      shipToName: invoice.ship_to_name,
      shipToAddress: invoice.ship_to_address,
      invoiceDate: invoice.invoice_date,
      dueDate: invoice.due_date,
      paymentTerms: invoice.payment_terms,
      status: invoice.status,
      subtotal: invoice.subtotal,
      taxRate: invoice.tax_rate,
      taxAmount: invoice.tax_amount,
      discountAmount: invoice.discount_amount,
      discountType: invoice.discount_type,
      totalAmount: invoice.total_amount,
      amountPaid: invoice.amount_paid,
      notes: invoice.notes,
      referenceNumber: invoice.reference_number,
      purchaseOrderNumber: invoice.purchase_order_number,
      sentAt: invoice.sent_at,
      viewedAt: invoice.viewed_at,
      items: items.map(item => ({
        id: item.id,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unit_price,
        discountPercent: item.discount_percent,
        lineTotal: item.line_total
      })),
      payments: payments.map(p => ({
        id: p.id,
        paymentDate: p.payment_date,
        amount: p.amount,
        paymentMethod: p.payment_method,
        referenceNumber: p.reference_number,
        notes: p.notes
      })),
      createdAt: invoice.created_at,
      updatedAt: invoice.updated_at
    });
  } catch (err: any) {
    console.error("[Invoice GET /:id]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole(["Finance", "Admin", "Sales"]), async (req: AuthRequest, res) => {
  try {
    const { customerId, billToName, billToEmail, dueDate, items, notes, purchaseOrderNumber } = req.body;

    if (!customerId || !Array.isArray(items) || items.length === 0 || !dueDate) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Missing required fields");
    }

    const invoiceId = uuidv4();
    const invoiceNumber = IdGenerator.generateId("invoice");
    const now = new Date().toISOString();

    // Calculate totals
    let subtotal = 0;
    const itemIds: string[] = [];

    for (const item of items) {
      const lineTotal = item.quantity * item.unitPrice * (1 - (item.discountPercent || 0) / 100);
      subtotal += lineTotal;
      itemIds.push(uuidv4());
    }

    const taxRate = 0;
    const taxAmount = subtotal * taxRate;
    const totalAmount = subtotal + taxAmount;

    // Insert invoice
    await pgRun(
      `INSERT INTO invoices_advanced 
       (id, invoice_number, customer_id, bill_to_name, bill_to_email, invoice_date, due_date, status, subtotal, tax_rate, tax_amount, total_amount, notes, purchase_order_number, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceId, invoiceNumber, customerId, billToName || null, billToEmail || null, now, dueDate, "Draft", subtotal, taxRate, taxAmount, totalAmount, notes || null, purchaseOrderNumber || null, req.user!.id, now, now]
    );

    // Insert items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const lineTotal = item.quantity * item.unitPrice * (1 - (item.discountPercent || 0) / 100);
      await pgRun(
        `INSERT INTO invoice_items_advanced (id, invoice_id, description, quantity, unit, unit_price, discount_percent, line_total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemIds[i], invoiceId, item.description, item.quantity, item.unit || "unit", item.unitPrice, item.discountPercent || 0, lineTotal, now]
      );
    }

    await auditLog(req, "invoice_created", "invoice", "Info", { invoiceNumber, customerId, totalAmount });

    return res.status(201).json({
      id: invoiceId,
      invoiceNumber,
      status: "Draft",
      totalAmount,
      createdAt: now
    });
  } catch (err: any) {
    console.error("[Invoice POST /]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /from-quote/:quoteId
// ─────────────────────────────────────────────────────────────────────────────
router.post("/from-quote/:quoteId", requireAuth, requireRole(["Finance", "Admin", "Sales"]), async (req: AuthRequest, res) => {
  try {
    // Get the quote
    const quote = await pgGet(
      `SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL`,
      [req.params.quoteId]
    );

    if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found");

    const quoteItems = await pgAll(
      `SELECT * FROM quote_items WHERE quote_id = ?`,
      [quote.id]
    );

    const invoiceId = uuidv4();
    const invoiceNumber = IdGenerator.generateId("invoice");
    const now = new Date().toISOString();

    // Create invoice from quote
    await pgRun(
      `INSERT INTO invoices_advanced 
       (id, invoice_number, quote_id, customer_id, invoice_date, due_date, status, subtotal, tax_rate, tax_amount, total_amount, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceId, invoiceNumber, quote.id, quote.customer_id, now, req.body.dueDate || now, "Draft", quote.subtotal, quote.tax_rate, quote.tax_amount, quote.total_amount, req.user!.id, now, now]
    );

    // Copy items from quote
    for (const qItem of quoteItems) {
      await pgRun(
        `INSERT INTO invoice_items_advanced (id, invoice_id, description, quantity, unit, unit_price, discount_percent, line_total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), invoiceId, qItem.product_name, qItem.quantity, qItem.unit, qItem.unit_price, qItem.discount_percent, qItem.line_total, now]
      );
    }

    await auditLog(req, "invoice_created_from_quote", "invoice", "Info", { invoiceNumber, quoteId: quote.id });

    return res.status(201).json({
      id: invoiceId,
      invoiceNumber,
      status: "Draft",
      totalAmount: quote.total_amount,
      createdAt: now
    });
  } catch (err: any) {
    console.error("[Invoice POST /from-quote]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/payment
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/payment", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  try {
    const invoice = await pgGet(
      `SELECT * FROM invoices_advanced WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (!invoice) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");

    const { amount, paymentMethod, referenceNumber, paymentDate, notes } = req.body;
    if (!amount || amount <= 0) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid amount");

    const paymentId = uuidv4();
    const now = new Date().toISOString();

    // Record payment
    await pgRun(
      `INSERT INTO invoice_payments (id, invoice_id, payment_date, amount, payment_method, reference_number, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, invoice.id, paymentDate || now, amount, paymentMethod || "bank_transfer", referenceNumber || null, notes || null, req.user!.id, now]
    );

    // Update invoice amount_paid and status
    const newAmountPaid = (invoice.amount_paid || 0) + amount;
    const newStatus = newAmountPaid >= invoice.total_amount ? "Paid" : "Partially Paid";

    await pgRun(
      `UPDATE invoices_advanced SET amount_paid = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [newAmountPaid, newStatus, now, invoice.id]
    );

    await auditLog(req, "invoice_payment_recorded", "invoice", "Info", { invoiceNumber: invoice.invoice_number, amount });

    return res.json({
      success: true,
      paymentId,
      newAmountPaid,
      status: newStatus,
      createdAt: now
    });
  } catch (err: any) {
    console.error("[Invoice POST /:id/payment]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/send
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/send", requireAuth, requireRole(["Finance", "Admin", "Sales"]), async (req: AuthRequest, res) => {
  try {
    const invoice = await pgGet(
      `SELECT * FROM invoices_advanced WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (!invoice) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");

    const { recipientEmail } = req.body;
    if (!recipientEmail) return errorResponse(res, 400, "VALIDATION_ERROR", "Recipient email required");

    const now = new Date().toISOString();

    // Update status
    await pgRun(
      `UPDATE invoices_advanced SET status = ?, sent_at = ?, updated_at = ?
       WHERE id = ?`,
      ["Sent", now, now, invoice.id]
    );

    // Send email (implementation depends on mailer setup)
    try {
      // await sendMail(recipientEmail, `Invoice ${invoice.invoice_number}`, buildInvoiceEmail({...}));
    } catch (e: any) {
      console.error("[Invoice email failed]", e);
    }

    await auditLog(req, "invoice_sent", "invoice", "Info", { invoiceNumber: invoice.invoice_number });

    return res.json({ success: true, status: "Sent", sentAt: now });
  } catch (err: any) {
    console.error("[Invoice POST /:id/send]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  try {
    const invoice = await pgGet(
      `SELECT * FROM invoices_advanced WHERE id = ? AND deleted_at IS NULL AND status = 'Draft'`,
      [req.params.id]
    );

    if (!invoice) return errorResponse(res, 404, "NOT_FOUND", "Invoice not found or cannot be deleted");

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE invoices_advanced SET deleted_at = ? WHERE id = ?`,
      [now, invoice.id]
    );

    await auditLog(req, "invoice_deleted", "invoice", "Info", { invoiceNumber: invoice.invoice_number });

    return res.json({ success: true });
  } catch (err: any) {
    console.error("[Invoice DELETE /:id]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

export default router;
