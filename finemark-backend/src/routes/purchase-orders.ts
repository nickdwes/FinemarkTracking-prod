import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse, ok, created } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { pgGet, pgAll, pgRun } from "../db.js";
import { IdGenerator } from "../utils/idGenerator.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// TABLE BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
const initTables = async () => {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      po_number TEXT UNIQUE NOT NULL,
      vendor_id TEXT NOT NULL,
      vendor_name TEXT,
      requestor_user_id TEXT NOT NULL,
      requestor_email TEXT,
      status TEXT DEFAULT 'Draft',
      po_date TEXT NOT NULL,
      expected_delivery TEXT,
      payment_terms TEXT DEFAULT 'Net 30',
      subtotal REAL DEFAULT 0,
      tax_rate REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      notes TEXT,
      approved_at TEXT,
      approved_by TEXT,
      approval_notes TEXT,
      sent_at TEXT,
      sent_to_email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `, []).catch(e => console.error("[purchase_orders] init:", e));

  await pgRun(`
    CREATE TABLE IF NOT EXISTS po_items (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      description TEXT,
      quantity REAL NOT NULL,
      unit TEXT DEFAULT 'unit',
      unit_price REAL NOT NULL,
      discount_percent REAL DEFAULT 0,
      line_total REAL NOT NULL,
      received_quantity REAL DEFAULT 0,
      status TEXT DEFAULT 'Pending',
      created_at TEXT NOT NULL,
      FOREIGN KEY(po_id) REFERENCES purchase_orders(id)
    )
  `, []).catch(e => console.error("[po_items] init:", e));

  await pgRun(`CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders(vendor_id)`, []).catch(() => {});
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status)`, []).catch(() => {});
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items(po_id)`, []).catch(() => {});
};

initTables().catch(e => console.error("[purchase-orders initTables]", e));

// ─────────────────────────────────────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Finance", "Admin", "Procurement", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || "1"), 10), 1);
    const pageSize = Math.min(parseInt(String(req.query.pageSize || "50"), 10), 200);
    const offset = (page - 1) * pageSize;
    const search = req.query.search ? `%${req.query.search}%` : null;
    const status = req.query.status as string;

    let query = `
      SELECT po.*, COUNT(poi.id) as item_count
      FROM purchase_orders po
      LEFT JOIN po_items poi ON poi.po_id = po.id
      WHERE po.deleted_at IS NULL
    `;
    const params: any[] = [];

    if (search) {
      query += ` AND (po.po_number ILIKE ? OR po.vendor_name ILIKE ?)`;
      params.push(search, search);
    }

    if (status) {
      query += ` AND po.status = ?`;
      params.push(status);
    }

    query += ` GROUP BY po.id ORDER BY po.created_at DESC LIMIT ? OFFSET ?`;
    params.push(pageSize, offset);

    const rows = await pgAll(query, params);
    const countResult = await pgGet(
      `SELECT COUNT(DISTINCT po.id) as total FROM purchase_orders po WHERE po.deleted_at IS NULL`,
      []
    );

    return res.json({
      data: rows.map(row => ({
        id: row.id,
        poNumber: row.po_number,
        vendorName: row.vendor_name,
        status: row.status,
        totalAmount: row.total_amount,
        poDate: row.po_date,
        expectedDelivery: row.expected_delivery,
        itemCount: row.item_count,
        createdAt: row.created_at
      })),
      meta: { total: countResult?.total || 0, page, pageSize }
    });
  } catch (err: any) {
    console.error("[PO GET /]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole(["Finance", "Admin", "Procurement", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  try {
    const po = await pgGet(
      `SELECT * FROM purchase_orders WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (!po) return errorResponse(res, 404, "NOT_FOUND", "Purchase order not found");

    const items = await pgAll(
      `SELECT * FROM po_items WHERE po_id = ? ORDER BY created_at`,
      [po.id]
    );

    return res.json({
      id: po.id,
      poNumber: po.po_number,
      vendorId: po.vendor_id,
      vendorName: po.vendor_name,
      requestorUserId: po.requestor_user_id,
      requestorEmail: po.requestor_email,
      status: po.status,
      poDate: po.po_date,
      expectedDelivery: po.expected_delivery,
      paymentTerms: po.payment_terms,
      subtotal: po.subtotal,
      taxRate: po.tax_rate,
      taxAmount: po.tax_amount,
      discountAmount: po.discount_amount,
      totalAmount: po.total_amount,
      notes: po.notes,
      approvedAt: po.approved_at,
      approvedBy: po.approved_by,
      approvalNotes: po.approval_notes,
      sentAt: po.sent_at,
      sentToEmail: po.sent_to_email,
      items: items.map(item => ({
        id: item.id,
        itemName: item.item_name,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unit_price,
        discountPercent: item.discount_percent,
        lineTotal: item.line_total,
        receivedQuantity: item.received_quantity,
        status: item.status
      })),
      createdAt: po.created_at,
      updatedAt: po.updated_at
    });
  } catch (err: any) {
    console.error("[PO GET /:id]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole(["Finance", "Admin", "Procurement"]), async (req: AuthRequest, res) => {
  try {
    const { vendorId, vendorName, expectedDelivery, paymentTerms, notes, items } = req.body;

    if (!vendorId || !vendorName || !Array.isArray(items) || items.length === 0) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Missing required fields or items");
    }

    const poId = uuidv4();
    const poNumber = IdGenerator.generateId("po");
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
    const discountAmount = 0;
    const totalAmount = subtotal + taxAmount - discountAmount;

    // Insert PO
    await pgRun(
      `INSERT INTO purchase_orders 
       (id, po_number, vendor_id, vendor_name, requestor_user_id, requestor_email, status, po_date, expected_delivery, payment_terms, subtotal, tax_rate, tax_amount, discount_amount, total_amount, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [poId, poNumber, vendorId, vendorName, req.user!.id, req.user!.email, "Draft", now, expectedDelivery, paymentTerms || "Net 30", subtotal, taxRate, taxAmount, discountAmount, totalAmount, notes || null, now, now]
    );

    // Insert items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const lineTotal = item.quantity * item.unitPrice * (1 - (item.discountPercent || 0) / 100);
      await pgRun(
        `INSERT INTO po_items (id, po_id, item_name, description, quantity, unit, unit_price, discount_percent, line_total, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemIds[i], poId, item.itemName, item.description || null, item.quantity, item.unit || "unit", item.unitPrice, item.discountPercent || 0, lineTotal, now]
      );
    }

    await auditLog(req, "po_created", "purchase_order", "Info", { poNumber, vendorName, totalAmount });

    return res.status(201).json({
      id: poId,
      poNumber,
      status: "Draft",
      totalAmount,
      createdAt: now
    });
  } catch (err: any) {
    console.error("[PO POST /]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id", requireAuth, requireRole(["Finance", "Admin", "Procurement"]), async (req: AuthRequest, res) => {
  try {
    const po = await pgGet(
      `SELECT * FROM purchase_orders WHERE id = ? AND deleted_at IS NULL AND status = 'Draft'`,
      [req.params.id]
    );

    if (!po) return errorResponse(res, 404, "NOT_FOUND", "Purchase order not found or cannot be edited");

    const { vendorName, expectedDelivery, paymentTerms, notes } = req.body;
    const now = new Date().toISOString();

    await pgRun(
      `UPDATE purchase_orders SET vendor_name = ?, expected_delivery = ?, payment_terms = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [vendorName || po.vendor_name, expectedDelivery || po.expected_delivery, paymentTerms || po.payment_terms, notes ?? po.notes, now, po.id]
    );

    await auditLog(req, "po_updated", "purchase_order", "Info", { poId: po.id, poNumber: po.po_number });

    return res.json({ success: true, updatedAt: now });
  } catch (err: any) {
    console.error("[PO PATCH /:id]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/approve
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/approve", requireAuth, requireRole(ROLE_GROUPS.FINANCE_PRICING), async (req: AuthRequest, res) => {
  try {
    const po = await pgGet(
      `SELECT * FROM purchase_orders WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (!po) return errorResponse(res, 404, "NOT_FOUND", "Purchase order not found");
    if (po.status !== "Draft") return errorResponse(res, 400, "INVALID_STATE", "Only draft POs can be approved");

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE purchase_orders SET status = ?, approved_at = ?, approved_by = ?, updated_at = ?
       WHERE id = ?`,
      ["Approved", now, req.user!.email, now, po.id]
    );

    await auditLog(req, "po_approved", "purchase_order", "Info", { poNumber: po.po_number });

    return res.json({ success: true, status: "Approved", approvedAt: now });
  } catch (err: any) {
    console.error("[PO POST /:id/approve]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole(ROLE_GROUPS.FINANCE_PRICING), async (req: AuthRequest, res) => {
  try {
    const po = await pgGet(
      `SELECT * FROM purchase_orders WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (!po) return errorResponse(res, 404, "NOT_FOUND", "Purchase order not found");

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE purchase_orders SET deleted_at = ? WHERE id = ?`,
      [now, po.id]
    );

    await auditLog(req, "po_deleted", "purchase_order", "Info", { poNumber: po.po_number });

    return res.json({ success: true });
  } catch (err: any) {
    console.error("[PO DELETE /:id]", err);
    return errorResponse(res, 500, "SERVER_ERROR", err.message);
  }
});

export default router;
