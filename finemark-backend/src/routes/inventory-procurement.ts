import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { nextDatedBatchNumber } from "../utils/batchNumber.js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filenameProc  = fileURLToPath(import.meta.url);
const __dirnameProc   = path.dirname(__filenameProc);
const PO_TEMPLATE_PATH  = path.resolve(__dirnameProc, "..", "utils", "Templates", "PO.pdf");
const GRN_TEMPLATE_PATH = path.resolve(__dirnameProc, "..", "utils", "Templates", "template_grn.pdf");

const router = Router();

// ── Tables ─────────────────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS inv_procurement_requisitions (
    id TEXT PRIMARY KEY,
    req_no TEXT NOT NULL UNIQUE,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    supplier_id TEXT,
    requested_by_user_id TEXT NOT NULL,
    requested_by_email TEXT,
    justification TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    approved_by TEXT,
    approved_at TEXT,
    rejected_by TEXT,
    rejected_at TEXT,
    rejection_reason TEXT,
    purchase_order_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[inv_procurement_requisitions] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_purchase_orders (
    id TEXT PRIMARY KEY,
    po_no TEXT NOT NULL UNIQUE,
    supplier_id TEXT NOT NULL,
    requisition_ids TEXT,
    status TEXT NOT NULL DEFAULT 'Draft',
    total_amount REAL,
    delivery_date TEXT,
    notes TEXT,
    created_by_user_id TEXT,
    approved_by TEXT,
    approved_at TEXT,
    received_at TEXT,
    received_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[inv_purchase_orders] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_purchase_order_lines (
    id TEXT PRIMARY KEY,
    po_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL,
    total_price REAL,
    quantity_received INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[inv_purchase_order_lines] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_procurement_batches (
    id TEXT PRIMARY KEY,
    batch_number TEXT NOT NULL UNIQUE,
    po_id TEXT,
    supplier_id TEXT NOT NULL,
    received_by_user_id TEXT,
    received_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[inv_procurement_batches] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_req_product ON inv_procurement_requisitions(product_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_po_supplier ON inv_purchase_orders(supplier_id)`, []).catch(() => {});

// ── Sequence helpers ───────────────────────────────────────────────────────────
async function nextReqNo(): Promise<string> {
  const last = await pgGet("SELECT req_no FROM inv_procurement_requisitions ORDER BY created_at DESC LIMIT 1", []);
  if (!last) return "REQ-00001";
  const n = parseInt(last.req_no.replace("REQ-", ""), 10) || 0;
  return `REQ-${String(n + 1).padStart(5, "0")}`;
}

async function nextPoNo(): Promise<string> {
  const last = await pgGet("SELECT po_no FROM inv_purchase_orders ORDER BY created_at DESC LIMIT 1", []);
  if (!last) return "PO-00001";
  const n = parseInt(last.po_no.replace("PO-", ""), 10) || 0;
  return `PO-${String(n + 1).padStart(5, "0")}`;
}

// "Goods Received Batch" — shared numbering space with inventory-items.ts's
// manual receive path (both represent devices arriving into stock, just via
// different intake routes: formal PO/GRN here vs. ad-hoc receive there), so
// counts from both tables so the same batch number can never appear twice
// for two actually-different batches.
async function nextBatchNo(): Promise<string> {
  return nextDatedBatchNumber("GRB", [
    { table: "inv_procurement_batches", column: "batch_number" },
    { table: "inv_items", column: "batch_ref", distinct: true },
  ]);
}

// ────────────────────────────────────────────────────────────────────────────────
// PURCHASE REQUISITIONS
// ────────────────────────────────────────────────────────────────────────────────
router.get("/requisitions", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req: AuthRequest, res) => {
  const { status, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset  = (pageNum - 1) * sizeNum;

  const filters = ["r.deleted_at IS NULL"];
  const params: any[] = [];
  if (status) { filters.push("r.status = ?"); params.push(status); }
  if (req.user!.role === "Procurement") { filters.push("r.requested_by_user_id = ?"); params.push(req.user!.id); }

  const where = `WHERE ${filters.join(" AND ")}`;
  const rows = await pgAll(
    `SELECT r.*, p.product_code, p.product_name, p.device_model, s.supplier_name
     FROM inv_procurement_requisitions r
     JOIN inv_product_catalog p ON p.id = r.product_id
     LEFT JOIN inv_suppliers s ON s.id = r.supplier_id
     ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM inv_procurement_requisitions r ${where}`, params);
  return ok(res, { data: rows, meta: { total: Number(totalRow?.total ?? 0) } });
});

router.post("/requisitions", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req: AuthRequest, res) => {
  const { productId, quantity, supplierId, justification } = req.body;
  if (!productId || !quantity)
    return errorResponse(res, 400, "MISSING_FIELD", "productId and quantity required.");
  const product = await pgGet("SELECT id FROM inv_product_catalog WHERE id = ? AND deleted_at IS NULL", [productId]);
  if (!product) return errorResponse(res, 404, "NOT_FOUND", "Product not found.");

  const now = new Date().toISOString();
  const id    = uuidv4();
  const reqNo = await nextReqNo();

  await pgRun(
    `INSERT INTO inv_procurement_requisitions
       (id,req_no,product_id,quantity,supplier_id,requested_by_user_id,requested_by_email,justification,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, reqNo, productId, quantity, supplierId||null, req.user!.id, req.user!.email||null, justification||null, "Pending", now, now]
  );
  auditLog(req, "INV_REQ_CREATED", "inv_procurement_requisitions", "Info", { reqNo }).catch(console.error);
  const row = await pgGet("SELECT * FROM inv_procurement_requisitions WHERE id = ?", [id]);
  return created(res, { data: row }, `Requisition ${reqNo} created.`);
});

router.post("/requisitions/:id/approve", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT * FROM inv_procurement_requisitions WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Requisition not found.");
  if (row.status !== "Pending") return errorResponse(res, 400, "INVALID_STATUS", "Only Pending requisitions can be approved.");
  const now = new Date().toISOString();
  await pgRun("UPDATE inv_procurement_requisitions SET status='Approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?",
    [req.user!.id, now, now, row.id]);
  auditLog(req, "INV_REQ_APPROVED", "inv_procurement_requisitions", "Info", { id: row.id, reqNo: row.req_no }).catch(console.error);
  return ok(res, null, "Requisition approved.");
});

