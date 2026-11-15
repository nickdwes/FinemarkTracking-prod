import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun, pgExec } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS, ROLES } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { nextDatedBatchNumber } from "../utils/batchNumber.js";

const router = Router();

// Roles allowed to move a retrieved device through its lifecycle (assign custody,
// return to inventory). ISO (InstallOffice) + technical team + inventory managers.
const RETRIEVAL_MANAGE = [
  ROLES.ADMIN, ROLES.INVENTORY_MGR, ROLES.TECHNICAL, ROLES.INSTALL_OFFICE, ROLES.TECHNICIAN,
];

// ── Bootstrap ────────────────────────────────────────────────────────────────
// One row per gadget/SIM retrieved from a vehicle (uninstall / swap / gadget
// issue). It is a rich audit overlay on top of inv_items custody + inv_movements
// — the device's live state still lives on inv_items; this records the retrieval
// event, its full context, and where the device is in the retrieval lifecycle.
(async () => {
  await pgExec(`
    CREATE TABLE IF NOT EXISTS device_retrievals (
      id TEXT PRIMARY KEY,
      retrieval_no TEXT UNIQUE,
      device_item_id TEXT,
      device_serial TEXT,
      device_imei TEXT,
      product_id TEXT,
      product_name TEXT,
      device_model TEXT,
      sim_id TEXT,
      sim_iccid TEXT,
      sim_msisdn TEXT,
      vehicle_id TEXT,
      vehicle_registration TEXT,
      installation_id TEXT,
      job_card_ref TEXT,
      installation_location TEXT,
      mount_position TEXT,
      support_ticket_id TEXT,
      ticket_no TEXT,
      retrieval_type TEXT NOT NULL DEFAULT 'Other',
      reason TEXT,
      previous_status TEXT,
      new_status TEXT,
      technician_id TEXT,
      technician_name TEXT,
      retrieved_at TEXT,
      processed_by_user_id TEXT,
      processed_by_email TEXT,
      current_status TEXT NOT NULL DEFAULT 'In Custody',
      current_custodian_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await pgRun(`ALTER TABLE device_retrievals ADD COLUMN IF NOT EXISTS mount_position TEXT`).catch(() => {});
  for (const idx of [
    `CREATE INDEX IF NOT EXISTS idx_device_retrievals_device ON device_retrievals(device_item_id)`,
    `CREATE INDEX IF NOT EXISTS idx_device_retrievals_ticket ON device_retrievals(support_ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_device_retrievals_tech ON device_retrievals(technician_id)`,
    `CREATE INDEX IF NOT EXISTS idx_device_retrievals_type ON device_retrievals(retrieval_type)`,
    `CREATE INDEX IF NOT EXISTS idx_device_retrievals_status ON device_retrievals(current_status)`,
  ]) {
    await pgRun(idx).catch(() => {});
  }
})().catch((e) => console.error("[device-retrievals] bootstrap failed", e));

// ── Helper: record a retrieval (shared with crm-tickets uninstall/swap/retrieve) ─
export async function recordRetrieval(opts: {
  device: any;                    // inv_items row (ideally with product_name/device_model joined)
  sim?: any | null;               // inv_sims row
  vehicleId?: string | null;
  vehicleRegistration?: string | null;
  installationId?: string | null;
  jobCardRef?: string | null;
  installationLocation?: string | null;
  mountPosition?: string | null;
  supportTicketId?: string | null;
  ticketNo?: string | null;
  retrievalType: "Uninstallation" | "Swap" | "GadgetIssue" | "Other";
  reason?: string | null;
  previousStatus?: string | null;
  newStatus?: string | null;
  technicianId?: string | null;
  technicianName?: string | null;
  processedByUserId?: string | null;
  processedByEmail?: string | null;
}): Promise<any> {
  const now = new Date().toISOString();
  const d = opts.device || {};
  // Retry on the UNIQUE(retrieval_no) constraint — multiple devices retrieved in
  // one action, or concurrent actions, can otherwise collide on the day sequence.
  let row: any = null;
  for (let attempt = 0; attempt < 20 && !row; attempt++) {
    const id = uuidv4();
    const retrievalNo = await nextDatedBatchNumber("RET", [{ table: "device_retrievals", column: "retrieval_no" }]);
    try {
      await pgRun(
        `INSERT INTO device_retrievals
          (id, retrieval_no, device_item_id, device_serial, device_imei, product_id, product_name, device_model,
           sim_id, sim_iccid, sim_msisdn, vehicle_id, vehicle_registration, installation_id, job_card_ref,
           installation_location, mount_position, support_ticket_id, ticket_no, retrieval_type, reason, previous_status, new_status,
           technician_id, technician_name, retrieved_at, processed_by_user_id, processed_by_email,
           current_status, current_custodian_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, retrievalNo, d.id || null, d.serial_number || null, d.imei || null, d.product_id || null,
         d.product_name || null, d.device_model || null,
         opts.sim?.id || null, opts.sim?.iccid || null, opts.sim?.msisdn || null,
         opts.vehicleId || null, opts.vehicleRegistration || null, opts.installationId || null,
         opts.jobCardRef || null, opts.installationLocation || null, opts.mountPosition || null,
         opts.supportTicketId || null, opts.ticketNo || null, opts.retrievalType, opts.reason || null,
         opts.previousStatus || null, opts.newStatus || null,
         opts.technicianId || null, opts.technicianName || null, now,
         opts.processedByUserId || null, opts.processedByEmail || null,
         "In Custody", opts.technicianId || null, now, now]
      );
      row = await pgGet("SELECT * FROM device_retrievals WHERE id = ?", [id]);
    } catch (e: any) {
      if (e?.code === "23505") continue; // retrieval_no collision → regenerate
      throw e;
    }
  }
  return row;
}

