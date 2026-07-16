import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

const router = Router();

// ── Table bootstrap ──────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_gadget_stock (
    id TEXT PRIMARY KEY,
    device_model TEXT NOT NULL,
    device_type TEXT NOT NULL,
    serial_number TEXT,
    imei TEXT,
    sim_phone TEXT,
    sim_serial TEXT,
    warehouse_location TEXT,
    status TEXT NOT NULL DEFAULT 'Available',
    reserved_for_quote_id TEXT,
    assigned_to_installation_id TEXT,
    assigned_by_user_id TEXT,
    assigned_at TEXT,
    issued_by_user_id TEXT,
    issued_at TEXT,
    received_at TEXT,
    received_by_user_id TEXT,
    notes TEXT,
    batch_no TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_gadget_stock] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_gadget_stock_status ON crm_gadget_stock(status)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_gadget_stock_model  ON crm_gadget_stock(device_model)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_gadget_stock_inst   ON crm_gadget_stock(assigned_to_installation_id)`, []).catch(() => {});

function mapItem(r: any) {
  return {
    id: r.id, deviceModel: r.device_model, deviceType: r.device_type,
    serialNumber: r.serial_number, imei: r.imei, simPhone: r.sim_phone, simSerial: r.sim_serial,
    warehouseLocation: r.warehouse_location, status: r.status,
    reservedForQuoteId: r.reserved_for_quote_id,
    assignedToInstallationId: r.assigned_to_installation_id,
    assignedByUserId: r.assigned_by_user_id, assignedAt: r.assigned_at,
    issuedByUserId: r.issued_by_user_id, issuedAt: r.issued_at,
    receivedAt: r.received_at, receivedByUserId: r.received_by_user_id,
    notes: r.notes, batchNo: r.batch_no, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ── GET /summary ─ stock summary by model ─────────────────────────────────────
router.get("/summary", requireAuth, requireRole(["Admin","Sales","Technical","Technician"]), async (_req, res) => {
  const rows = await pgAll(
    `SELECT device_model, device_type,
            COUNT(*) FILTER (WHERE status='Available') as available,
            COUNT(*) FILTER (WHERE status='Reserved')  as reserved,
            COUNT(*) FILTER (WHERE status='Assigned')  as assigned,
            COUNT(*) FILTER (WHERE status='Issued')    as issued,
            COUNT(*) FILTER (WHERE status='Decommissioned') as decommissioned,
            warehouse_location
     FROM crm_gadget_stock
     WHERE deleted_at IS NULL
     GROUP BY device_model, device_type, warehouse_location
     ORDER BY device_model`, []
  );
  return ok(res, { data: rows.map(r => ({
    deviceModel: r.device_model, deviceType: r.device_type,
    warehouseLocation: r.warehouse_location,
    available: Number(r.available), reserved: Number(r.reserved),
    assigned: Number(r.assigned), issued: Number(r.issued),
    decommissioned: Number(r.decommissioned),
  })) });
});

// ── GET / ─ list items with filters ──────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Admin","Sales","Technical","Technician"]), async (req: AuthRequest, res) => {
  const { status, deviceModel, deviceType, installationId, search, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset  = (pageNum - 1) * sizeNum;

  const filters: string[] = ["deleted_at IS NULL"];
  const params: any[] = [];
  if (status)         { filters.push("status = ?");                                params.push(status); }
  if (deviceModel)    { filters.push("device_model = ?");                          params.push(deviceModel); }
  if (deviceType)     { filters.push("device_type = ?");                           params.push(deviceType); }
  if (installationId) { filters.push("assigned_to_installation_id = ?");           params.push(installationId); }
  if (search)         {
    filters.push("(serial_number ILIKE ? OR imei ILIKE ? OR sim_phone ILIKE ? OR device_model ILIKE ?)");
    params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`);
  }

  const where = `WHERE ${filters.join(" AND ")}`;
  const rows     = await pgAll(`SELECT * FROM crm_gadget_stock ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, sizeNum, offset]);
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM crm_gadget_stock ${where}`, params);
  return ok(res, { data: rows.map(mapItem), meta: { total: Number(totalRow?.total ?? 0) } });
});