router.post("/requisitions/:id/reject", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT * FROM inv_procurement_requisitions WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Requisition not found.");
  if (row.status !== "Pending") return errorResponse(res, 400, "INVALID_STATUS", "Only Pending requisitions can be rejected.");
  const { reason } = req.body;
  if (!reason) return errorResponse(res, 400, "MISSING_FIELD", "Rejection reason required.");
  const now = new Date().toISOString();
  await pgRun("UPDATE inv_procurement_requisitions SET status='Rejected', rejected_by=?, rejected_at=?, rejection_reason=?, updated_at=? WHERE id=?",
    [req.user!.id, now, reason, now, row.id]);
  auditLog(req, "INV_REQ_REJECTED", "inv_procurement_requisitions", "Warning", { id: row.id }).catch(console.error);
  return ok(res, null, "Requisition rejected.");
});

// ────────────────────────────────────────────────────────────────────────────────
// PURCHASE ORDERS
// ────────────────────────────────────────────────────────────────────────────────
router.get("/orders", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req: AuthRequest, res) => {
  const { status, supplierId, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset  = (pageNum - 1) * sizeNum;
  const filters = ["po.deleted_at IS NULL"];
  const params: any[] = [];
  if (status)     { filters.push("po.status = ?");      params.push(status); }
  if (supplierId) { filters.push("po.supplier_id = ?"); params.push(supplierId); }
  const where = `WHERE ${filters.join(" AND ")}`;
  const rows = await pgAll(
    `SELECT po.*, s.supplier_name FROM inv_purchase_orders po
     JOIN inv_suppliers s ON s.id = po.supplier_id
     ${where} ORDER BY po.created_at DESC LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM inv_purchase_orders po ${where}`, params);
  return ok(res, { data: rows, meta: { total: Number(totalRow?.total ?? 0) } });
});