function mapRetrieval(r: any) {
  return {
    id: r.id,
    retrievalNo: r.retrieval_no,
    deviceItemId: r.device_item_id,
    deviceSerial: r.device_serial,
    deviceImei: r.device_imei,
    productName: r.product_name,
    deviceModel: r.device_model,
    simId: r.sim_id,
    simIccid: r.sim_iccid,
    simMsisdn: r.sim_msisdn,
    vehicleId: r.vehicle_id,
    vehicleRegistration: r.vehicle_registration,
    installationId: r.installation_id,
    jobCardRef: r.job_card_ref,
    installationLocation: r.installation_location,
    mountPosition: r.mount_position,
    supportTicketId: r.support_ticket_id,
    ticketNo: r.ticket_no,
    retrievalType: r.retrieval_type,
    reason: r.reason,
    previousStatus: r.previous_status,
    newStatus: r.new_status,
    technicianId: r.technician_id,
    technicianName: r.technician_name,
    retrievedAt: r.retrieved_at,
    processedByEmail: r.processed_by_email,
    currentStatus: r.current_status,
    currentCustodianId: r.current_custodian_id,
    // live device state (joined in list/detail)
    deviceStatus: r.device_status ?? null,
    deviceIssuedToId: r.device_issued_to_id ?? null,
    deviceIssuedToName: r.device_issued_to_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── List — powers the "Retrieved Devices" tab ────────────────────────────────
router.get("/", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_VIEW), async (req, res) => {
  const { retrievalType, currentStatus, technicianId, vehicle, ticket, search, from, to, page = "1", pageSize = "100" } =
    req.query as Record<string, string>;
  const clauses: string[] = [];
  const params: any[] = [];
  if (retrievalType) { clauses.push("r.retrieval_type = ?"); params.push(retrievalType); }
  if (currentStatus) { clauses.push("r.current_status = ?"); params.push(currentStatus); }
  if (technicianId)  { clauses.push("r.technician_id = ?"); params.push(technicianId); }
  if (vehicle)       { clauses.push("r.vehicle_registration ILIKE ?"); params.push(`%${vehicle}%`); }
  if (ticket)        { clauses.push("r.ticket_no ILIKE ?"); params.push(`%${ticket}%`); }
  if (from)          { clauses.push("r.retrieved_at >= ?"); params.push(from); }
  if (to)            { clauses.push("r.retrieved_at <= ?"); params.push(to); }
  if (search) {
    clauses.push("(r.device_serial ILIKE ? OR r.device_imei ILIKE ? OR r.vehicle_registration ILIKE ? OR r.ticket_no ILIKE ? OR r.technician_name ILIKE ? OR r.retrieval_no ILIKE ?)");
    const s = `%${search}%`; params.push(s, s, s, s, s, s);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const ps = Math.min(parseInt(pageSize, 10) || 100, 500);
  const offset = (pg - 1) * ps;
  const rows = await pgAll(
    `SELECT r.*, i.status AS device_status, i.issued_to_id AS device_issued_to_id, i.issued_to_name AS device_issued_to_name
     FROM device_retrievals r
     LEFT JOIN inv_items i ON i.id = r.device_item_id
     ${where}
     ORDER BY r.retrieved_at DESC, r.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, ps, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) AS total FROM device_retrievals r ${where}`, params);
  return ok(res, { data: rows.map(mapRetrieval), meta: { total: Number(totalRow?.total ?? 0), page: pg, pageSize: ps } });
});

// ── Detail — record + the device's movement trail ────────────────────────────
router.get("/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_VIEW), async (req, res) => {
  const r = await pgGet(
    `SELECT r.*, i.status AS device_status, i.issued_to_id AS device_issued_to_id, i.issued_to_name AS device_issued_to_name
     FROM device_retrievals r LEFT JOIN inv_items i ON i.id = r.device_item_id WHERE r.id = ?`,
    [req.params.id]
  );
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Retrieval not found.");
  const movements = r.device_item_id
    ? await pgAll(
        `SELECT id, action, from_status, to_status, performed_by_email, notes, created_at
         FROM inv_movements WHERE item_id = ? ORDER BY created_at DESC`,
        [r.device_item_id]
      ).catch(() => [])
    : [];
  return ok(res, { data: { ...mapRetrieval(r), movements } });
});

// ── Assign / reassign custody to a technician ────────────────────────────────
router.post("/:id/assign-custody", requireAuth, requireRole(RETRIEVAL_MANAGE), async (req: AuthRequest, res) => {
  const { technicianUserId, technicianName } = req.body || {};
  if (!technicianUserId) return errorResponse(res, 400, "VALIDATION_ERROR", "technicianUserId is required.");

  const r = await pgGet("SELECT * FROM device_retrievals WHERE id = ?", [req.params.id]);
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Retrieval not found.");
  if (!r.device_item_id) return errorResponse(res, 400, "VALIDATION_ERROR", "This retrieval has no device to assign.");

  const device = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [r.device_item_id]);
  if (!device) return errorResponse(res, 404, "NOT_FOUND", "Device not found.");
  // Invariant: a device on a vehicle cannot also be in a technician's custody.
  if (device.status === "Installed" || device.installation_id) {
    return errorResponse(res, 409, "CONFLICT", "Device is currently installed on a vehicle and cannot be placed in custody.");
  }
  if (["Restocked", "Disposed", "Returned"].includes(r.current_status)) {
    return errorResponse(res, 409, "CONFLICT", `This device has already been returned to inventory (${r.current_status}).`);
  }

  // Custody ids span user / hr_employee / roster ids (My Custody resolves across
  // all of them), so trust the id supplied by the technicians list and resolve a
  // display name best-effort rather than hard-requiring a users row.
  const techUser = await pgGet("SELECT id, name, email FROM users WHERE id = ?", [technicianUserId]).catch(() => null);
  const techId = technicianUserId;
  const techName = (techUser?.name || techUser?.email || technicianName || technicianUserId);
  const now = new Date().toISOString();

  await pgRun(
    `UPDATE inv_items SET status = 'Awaiting Return', issued_to_id = ?, issued_to_name = ?, issued_at = ?, acknowledged_at = ?, updated_at = ? WHERE id = ?`,
    [techId, techName, now, now, now, device.id]
  );
  await pgRun(
    `UPDATE device_retrievals SET technician_id = ?, technician_name = ?, current_custodian_id = ?, current_status = 'In Custody', updated_at = ? WHERE id = ?`,
    [techId, techName, techId, now, r.id]
  );
  await pgRun(
    `INSERT INTO inv_movements (id, item_id, product_id, action, from_status, to_status, performed_by_user_id, performed_by_email, notes, created_at)
     VALUES (?, ?, ?, 'RETRIEVAL_CUSTODY_ASSIGNED', ?, 'Awaiting Return', ?, ?, ?, ?)`,
    [uuidv4(), device.id, device.product_id, device.status, req.user!.id, req.user!.email,
     `Retrieved device ${r.retrieval_no} assigned to ${techName}`, now]
  );
  // The paired SIM (retained on retrieval) follows the device to the new custodian.
  if (r.sim_id) {
    const sim = await pgGet("SELECT status FROM inv_sims WHERE id = ? AND deleted_at IS NULL", [r.sim_id]).catch(() => null);
    if (sim && sim.status === "issued") {
      await pgRun(`UPDATE inv_sims SET issued_to_id = ?, issued_to_name = ?, issued_at = ?, acknowledged_at = ?, updated_at = ? WHERE id = ?`, [techId, techName, now, now, now, r.sim_id]);
    }
  }
  auditLog(req, "DEVICE_RETRIEVAL_CUSTODY_ASSIGNED", `device_retrieval:${r.id}`, "Info", { technicianUserId, deviceItemId: device.id }).catch(console.error);
  const updated = await pgGet("SELECT * FROM device_retrievals WHERE id = ?", [r.id]);
  return ok(res, { data: mapRetrieval(updated) }, `Custody assigned to ${techName}.`);
});

