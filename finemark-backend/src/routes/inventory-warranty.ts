import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

const router = Router();

// ── Tables ─────────────────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS inv_warranty_tickets (
    id TEXT PRIMARY KEY,
    ticket_no TEXT NOT NULL UNIQUE,
    item_id TEXT NOT NULL,
    product_id TEXT,
    supplier_id TEXT,
    customer_id TEXT,
    installation_id TEXT,
    direction TEXT NOT NULL DEFAULT 'Inbound',
    issue_description TEXT,
    reported_by TEXT,
    status TEXT NOT NULL DEFAULT 'Open',
    defect_confirmed INTEGER DEFAULT 0,
    defect_confirmed_by TEXT,
    defect_confirmed_at TEXT,
    supplier_claim_ref TEXT,
    supplier_claim_sent_at TEXT,
    replacement_item_id TEXT,
    replacement_received_at TEXT,
    resolved_at TEXT,
    resolved_by TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[inv_warranty_tickets] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_defect_records (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    warranty_ticket_id TEXT,
    defect_type TEXT,
    severity TEXT DEFAULT 'Medium',
    description TEXT NOT NULL,
    logged_by_user_id TEXT,
    logged_at TEXT NOT NULL,
    inspection_notes TEXT,
    action_taken TEXT,
    created_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[inv_defect_records] init:", e));

pgRun(`ALTER TABLE inv_warranty_tickets ADD COLUMN IF NOT EXISTS supplier_id TEXT`, []).catch(() => {});

pgRun(`CREATE INDEX IF NOT EXISTS idx_warranty_item ON inv_warranty_tickets(item_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_warranty_customer ON inv_warranty_tickets(customer_id)`, []).catch(() => {});

// ── Sequence helper ─────────────────────────────────────────────────────────────
async function nextTicketNo(direction: string): Promise<string> {
  const prefix = direction === "Outbound" ? "WO" : "WI";
  const last = await pgGet(
    `SELECT ticket_no FROM inv_warranty_tickets WHERE direction = ? ORDER BY created_at DESC LIMIT 1`,
    [direction]
  );
  if (!last) return `${prefix}-00001`;
  const n = parseInt(last.ticket_no.replace(`${prefix}-`, ""), 10) || 0;
  return `${prefix}-${String(n + 1).padStart(5, "0")}`;
}

// ── GET /  ────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Technical"]), async (req, res) => {
  const { direction, status, customerId, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset  = (pageNum - 1) * sizeNum;
  const filters = ["wt.deleted_at IS NULL"];
  const params: any[] = [];
  if (direction)  { filters.push("wt.direction = ?");    params.push(direction); }
  if (status)     { filters.push("wt.status = ?");       params.push(status); }
  if (customerId) { filters.push("wt.customer_id = ?");  params.push(customerId); }
  const where = `WHERE ${filters.join(" AND ")}`;
  const rows = await pgAll(
    `SELECT wt.*, p.product_code, p.product_name, i.serial_number, i.imei
     FROM inv_warranty_tickets wt
     LEFT JOIN inv_items i ON i.id = wt.item_id
     LEFT JOIN inv_product_catalog p ON p.id = wt.product_id
     ${where} ORDER BY wt.created_at DESC LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM inv_warranty_tickets wt ${where}`, params);
  return ok(res, { data: rows, meta: { total: Number(totalRow?.total ?? 0) } });
});