router.post("/orders", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req: AuthRequest, res) => {
  const { supplierId, lines, deliveryDate, notes, requisitionIds } = req.body;
  if (!supplierId || !Array.isArray(lines) || !lines.length)
    return errorResponse(res, 400, "MISSING_FIELD", "supplierId and lines[] required.");

  const now = new Date().toISOString();
  const id   = uuidv4();
  const poNo = await nextPoNo();

  let total = 0;
  for (const l of lines) { total += (l.quantity || 0) * (l.unitPrice || 0); }

  await pgRun(
    `INSERT INTO inv_purchase_orders
       (id,po_no,supplier_id,requisition_ids,status,total_amount,delivery_date,notes,created_by_user_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, poNo, supplierId, requisitionIds ? JSON.stringify(requisitionIds) : null, "Draft",
     total, deliveryDate||null, notes||null, req.user!.id, now, now]
  );
  for (const l of lines) {
    await pgRun(
      `INSERT INTO inv_purchase_order_lines (id,po_id,product_id,quantity,unit_price,total_price,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), id, l.productId, l.quantity||1, l.unitPrice||0, (l.quantity||1)*(l.unitPrice||0), now]
    );
  }
  // Link requisitions
  if (Array.isArray(requisitionIds)) {
    for (const rId of requisitionIds) {
      await pgRun("UPDATE inv_procurement_requisitions SET purchase_order_id=?, updated_at=? WHERE id=?", [id, now, rId]);
    }
  }
  auditLog(req, "INV_PO_CREATED", "inv_purchase_orders", "Info", { poNo }).catch(console.error);
  const po = await pgGet("SELECT * FROM inv_purchase_orders WHERE id = ?", [id]);
  const poLines = await pgAll("SELECT * FROM inv_purchase_order_lines WHERE po_id = ?", [id]);
  return created(res, { data: { ...po, lines: poLines } }, `Purchase order ${poNo} created.`);
});