// ── POST / ─ receive new stock ─────────────────────────────────────────────────
router.post("/", requireAuth, requireRole(["Admin","Technical"]), async (req: AuthRequest, res) => {
  const { deviceModel, deviceType, serialNumber, imei, simPhone, simSerial,
          warehouseLocation, notes, batchNo, items } = req.body;

  const now = new Date().toISOString();
  const created_items: any[] = [];

  // Support bulk insert via `items` array or single item
  const toInsert = items?.length
    ? items
    : [{ deviceModel, deviceType, serialNumber, imei, simPhone, simSerial, warehouseLocation, notes, batchNo }];

  for (const item of toInsert) {
    if (!item.deviceModel || !item.deviceType)
      return errorResponse(res, 400, "MISSING_FIELD", "deviceModel and deviceType are required for each item.");
    const id = uuidv4();
    await pgRun(
      `INSERT INTO crm_gadget_stock
         (id,device_model,device_type,serial_number,imei,sim_phone,sim_serial,warehouse_location,
          status,notes,batch_no,received_at,received_by_user_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,item.deviceModel,item.deviceType,item.serialNumber||null,item.imei||null,
       item.simPhone||null,item.simSerial||null,item.warehouseLocation||null,"Available",
       item.notes||null,item.batchNo||null,now,req.user!.id,now,now]
    );
    const row = await pgGet("SELECT * FROM crm_gadget_stock WHERE id = ?", [id]);
    created_items.push(mapItem(row!));
  }

  auditLog(req, "GADGET_STOCK_RECEIVED", "crm_gadget_stock", "Info", { count: created_items.length }).catch(console.error);
  return created(res, { data: created_items }, `${created_items.length} item(s) added to stock.`);
});

// ── POST /:id/reserve ─ reserve for a quote ────────────────────────────────────
router.post("/:id/reserve", requireAuth, requireRole(["Admin","Sales","Technical"]), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT * FROM crm_gadget_stock WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  if (item.status !== "Available") return errorResponse(res, 409, "NOT_AVAILABLE", "Item is not available.");

  const { quoteId } = req.body;
  const now = new Date().toISOString();
  await pgRun(`UPDATE crm_gadget_stock SET status='Reserved', reserved_for_quote_id=?, updated_at=? WHERE id=?`,
    [quoteId || null, now, req.params.id]);
  return ok(res, { message: "Item reserved." });
});

// ── POST /:id/assign ─ assign to an installation ticket ───────────────────────
router.post("/:id/assign", requireAuth, requireRole(["Admin","Technical"]), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT * FROM crm_gadget_stock WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  if (!["Available","Reserved"].includes(item.status))
    return errorResponse(res, 409, "NOT_AVAILABLE", "Item must be Available or Reserved to assign.");

  const { installationId } = req.body;
  if (!installationId) return errorResponse(res, 400, "MISSING_FIELD", "installationId required.");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE crm_gadget_stock SET status='Assigned', assigned_to_installation_id=?, assigned_by_user_id=?, assigned_at=?, updated_at=? WHERE id=?`,
    [installationId, req.user!.id, now, now, req.params.id]
  );

  // Also upsert into vi_gadgets for the installation
  const existing = await pgGet(`SELECT id FROM vi_gadgets WHERE installation_id=? AND serial_number=?`, [installationId, item.serial_number]);
  if (!existing) {
    await pgRun(
      `INSERT INTO vi_gadgets (id,installation_id,device_type,device_model,serial_number,imei_enc,sim_number_enc,activation_status,installation_status,assigned_by_user_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(),installationId,item.device_type,item.device_model,item.serial_number||null,
       item.imei||null,item.sim_phone||null,"Inactive","Pending",req.user!.id,now,now]
    ).catch(() => {});
  }

  auditLog(req, "GADGET_ASSIGNED", "crm_gadget_stock", "Info", { itemId: req.params.id, installationId }).catch(console.error);
  return ok(res, { message: "Item assigned to installation." });
});

// ── POST /:id/issue ─ checkout/issue from warehouse ───────────────────────────
router.post("/:id/issue", requireAuth, requireRole(["Admin","Technical"]), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT * FROM crm_gadget_stock WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  if (!["Available","Reserved","Assigned"].includes(item.status))
    return errorResponse(res, 409, "INVALID_STATE", "Item cannot be issued in its current state.");

  const now = new Date().toISOString();
  await pgRun(`UPDATE crm_gadget_stock SET status='Issued', issued_by_user_id=?, issued_at=?, updated_at=? WHERE id=?`,
    [req.user!.id, now, now, req.params.id]);
  auditLog(req, "GADGET_ISSUED", "crm_gadget_stock", "Info", { itemId: req.params.id }).catch(console.error);
  return ok(res, { message: "Item issued from inventory." });
});

// ── POST /:id/return ───────────────────────────────────────────────────────────
router.post("/:id/return", requireAuth, requireRole(["Admin","Technical"]), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT * FROM crm_gadget_stock WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE crm_gadget_stock SET status='Available', assigned_to_installation_id=NULL, reserved_for_quote_id=NULL,
     assigned_by_user_id=NULL, assigned_at=NULL, issued_by_user_id=NULL, issued_at=NULL,
     notes=?, updated_at=? WHERE id=?`,
    [req.body.notes || item.notes, now, req.params.id]
  );
  return ok(res, { message: "Item returned to stock." });
});

// ── POST /:id/decommission ─────────────────────────────────────────────────────
router.post("/:id/decommission", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT * FROM crm_gadget_stock WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  await pgRun(`UPDATE crm_gadget_stock SET status='Decommissioned', notes=?, updated_at=? WHERE id=?`,
    [req.body.reason || item.notes, new Date().toISOString(), req.params.id]);
  return ok(res, { message: "Item decommissioned." });
});

export default router;