// ── POST /  — open a warranty ticket ─────────────────────────────────────────
router.post("/", requireAuth, requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Technical", "Support"]), async (req: AuthRequest, res) => {
  const { itemId, customerId, installationId, direction = "Inbound", issueDescription, reportedBy, notes, supplierId } = req.body;
  if (!itemId || !issueDescription)
    return errorResponse(res, 400, "MISSING_FIELD", "itemId and issueDescription are required.");

  const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [itemId]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Device not found.");

  const now      = new Date().toISOString();
  const id       = uuidv4();
  const ticketNo = await nextTicketNo(direction);

  // Check warranty status
  const warrantyValid = item.warranty_expires_at && new Date(item.warranty_expires_at) > new Date();
  if (!warrantyValid && direction === "Inbound") {
    // Still allow, but log warning
    console.warn(`[warranty] Ticket ${ticketNo} opened for out-of-warranty device ${item.id}`);
  }

  await pgRun(
    `INSERT INTO inv_warranty_tickets
       (id,ticket_no,item_id,product_id,supplier_id,customer_id,installation_id,direction,
        issue_description,reported_by,status,notes,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, ticketNo, itemId, item.product_id, supplierId||item.supplier_id||null,
     customerId||item.customer_id||null, installationId||null,
     direction, issueDescription, reportedBy||null, "Open", notes||null, now, now]
  );
  auditLog(req, "WARRANTY_TICKET_OPENED", "inv_warranty_tickets", "Info", { ticketNo, direction }).catch(console.error);
  const row = await pgGet("SELECT * FROM inv_warranty_tickets WHERE id = ?", [id]);
  return created(res, { data: row }, `Warranty ticket ${ticketNo} opened.`);
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Technical", "Support"]), async (req, res) => {
  const ticket = await pgGet(
    `SELECT wt.*, i.serial_number, i.imei, i.status as device_status, i.warranty_expires_at,
            p.product_code, p.product_name, p.device_model
     FROM inv_warranty_tickets wt
     LEFT JOIN inv_items i ON i.id = wt.item_id
     LEFT JOIN inv_product_catalog p ON p.id = wt.product_id
     WHERE wt.id = ? AND wt.deleted_at IS NULL`, [req.params.id]
  );
  if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Warranty ticket not found.");
  const defects = await pgAll("SELECT * FROM inv_defect_records WHERE warranty_ticket_id = ? ORDER BY created_at", [req.params.id]);
  return ok(res, { data: { ...ticket, defects } });
});

// ── POST /:id/confirm-defect ──────────────────────────────────────────────────
router.post("/:id/confirm-defect", requireAuth, requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Technical"]), async (req: AuthRequest, res) => {
  const ticket = await pgGet("SELECT * FROM inv_warranty_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Warranty ticket not found.");
  if (ticket.defect_confirmed) return errorResponse(res, 400, "ALREADY_CONFIRMED", "Defect already confirmed.");

  const { defectType, severity, inspectionNotes, actionTaken } = req.body;
  const now = new Date().toISOString();
  const defectId = uuidv4();

  await pgRun(
    `INSERT INTO inv_defect_records (id,item_id,warranty_ticket_id,defect_type,severity,description,logged_by_user_id,logged_at,inspection_notes,action_taken,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [defectId, ticket.item_id, ticket.id, defectType||"Hardware", severity||"Medium",
     ticket.issue_description, req.user!.id, now, inspectionNotes||null, actionTaken||null, now]
  );
  await pgRun("UPDATE inv_warranty_tickets SET defect_confirmed=1, defect_confirmed_by=?, defect_confirmed_at=?, status='Defect Confirmed', updated_at=? WHERE id=?",
    [req.user!.id, now, now, ticket.id]);
  // Mark device defective
  await pgRun("UPDATE inv_items SET status='Defective', updated_at=? WHERE id=?", [now, ticket.item_id]);
  await pgRun(
    `INSERT INTO inv_movements (id,item_id,product_id,action,from_status,to_status,performed_by_user_id,performed_by_email,notes,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [uuidv4(), ticket.item_id, ticket.product_id, "DEFECT_CONFIRMED", "Returned", "Defective",
     req.user!.id, req.user!.email||"", `Warranty ticket: ${ticket.ticket_no}`, now]
  );
  auditLog(req, "DEFECT_CONFIRMED", "inv_warranty_tickets", "Warning", { ticketNo: ticket.ticket_no }).catch(console.error);
  return ok(res, null, "Defect confirmed and device marked defective.");
});

// ── POST /:id/create-supplier-claim ──────────────────────────────────────────
router.post("/:id/create-supplier-claim", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const ticket = await pgGet("SELECT * FROM inv_warranty_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Warranty ticket not found.");
  if (!ticket.defect_confirmed) return errorResponse(res, 400, "DEFECT_NOT_CONFIRMED", "Confirm defect first.");
  const { supplierClaimRef, notes } = req.body;
  if (!supplierClaimRef) return errorResponse(res, 400, "MISSING_FIELD", "supplierClaimRef required.");
  const now = new Date().toISOString();
  await pgRun(
    "UPDATE inv_warranty_tickets SET supplier_claim_ref=?, supplier_claim_sent_at=?, status='Supplier Claim Raised', notes=?, updated_at=? WHERE id=?",
    [supplierClaimRef, now, notes||ticket.notes, now, ticket.id]
  );
  // Mark device as Sent to Supplier
  await pgRun("UPDATE inv_items SET status='Sent to Supplier', updated_at=? WHERE id=?", [now, ticket.item_id]);
  await pgRun(
    `INSERT INTO inv_movements (id,item_id,product_id,action,from_status,to_status,performed_by_user_id,performed_by_email,notes,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [uuidv4(), ticket.item_id, ticket.product_id, "SENT_TO_SUPPLIER", "Defective", "Sent to Supplier",
     req.user!.id, req.user!.email||"", `Claim ref: ${supplierClaimRef}`, now]
  );
  auditLog(req, "SUPPLIER_CLAIM_RAISED", "inv_warranty_tickets", "Info", { ticketNo: ticket.ticket_no, supplierClaimRef }).catch(console.error);
  return ok(res, null, "Supplier claim raised. Device marked as Sent to Supplier.");
});

// ── POST /:id/receive-replacement ─────────────────────────────────────────────
router.post("/:id/receive-replacement", requireAuth, requireRole(["Admin", "InventoryManager", "WarehouseOfficer"]), async (req: AuthRequest, res) => {
  const ticket = await pgGet("SELECT * FROM inv_warranty_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Warranty ticket not found.");
  if (ticket.status !== "Supplier Claim Raised") return errorResponse(res, 400, "INVALID_STATUS", "Ticket must be in Supplier Claim Raised status.");

  const { replacementItemId, serialNumber, imei, warehouseLocation, notes } = req.body;
  let newItemId = replacementItemId;
  const now = new Date().toISOString();

  if (!newItemId && imei) {
    // Auto-register replacement device
    const product = await pgGet("SELECT * FROM inv_product_catalog WHERE id = ?", [ticket.product_id]);
    const warrantyExpires = product?.warranty_months
      ? new Date(new Date().setMonth(new Date().getMonth() + product.warranty_months)).toISOString()
      : null;
    newItemId = uuidv4();
    await pgRun(
      `INSERT INTO inv_items (id,product_id,serial_number,imei,supplier_id,purchase_date,warehouse_location,status,warranty_expires_at,notes,created_by_user_id,received_by_user_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newItemId, ticket.product_id, serialNumber||null, imei, null, now.slice(0,10),
       warehouseLocation||null, "In Stock", warrantyExpires, `Replacement for warranty ${ticket.ticket_no}`,
       req.user!.id, req.user!.id, now, now]
    );
    await pgRun(
      `INSERT INTO inv_movements (id,item_id,product_id,action,from_status,to_status,from_location,to_location,performed_by_user_id,performed_by_email,notes,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), newItemId, ticket.product_id, "RECEIVED", null, "In Stock", "Supplier",
       warehouseLocation||"Warehouse", req.user!.id, req.user!.email||"", `Warranty replacement: ${ticket.ticket_no}`, now]
    );
  }

  await pgRun(
    "UPDATE inv_warranty_tickets SET replacement_item_id=?, replacement_received_at=?, status='Replacement Received', notes=?, updated_at=? WHERE id=?",
    [newItemId||null, now, notes||ticket.notes, now, ticket.id]
  );
  auditLog(req, "WARRANTY_REPLACEMENT_RECEIVED", "inv_warranty_tickets", "Info", { ticketNo: ticket.ticket_no }).catch(console.error);
  return ok(res, { data: { replacementItemId: newItemId } }, "Replacement device received.");
});