router.get("/orders/:id", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req, res) => {
  const po = await pgGet(
    `SELECT po.*, s.supplier_name FROM inv_purchase_orders po
     JOIN inv_suppliers s ON s.id = po.supplier_id WHERE po.id = ? AND po.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!po) return errorResponse(res, 404, "NOT_FOUND", "Purchase order not found.");
  const lines = await pgAll(
    `SELECT l.*, p.product_code, p.product_name, p.device_model FROM inv_purchase_order_lines l
     JOIN inv_product_catalog p ON p.id = l.product_id WHERE l.po_id = ?`, [req.params.id]
  );
  const batches = await pgAll("SELECT * FROM inv_procurement_batches WHERE po_id = ?", [req.params.id]);
  return ok(res, { data: { ...po, lines, batches } });
});

router.get("/orders/:id/pdf", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req: AuthRequest, res) => {
  const po = await pgGet(
    `SELECT po.*, s.supplier_name, s.head_office_address, s.phone, s.email, s.tax_id, s.contact_person
     FROM inv_purchase_orders po
     JOIN inv_suppliers s ON s.id = po.supplier_id
     WHERE po.id = ? AND po.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!po) return errorResponse(res, 404, "NOT_FOUND", "Purchase order not found.");
  const lines = await pgAll(
    `SELECT l.*, p.product_code, p.product_name, p.device_model FROM inv_purchase_order_lines l
     JOIN inv_product_catalog p ON p.id = l.product_id WHERE l.po_id = ?`, [req.params.id]
  );

  const templateExists = fs.existsSync(PO_TEMPLATE_PATH);
  let pdfDoc: PDFDocument;
  if (templateExists) {
    pdfDoc = await PDFDocument.load(fs.readFileSync(PO_TEMPLATE_PATH));
  } else {
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595.28, 841.89]);
  }
  const page   = pdfDoc.getPages()[0];
  const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const BLACK  = rgb(0.1, 0.11, 0.13);
  const GREY   = rgb(0.5, 0.52, 0.56);

  const w  = (text: string | number | null | undefined, x: number, y: number, size = 9, bold = false) => {
    if (text == null || text === "") return;
    page.drawText(String(text), { x, y, size, font: bold ? fontB : font, color: BLACK });
  };
  const wR = (text: string | number | null | undefined, rx: number, y: number, size = 9, bold = false) => {
    if (text == null || text === "") return;
    const v = String(text); const f = bold ? fontB : font;
    page.drawText(v, { x: rx - f.widthOfTextAtSize(v, size), y, size, font: f, color: BLACK });
  };

  // ── Supplier block (left meta, top of page) ───────────────────────────────
  // Positions calibrated to the blank lines drawn in the template
  const ML  = 40;
  const supBaseY = 688;   // top label line in template (metaTop - 27)
  const supFields = [
    po.supplier_name ?? "",
    po.head_office_address ?? "",
    po.contact_person ?? "",
    `${po.phone ?? ""}  ${po.email ?? ""}`.trim(),
    po.tax_id ?? "",
  ];
  supFields.forEach((val, i) => w(val, ML + 92, supBaseY - i * 16, 9));

  // ── PO details block (right meta) ─────────────────────────────────────────
  const RX   = 595.28 / 2 + 10;
  const poBaseY = supBaseY;
  const fmtDate = (d: string | null) => d ? d.slice(0, 10) : "";
  const poFields = [
    po.po_no,
    fmtDate(po.created_at),
    fmtDate(po.delivery_date),
    "30 days net",
    req.user?.email ?? "",
  ];
  poFields.forEach((val, i) => w(String(val ?? ""), RX + 92, poBaseY - i * 16, 9));

  // ── Line items ────────────────────────────────────────────────────────────
  // Column x-positions (match template COL layout)
  const COL_CODE  = ML + 24 + 4;
  const COL_DESC  = ML + 96 + 4;
  const COL_QTY_R = ML + 271 + 45 - 4;
  const COL_UNIT_R= ML + 316 + 70 - 4;
  const COL_VAT_R = ML + 386 + 40 - 4;
  const COL_TOT_R = ML + 426 + 89 - 4;
  const formatKes = (n: number) => `${Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const TABLE_START_Y = 558;   // first data row y  (colHeaderY - ROW_H = 558 approx)
  const ROW_H = 15;

  let subtotal = 0;
  lines.slice(0, 16).forEach((line: any, i: number) => {
    const y    = TABLE_START_Y - i * ROW_H;
    const qty  = Number(line.quantity  ?? 0);
    const unit = Number(line.unit_price ?? 0);
    const total= qty * unit;
    const vat  = total * 0.16;
    subtotal  += total;
    w(line.product_code ?? "",              COL_CODE,   y, 8);
    w(`${line.product_name ?? ""} ${line.device_model ?? ""}`.trim(), COL_DESC, y, 8);
    wR(String(qty),                          COL_QTY_R,  y, 8);
    wR(formatKes(unit),                      COL_UNIT_R, y, 8);
    wR(formatKes(vat),                       COL_VAT_R,  y, 8);
    wR(formatKes(total),                     COL_TOT_R,  y, 8);
  });

  // ── Totals ────────────────────────────────────────────────────────────────
  const totBaseY = TABLE_START_Y - 16 * ROW_H - 12;  // just below last row
  const vatTotal   = subtotal * 0.16;
  const grandTotal = subtotal + vatTotal;
  const MR = 555;
  wR(formatKes(subtotal),   MR, totBaseY,        9);
  wR(formatKes(vatTotal),   MR, totBaseY - 18,   9);
  wR(formatKes(grandTotal), MR, totBaseY - 36,   9, true);

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (po.notes) w(po.notes.slice(0, 120), ML, totBaseY, 8);

  const pdfBytes = await pdfDoc.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${ req.query.disposition === "attachment" ? "attachment" : "inline"}; filename="PO_${po.po_no}.pdf"`);
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  auditLog(req, "INV_PO_PDF_VIEWED", "inv_purchase_orders", "Info", { poNo: po.po_no }).catch(console.error);
  return res.send(Buffer.from(pdfBytes));
});