// ── Return to inventory with an outcome ──────────────────────────────────────
router.post("/:id/return", requireAuth, requireRole(RETRIEVAL_MANAGE), async (req: AuthRequest, res) => {
  const { outcome, notes } = req.body || {};
  const OUTCOMES: Record<string, { status: string; retrieval: string; action: string }> = {
    Restock: { status: "In Stock",  retrieval: "Restocked", action: "RETRIEVAL_RESTOCKED" },
    Repair:  { status: "Defective", retrieval: "Repair",    action: "RETRIEVAL_TO_REPAIR" },
    Dispose: { status: "Disposed",  retrieval: "Disposed",  action: "RETRIEVAL_DISPOSED" },
  };
  const o = OUTCOMES[outcome];
  if (!o) return errorResponse(res, 400, "VALIDATION_ERROR", "outcome must be one of: Restock, Repair, Dispose.");

  const r = await pgGet("SELECT * FROM device_retrievals WHERE id = ?", [req.params.id]);
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Retrieval not found.");
  if (!r.device_item_id) return errorResponse(res, 400, "VALIDATION_ERROR", "This retrieval has no device.");
  if (["Restocked", "Disposed"].includes(r.current_status)) {
    return errorResponse(res, 409, "CONFLICT", `This device has already been finalised (${r.current_status}).`);
  }
  const device = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [r.device_item_id]);
  if (!device) return errorResponse(res, 404, "NOT_FOUND", "Device not found.");
  if (device.status === "Installed" || device.installation_id) {
    return errorResponse(res, 409, "CONFLICT", "Device is installed on a vehicle — cannot return to inventory.");
  }
  const now = new Date().toISOString();

  await pgRun(
    `UPDATE inv_items SET status = ?, issued_to_id = NULL, issued_to_name = NULL, acknowledged_at = NULL, updated_at = ? WHERE id = ?`,
    [o.status, now, device.id]
  );
  await pgRun(
    `UPDATE device_retrievals SET current_status = ?, current_custodian_id = NULL, new_status = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ?`,
    [o.retrieval, o.status, notes ? `${r.reason || ""}${r.reason ? " | " : ""}Return (${outcome}): ${notes}` : null, now, r.id]
  );
  await pgRun(
    `INSERT INTO inv_movements (id, item_id, product_id, action, from_status, to_status, performed_by_user_id, performed_by_email, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), device.id, device.product_id, o.action, device.status, o.status, req.user!.id, req.user!.email,
     `Retrieved device ${r.retrieval_no} returned to inventory (${outcome})${notes ? `: ${notes}` : ""}`, now]
  );
  // Free the retained SIM back to the available pool when the device is handed back.
  if (r.sim_id) {
    const sim = await pgGet("SELECT status FROM inv_sims WHERE id = ? AND deleted_at IS NULL", [r.sim_id]).catch(() => null);
    if (sim && sim.status === "issued") {
      await pgRun(`UPDATE inv_sims SET status = 'available', issued_to_id = NULL, issued_to_name = NULL, acknowledged_at = NULL, updated_at = ? WHERE id = ?`, [now, r.sim_id]);
      await pgRun(
        `INSERT INTO inv_sim_ledger (id, sim_id, action, from_status, to_status, actor_id, actor_email, notes, created_at) VALUES (?, ?, 'RETURNED_FROM_CUSTODY', 'issued', 'available', ?, ?, ?, ?)`,
        [uuidv4(), r.sim_id, req.user!.id, req.user!.email, `Freed to pool on retrieval return (${outcome})`, now]
      );
    }
  }
  auditLog(req, "DEVICE_RETRIEVAL_RETURNED", `device_retrieval:${r.id}`, "Info", { outcome, deviceItemId: device.id }).catch(console.error);
  const updated = await pgGet("SELECT * FROM device_retrievals WHERE id = ?", [r.id]);
  return ok(res, { data: mapRetrieval(updated) }, `Device returned to inventory (${outcome}).`);
});

export default router;