// ── POST /:id/resolve ─────────────────────────────────────────────────────────
router.post("/:id/resolve", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const ticket = await pgGet("SELECT * FROM inv_warranty_tickets WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Warranty ticket not found.");
  if (ticket.status === "Resolved") return errorResponse(res, 400, "ALREADY_RESOLVED", "Already resolved.");
  const now = new Date().toISOString();
  await pgRun("UPDATE inv_warranty_tickets SET status='Resolved', resolved_at=?, resolved_by=?, updated_at=? WHERE id=?",
    [now, req.user!.id, now, ticket.id]);
  auditLog(req, "WARRANTY_TICKET_RESOLVED", "inv_warranty_tickets", "Info", { ticketNo: ticket.ticket_no }).catch(console.error);
  return ok(res, null, "Warranty ticket resolved.");
});

// ── GET /stats/summary ────────────────────────────────────────────────────────
router.get("/stats/summary", requireAuth, requireRole(["Admin", "InventoryManager", "WarehouseOfficer"]), async (_req, res) => {
  // inv_warranty_tickets counts (legacy inbound/outbound)
  const wRows = await pgAll(
    "SELECT direction, status, COUNT(*) as count FROM inv_warranty_tickets WHERE deleted_at IS NULL GROUP BY direction, status", []
  );
  // device-custody defect report counts → feeds Inbound (Reported/UnderTest) and Resolved (Cleared)
  const drRows = await pgAll(
    "SELECT status, COUNT(*) as count FROM di_defect_reports GROUP BY status", []
  );
  const drCount = (s: string) => Number(drRows.find((r: any) => r.status === s)?.count ?? 0);
  const openInboundDR   = drCount("Reported") + drCount("UnderTest");
  const resolvedDR      = drCount("Cleared");
  // supplier return ticket counts → feeds Outbound (Open/Sent/Acknowledged) and Supplier Claims
  const srtRows = await pgAll(
    "SELECT status, COUNT(*) as count FROM di_supplier_return_tickets GROUP BY status", []
  );
  const srtCount = (s: string) => Number(srtRows.find((r: any) => r.status === s)?.count ?? 0);
  const openOutboundSRT  = srtCount("Open") + srtCount("Sent") + srtCount("Acknowledged");
  const supplierClaimSRT = srtCount("Open") + srtCount("Sent") + srtCount("Acknowledged") + srtCount("Closed");
  // Legacy warranty ticket aggregates
  const g = (d: string, s: string) => Number(wRows.find((r: any) => r.direction === d && r.status === s)?.count ?? 0);
  return ok(res, {
    data: wRows,
    summary: {
      openInbound:    g("Inbound",  "Open")   + openInboundDR,
      openOutbound:   g("Outbound", "Open")   + openOutboundSRT,
      resolved:       wRows.filter((r: any) => r.status === "Resolved").reduce((a: number, b: any) => a + Number(b.count), 0) + resolvedDR,
      supplierClaims: wRows.filter((r: any) => r.status === "Supplier Claim Raised").reduce((a: number, b: any) => a + Number(b.count), 0) + supplierClaimSRT,
    },
  });
});

export default router;