router.post("/orders/:id/confirm", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const po = await pgGet("SELECT * FROM inv_purchase_orders WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!po) return errorResponse(res, 404, "NOT_FOUND", "Purchase order not found.");
  if (po.status !== "Draft") return errorResponse(res, 400, "INVALID_STATUS", "Only Draft POs can be confirmed.");
  const now = new Date().toISOString();
  await pgRun("UPDATE inv_purchase_orders SET status='Confirmed', approved_by=?, approved_at=?, updated_at=? WHERE id=?",
    [req.user!.id, now, now, po.id]);
  auditLog(req, "INV_PO_CONFIRMED", "inv_purchase_orders", "Info", { id: po.id, poNo: po.po_no }).catch(console.error);
  return ok(res, null, "PO confirmed.");
});

// ── POST /orders/:id/receive — GRN + auto-create inv_items ────────────────────
router.post("/orders/:id/receive",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Procurement"]),
  async (req: AuthRequest, res) => {
    const po = await pgGet("SELECT * FROM inv_purchase_orders WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!po) return errorResponse(res, 404, "NOT_FOUND", "Purchase order not found.");
    if (!["Confirmed", "Partially Received"].includes(po.status))
      return errorResponse(res, 400, "INVALID_STATUS", "PO must be Confirmed before receiving.");

    const { items, warehouseLocation, notes } = req.body;
    if (!Array.isArray(items) || !items.length)
      return errorResponse(res, 400, "MISSING_FIELD", "items[] required.");

    const now = new Date().toISOString();
    const batchNo = await nextBatchNo();
    const batchId = uuidv4();

    await pgRun(
      `INSERT INTO inv_procurement_batches (id,batch_number,po_id,supplier_id,received_by_user_id,received_at,notes,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [batchId, batchNo, po.id, po.supplier_id, req.user!.id, now, notes||null, now, now]
    );

    const received: any[] = [];
    const errors: any[] = [];

    for (const item of items) {
      try {
        const { productId, serialNumber, imei, purchasePrice, simPhone } = item;
        if (!productId) { errors.push({ item, error: "productId required" }); continue; }

        const product = await pgGet("SELECT warranty_months FROM inv_product_catalog WHERE id = ?", [productId]);
        const warrantyExpires = product?.warranty_months
          ? new Date(new Date().setMonth(new Date().getMonth() + product.warranty_months)).toISOString()
          : null;

        const itemId = uuidv4();
        await pgRun(
          `INSERT INTO inv_items
             (id,product_id,serial_number,imei,supplier_id,batch_id,purchase_date,purchase_price,
              warehouse_location,status,sim_phone,warranty_expires_at,created_by_user_id,received_by_user_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [itemId, productId, serialNumber||null, imei||null, po.supplier_id, batchId,
           now.slice(0,10), purchasePrice||null, warehouseLocation||null,
           "In Stock", simPhone||null, warrantyExpires, req.user!.id, req.user!.id, now, now]
        );
        await pgRun(
          `INSERT INTO inv_movements (id,item_id,product_id,action,from_status,to_status,from_location,to_location,batch_id,performed_by_user_id,performed_by_email,notes,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [uuidv4(), itemId, productId, "RECEIVED", null, "In Stock", "Supplier",
           warehouseLocation||"Warehouse", batchId, req.user!.id, req.user!.email||"", `GRN: ${batchNo}`, now]
        );
        // Update PO line qty received
        await pgRun(
          `UPDATE inv_purchase_order_lines SET quantity_received = quantity_received + 1 WHERE po_id = ? AND product_id = ?`,
          [po.id, productId]
        );
        received.push({ id: itemId, imei, serialNumber });
      } catch(e: any) { errors.push({ item, error: e.message }); }
    }

    // Update PO status
    const lines = await pgAll("SELECT quantity, quantity_received FROM inv_purchase_order_lines WHERE po_id = ?", [po.id]);
    const allReceived = lines.every((l: any) => Number(l.quantity_received) >= Number(l.quantity));
    const newPoStatus = allReceived ? "Received" : "Partially Received";
    await pgRun("UPDATE inv_purchase_orders SET status=?, received_at=?, received_by=?, updated_at=? WHERE id=?",
      [newPoStatus, now, req.user!.id, now, po.id]);

    auditLog(req, "INV_GRN", "inv_procurement_batches", "Info", { batchNo, count: received.length }).catch(console.error);
    return ok(res, { data: { batchNo, batchId, received, errors } }, `GRN ${batchNo}: ${received.length} devices received.`);
  }
);

// ── BATCHES ────────────────────────────────────────────────────────────────────
router.get("/batches", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement", "WarehouseOfficer"]), async (_req, res) => {
  const rows = await pgAll(
    `SELECT b.*, s.supplier_name, po.po_no,
            (SELECT COUNT(*) FROM inv_items i WHERE i.batch_id = b.id AND i.deleted_at IS NULL) AS item_count
     FROM inv_procurement_batches b
     LEFT JOIN inv_suppliers s ON s.id = b.supplier_id
     LEFT JOIN inv_purchase_orders po ON po.id = b.po_id
     ORDER BY b.created_at DESC LIMIT 100`, []
  );
  return ok(res, { data: rows });
});

// ── GRN PDF ────────────────────────────────────────────────────────────────────
router.get("/batches/:id/pdf", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement", "WarehouseOfficer"]), async (req: AuthRequest, res) => {
  const batch = await pgGet(
    `SELECT b.*, s.supplier_name, s.head_office_address, s.phone, s.email, s.tax_id, s.contact_person,
            po.po_no,
            u.email AS received_by_email
     FROM inv_procurement_batches b
     LEFT JOIN inv_suppliers s  ON s.id  = b.supplier_id
     LEFT JOIN inv_purchase_orders po ON po.id = b.po_id
     LEFT JOIN users u ON u.id = b.received_by_user_id
     WHERE b.id = ?`,
    [req.params.id]
  );
  if (!batch) return errorResponse(res, 404, "NOT_FOUND", "Batch not found.");

  const items = await pgAll(
    `SELECT i.serial_number, i.imei, i.mac_address, i.purchase_price, i.status, i.warehouse_location,
            p.product_code, p.product_name, p.device_model
     FROM inv_items i
     LEFT JOIN inv_product_catalog p ON p.id = i.product_id
     WHERE i.batch_id = ? AND i.deleted_at IS NULL
     ORDER BY i.created_at ASC`,
    [req.params.id]
  );

  const templateExists = fs.existsSync(GRN_TEMPLATE_PATH);
  let pdfDoc: PDFDocument;
  if (templateExists) {
    pdfDoc = await PDFDocument.load(fs.readFileSync(GRN_TEMPLATE_PATH));
  } else {
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595.28, 841.89]);
  }
  const page  = pdfDoc.getPages()[0];
  const font  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const BLACK = rgb(0.1, 0.11, 0.13);

  const w = (text: string | number | null | undefined, x: number, y: number, size = 9, bold = false) => {
    if (text == null || text === "") return;
    page.drawText(String(text), { x, y, size, font: bold ? fontB : font, color: BLACK });
  };

  const fmtDate = (d: string | null) => d ? String(d).slice(0, 10) : "";
  const ML = 40;
  const H  = 841.89;

  // ── Meta: Received From (supplier) — left block ──────────────────────────
  const metaTop = H - 105;   // = 736.89
  const supBaseY = metaTop - 27;  // = 709.89
  const supVals = [
    batch.supplier_name        ?? "",
    batch.head_office_address  ?? "",
    batch.contact_person       ?? "",
    `${batch.phone ?? ""}  ${batch.email ?? ""}`.trim(),
    batch.tax_id               ?? "",
  ];
  supVals.forEach((val, i) => w(val, ML + 92, supBaseY - i * 15, 8.5));

  // ── Meta: GRN Reference — right block ────────────────────────────────────
  const RX = 595.28 / 2 + 10;  // = 307.64
  const warehouseLoc = (items[0] as any)?.warehouse_location ?? "";
  const refVals = [
    batch.batch_number            ?? "",
    fmtDate(batch.received_at),
    batch.received_by_email       ?? "",
    batch.po_no                   ?? "",
    warehouseLoc,
  ];
  refVals.forEach((val, i) => w(String(val), RX + 102, supBaseY - i * 15, 8.5));

  // ── Items table ───────────────────────────────────────────────────────────
  // COL positions from template generator:
  // no: ML, product: ML+24, serial: ML+134, imei: ML+249, price: ML+369, status: ML+444
  const tableTop   = metaTop - 112;  // = 624.89
  const colHeaderY = tableTop - 36;  // = 588.89
  const ROW_H      = 14;
  const N_ROWS     = 22;

  const formatKes = (n: number) => Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let subtotal = 0;
  items.slice(0, N_ROWS).forEach((item: any, i: number) => {
    const y    = colHeaderY - ROW_H - i * ROW_H;
    const price = Number(item.purchase_price ?? 0);
    subtotal += price;
    const productLabel = [item.product_code, item.product_name, item.device_model].filter(Boolean).join(" ").slice(0, 22);
    w(productLabel,                                          ML + 24 + 3,  y, 7.5);
    w(item.serial_number ?? "",                              ML + 134 + 3, y, 7.5);
    w((item.imei ?? item.mac_address ?? ""),                 ML + 249 + 3, y, 7.5);
    // price right-aligned in the price column (x: ML+369, w:75) → right edge = ML+369+75-4 = ML+440
    const priceStr = formatKes(price);
    const pw = font.widthOfTextAtSize(priceStr, 7.5);
    w(priceStr, ML + 440 - pw, y, 7.5);
    w(item.status ?? "Good",                                 ML + 444 + 5, y, 7.5);
  });

  // ── Summary totals ────────────────────────────────────────────────────────
  const rowY  = colHeaderY - ROW_H - N_ROWS * ROW_H;
  const sumY  = rowY + ROW_H - 16;            // = 278.89 approx

  const total    = items.length;
  const accepted = items.filter((x: any) => (x.status ?? "Good").toLowerCase() !== "rejected").length;
  const rejected = total - accepted;

  // Values right-aligned at W/2 - 15 = 282.64
  const sumValX = 595.28 / 2 - 20;
  const sumVals = [`${total}`, `${accepted}`, `${rejected}`];
  sumVals.forEach((v, i) => {
    const vw = font.widthOfTextAtSize(v, 9);
    w(v, sumValX - vw, sumY - 14 - i * 13, 9, true);
  });

  // Grand total cost right-aligned in summary
  const gtStr = `KES ${formatKes(subtotal)}`;
  const gtW   = fontB.widthOfTextAtSize(gtStr, 9);
  w(gtStr, sumValX - gtW, sumY - 55, 9, true);

  // ── Remarks / Notes ───────────────────────────────────────────────────────
  if (batch.notes) {
    const noteLines = (batch.notes as string).slice(0, 120).match(/.{1,60}/g) ?? [];
    noteLines.forEach((line, i) => w(line, RX + 5, sumY - 2 - i * 16, 8));
  }

  const pdfBytes = await pdfDoc.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${ req.query.disposition === "attachment" ? "attachment" : "inline" }; filename="GRN_${batch.batch_number}.pdf"`);
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  auditLog(req, "INV_GRN_PDF_VIEWED", "inv_procurement_batches", "Info", { batchNo: batch.batch_number }).catch(console.error);
  return res.send(Buffer.from(pdfBytes));
});

export default router;
