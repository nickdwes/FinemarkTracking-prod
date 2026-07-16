/**
 * Device Custody & Issuance Management
 *
 * Manages tracker devices and SIM cards from inventory intake through
 * technician issuance, custody management, and installation job assignment.
 *
 * Flow:
 *   Clerk receives devices into inventory (POST /receive)
 *   → Clerk issues devices to technician  (POST /issue)
 *   → Technician acknowledges custody     (POST /issue/:id/acknowledge)
 *   → Technician/Officer links device to job (POST /assign-to-job)
 *   → Transfer between technicians        (POST /transfer)
 *   → Install depletes custody            (PATCH /devices/:id/installed)
 *
 * Security:
 *   – IMEI and SIM ICCID AES-256-GCM encrypted at rest
 *   – RBAC on every route; ABAC for technician own-device enforcement
 *   – Full audit trail on every mutation
 *   – Sensitive device identifiers masked for non-privileged roles
 *   – Reorder alerts pushed to inventory managers and admins
 */

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun, pgExec } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, resolveTechnicianIdSet } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { IdGenerator } from "../utils/idGenerator.js";
import { auditLog } from "../services/auditService.js";
import { encryptField, decryptField } from "../services/cryptoService.js";
import { createNotification } from "./notifications.js";
import { fetchTechnicalTeam } from "./technical-team.js";
import { isGraphConfigured, sendEmailViaGraph, MAILBOXES } from "../services/graphMailService.js";

const router = Router();

// ── Role groups ───────────────────────────────────────────────────────────────
const CLERK_ROLES  = ["Admin", "InventoryManager", "WarehouseOfficer"] as const;
const TECH_ROLES   = ["Technician", "Technical"] as const;
const VIEW_ROLES   = ["Admin", "InventoryManager", "WarehouseOfficer", "Technical", "Technician", "InstallOffice"] as const;

// ── Schema bootstrap ──────────────────────────────────────────────────────────
pgExec(`
  CREATE TABLE IF NOT EXISTS di_receive_batches (
    id                   TEXT PRIMARY KEY,
    batch_ref            TEXT UNIQUE NOT NULL,
    supplier_name        TEXT,
    device_count         INTEGER NOT NULL DEFAULT 0,
    received_by_user_id  TEXT NOT NULL,
    received_at          TEXT NOT NULL,
    notes                TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  )
`).catch(e => console.error("[di_receive_batches] init:", e));

pgExec(`
  CREATE TABLE IF NOT EXISTS di_tracker_devices (
    id                         TEXT PRIMARY KEY,
    receive_batch_id           TEXT,
    serial_number              TEXT NOT NULL,
    imei_enc                   TEXT,
    sim_iccid_enc              TEXT,
    device_model               TEXT,
    inventory_status           TEXT NOT NULL DEFAULT 'InInventory',
    inventory_location         TEXT,
    custodian_technician_id    TEXT,
    custodian_technician_email TEXT,
    custodian_assigned_at      TEXT,
    issuance_batch_id          TEXT,
    job_id                     TEXT,
    vehicle_id                 TEXT,
    vehicle_registration       TEXT,
    notes                      TEXT,
    created_by_user_id         TEXT NOT NULL,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    deleted_at                 TEXT
  )
`).catch(e => console.error("[di_tracker_devices] init:", e));

pgExec(`CREATE INDEX IF NOT EXISTS idx_di_dev_status    ON di_tracker_devices(inventory_status)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_dev_custodian ON di_tracker_devices(custodian_technician_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_dev_batch     ON di_tracker_devices(receive_batch_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_dev_job       ON di_tracker_devices(job_id)`).catch(() => {});

pgExec(`
  CREATE TABLE IF NOT EXISTS di_technician_custody_config (
    id                 TEXT PRIMARY KEY,
    technician_id      TEXT UNIQUE NOT NULL,
    technician_email   TEXT,
    region             TEXT,
    max_stock_level    INTEGER NOT NULL DEFAULT 10,
    min_stock_level    INTEGER NOT NULL DEFAULT 2,
    reorder_level      INTEGER NOT NULL DEFAULT 3,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  )
`).catch(e => console.error("[di_tech_custody_config] init:", e));

pgExec(`
  CREATE TABLE IF NOT EXISTS di_issuance_batches (
    id                  TEXT PRIMARY KEY,
    batch_ref           TEXT UNIQUE NOT NULL,
    technician_id       TEXT NOT NULL,
    technician_email    TEXT,
    clerk_user_id       TEXT NOT NULL,
    clerk_email         TEXT,
    device_count        INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'Pending',
    acknowledged_at     TEXT,
    rejection_reason    TEXT,
    notes               TEXT,
    issued_at           TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  )
`).catch(e => console.error("[di_issuance_batches] init:", e));

pgExec(`CREATE INDEX IF NOT EXISTS idx_di_iss_tech   ON di_issuance_batches(technician_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_iss_status ON di_issuance_batches(status)`).catch(() => {});

pgExec(`
  CREATE TABLE IF NOT EXISTS di_defect_reports (
    id                     TEXT PRIMARY KEY,
    device_id              TEXT NOT NULL,
    device_serial          TEXT NOT NULL,
    reported_by_user_id    TEXT NOT NULL,
    reported_by_email      TEXT,
    description            TEXT NOT NULL,
    photo_data             TEXT,
    status                 TEXT NOT NULL DEFAULT 'Reported',
    test_outcome           TEXT,
    test_notes             TEXT,
    tested_by_user_id      TEXT,
    tested_at              TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
  )
`).catch(e => console.error("[di_defect_reports] init:", e));

pgExec(`CREATE INDEX IF NOT EXISTS idx_di_defect_device  ON di_defect_reports(device_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_defect_status  ON di_defect_reports(status)`).catch(() => {});

// Reinstallation audit trail — records a "swap defective device on the spot"
// event triggered from a Technical support ticket (crm-tickets.ts POST
// /:id/swap-device). Lives here (not crm-tickets.ts) because it FKs into
// di_defect_reports, the report auto-created for the removed device.
pgExec(`
  CREATE TABLE IF NOT EXISTS di_reinstallations (
    id                     TEXT PRIMARY KEY,
    ticket_id              TEXT NOT NULL,
    ticket_no              TEXT,
    vehicle_id             TEXT,
    installation_id        TEXT NOT NULL,
    old_device_item_id     TEXT NOT NULL,
    old_device_serial      TEXT,
    new_device_item_id     TEXT NOT NULL,
    new_device_serial      TEXT,
    old_sim_id             TEXT,
    new_sim_id             TEXT,
    defect_report_id       TEXT NOT NULL,
    reason                 TEXT NOT NULL,
    performed_by_user_id   TEXT NOT NULL,
    performed_by_email     TEXT,
    created_at             TEXT NOT NULL
  )
`).catch(e => console.error("[di_reinstallations] init:", e));

pgExec(`CREATE INDEX IF NOT EXISTS idx_di_reinst_ticket  ON di_reinstallations(ticket_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_reinst_instl   ON di_reinstallations(installation_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_reinst_old_dev ON di_reinstallations(old_device_item_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_reinst_new_dev ON di_reinstallations(new_device_item_id)`).catch(() => {});

pgExec(`
  CREATE TABLE IF NOT EXISTS di_supplier_return_tickets (
    id                  TEXT PRIMARY KEY,
    defect_report_id    TEXT NOT NULL,
    device_id           TEXT NOT NULL,
    device_serial       TEXT NOT NULL,
    ticket_ref          TEXT UNIQUE NOT NULL,
    supplier_name       TEXT,
    status              TEXT NOT NULL DEFAULT 'Open',
    notes               TEXT,
    created_by_user_id  TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  )
`).catch(e => console.error("[di_supplier_return_tickets] init:", e));

pgExec(`CREATE INDEX IF NOT EXISTS idx_di_srt_defect  ON di_supplier_return_tickets(defect_report_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_srt_status  ON di_supplier_return_tickets(status)`).catch(() => {});

pgExec(`
  CREATE TABLE IF NOT EXISTS di_device_transfers (
    id                       TEXT PRIMARY KEY,
    device_id                TEXT NOT NULL,
    device_serial            TEXT,
    from_technician_id       TEXT NOT NULL,
    from_technician_email    TEXT,
    to_technician_id         TEXT NOT NULL,
    to_technician_email      TEXT,
    transfer_reason          TEXT,
    status                   TEXT NOT NULL DEFAULT 'Pending',
    initiated_by_user_id     TEXT NOT NULL,
    acknowledged_at          TEXT,
    rejection_reason         TEXT,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
  )
`).catch(e => console.error("[di_device_transfers] init:", e));

pgExec(`CREATE INDEX IF NOT EXISTS idx_di_xfer_device ON di_device_transfers(device_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_xfer_from   ON di_device_transfers(from_technician_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_xfer_to     ON di_device_transfers(to_technician_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_di_xfer_status ON di_device_transfers(status)`).catch(() => {});

// ── Helpers ───────────────────────────────────────────────────────────────────
function canSeeSensitive(role: string) {
  return ["Admin", "InventoryManager", "WarehouseOfficer", "Technical"].includes(role);
}

function mapDevice(d: any, showSensitive: boolean) {
  return {
    id: d.id,
    serialNumber: d.serial_number,
    imei: showSensitive
      ? (decryptField(d.imei_enc) || null)
      : (d.imei_enc ? "—encrypted—" : null),
    simIccid: showSensitive
      ? (decryptField(d.sim_iccid_enc) || null)
      : (d.sim_iccid_enc ? "—encrypted—" : null),
    deviceModel: d.device_model || null,
    inventoryStatus: d.inventory_status,
    inventoryLocation: d.inventory_location || null,
    custodianTechnicianId: d.custodian_technician_id || null,
    custodianTechnicianEmail: d.custodian_technician_email || null,
    custodianAssignedAt: d.custodian_assigned_at || null,
    issuanceBatchId: d.issuance_batch_id || null,
    jobId: d.job_id || null,
    vehicleId: d.vehicle_id || null,
    vehicleRegistration: d.vehicle_registration || null,
    receiveBatchId: d.receive_batch_id || null,
    receiveBatchRef: d.receive_batch_ref || null,
    notes: d.notes || null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function mapIssuanceBatch(b: any) {
  return {
    id: b.id,
    batchRef: b.batch_ref,
    technicianId: b.technician_id,
    technicianEmail: b.technician_email,
    clerkUserId: b.clerk_user_id,
    clerkEmail: b.clerk_email,
    deviceCount: b.device_count,
    status: b.status,
    acknowledgedAt: b.acknowledged_at || null,
    rejectionReason: b.rejection_reason || null,
    notes: b.notes || null,
    issuedAt: b.issued_at,
    createdAt: b.created_at,
  };
}

function mapTransfer(t: any) {
  return {
    id: t.id,
    deviceId: t.device_id,
    deviceSerial: t.device_serial,
    fromTechnicianId: t.from_technician_id,
    fromTechnicianEmail: t.from_technician_email,
    toTechnicianId: t.to_technician_id,
    toTechnicianEmail: t.to_technician_email,
    transferReason: t.transfer_reason || null,
    status: t.status,
    initiatedByUserId: t.initiated_by_user_id,
    acknowledgedAt: t.acknowledged_at || null,
    rejectionReason: t.rejection_reason || null,
    createdAt: t.created_at,
  };
}

async function nextReceiveBatchRef(): Promise<string> {
  const row = await pgGet(
    `SELECT batch_ref FROM di_receive_batches ORDER BY created_at DESC LIMIT 1`, []
  ).catch(() => null);
  let seq = 1;
  if (row?.batch_ref) {
    const m = row.batch_ref.match(/-(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  const yr = new Date().getFullYear();
  return `RCV-${yr}-${String(seq).padStart(4, "0")}`;
}

async function nextIssuanceBatchRef(): Promise<string> {
  const row = await pgGet(
    `SELECT batch_ref FROM di_issuance_batches ORDER BY created_at DESC LIMIT 1`, []
  ).catch(() => null);
  let seq = 1;
  if (row?.batch_ref) {
    const m = row.batch_ref.match(/-(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  const yr = new Date().getFullYear();
  return `ISS-${yr}-${String(seq).padStart(4, "0")}`;
}

function nextSupplierReturnTicketRef(): string {
  return IdGenerator.generateId("supplier_return");
}

/** DEV: redirect emails to DEV_NOTIFY_EMAIL if set */
function notifyEmail(addr: string): string {
  return process.env.DEV_NOTIFY_EMAIL || addr;
}

async function triggerReorderCheck(technicianId: string) {
  try {
    const config = await pgGet(
      `SELECT * FROM di_technician_custody_config WHERE technician_id = ?`,
      [technicianId]
    );
    if (!config) return;
    const cnt = await pgGet(
      `SELECT count(*) AS n FROM di_tracker_devices
       WHERE custodian_technician_id = ? AND inventory_status = 'InCustody' AND deleted_at IS NULL`,
      [technicianId]
    );
    const available = Number(cnt?.n || 0);
    if (available <= config.reorder_level) {
      const label = config.technician_email || technicianId;
      await createNotification({
        targetRole: "InventoryManager",
        type: "warning",
        title: "Reorder Alert: Technician Stock Low",
        body: `${label} has ${available} device(s) in custody (reorder level: ${config.reorder_level}). Issue more devices.`,
        link: "/device-issuance.html",
      });
      await createNotification({
        targetRole: "Admin",
        type: "warning",
        title: "Reorder Alert: Technician Stock Low",
        body: `${label} has ${available} device(s) in custody — at or below reorder level (${config.reorder_level}).`,
        link: "/device-issuance.html",
      });
    }
  } catch (_) { /* non-critical */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY INTAKE
// ═══════════════════════════════════════════════════════════════════════════════

// POST /receive — Clerk receives a batch of devices into inventory
router.post("/receive", requireAuth, requireRole([...CLERK_ROLES]), async (req: AuthRequest, res) => {
  const { supplierName, devices, notes } = req.body;
  if (!Array.isArray(devices) || devices.length === 0) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "devices array is required");
  }
  for (const d of devices) {
    if (!d.serialNumber?.trim()) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Each device must have a non-empty serialNumber");
    }
  }

  const now = new Date().toISOString();
  const batchId = uuidv4();
  const batchRef = await nextReceiveBatchRef();

  await pgRun(
    `INSERT INTO di_receive_batches (id, batch_ref, supplier_name, device_count, received_by_user_id, received_at, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [batchId, batchRef, supplierName || null, devices.length, req.user!.id, now, notes || null, now, now]
  );

  const inserted: string[] = [];
  for (const d of devices) {
    const serial = d.serialNumber.trim().toUpperCase();
    const existing = await pgGet(
      `SELECT id FROM di_tracker_devices WHERE serial_number = ? AND deleted_at IS NULL`, [serial]
    );
    if (existing) continue; // skip duplicates silently

    const devId = uuidv4();
    await pgRun(
      `INSERT INTO di_tracker_devices
         (id, receive_batch_id, serial_number, imei_enc, sim_iccid_enc, device_model,
          inventory_status, inventory_location, notes, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'InInventory', ?, ?, ?, ?, ?)`,
      [
        devId, batchId, serial,
        d.imei ? encryptField(d.imei.trim()) : null,
        d.simIccid ? encryptField(d.simIccid.trim()) : null,
        d.deviceModel || null,
        d.inventoryLocation || null,
        d.notes || null,
        req.user!.id, now, now,
      ]
    );
    inserted.push(devId);
  }

  auditLog(req, "DI_BATCH_RECEIVED", `di_receive_batches:${batchId}`, "Info",
    { batchRef, supplierName, deviceCount: inserted.length }).catch(console.error);

  return created(res, { batchId, batchRef, devicesCreated: inserted.length },
    `Batch ${batchRef} received — ${inserted.length} device(s) added to inventory`);
});

// GET /receive — List receive batches
router.get("/receive", requireAuth, requireRole([...CLERK_ROLES, "Technical", "InstallOffice"]), async (req: AuthRequest, res) => {
  const rows = await pgAll(
    `SELECT rb.*, u.email AS receiver_email
     FROM di_receive_batches rb
     LEFT JOIN users u ON u.id = rb.received_by_user_id
     ORDER BY rb.created_at DESC LIMIT 200`, []
  );
  return ok(res, rows.map((r: any) => ({
    id: r.id,
    batchRef: r.batch_ref,
    supplierName: r.supplier_name,
    deviceCount: r.device_count,
    receivedByUserId: r.received_by_user_id,
    receiverEmail: r.receiver_email,
    receivedAt: r.received_at,
    notes: r.notes,
    createdAt: r.created_at,
  })));
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEVICE INVENTORY
// ═══════════════════════════════════════════════════════════════════════════════

// GET /devices — List devices (with optional filters)
router.get("/devices", requireAuth, requireRole([...VIEW_ROLES]), async (req: AuthRequest, res) => {
  const { status, technicianId, batchId, search } = req.query as Record<string, string>;
  const conditions: string[] = ["d.deleted_at IS NULL"];
  const params: any[] = [];

  if (status) { conditions.push("d.inventory_status = ?"); params.push(status); }
  if (technicianId) { conditions.push("d.custodian_technician_id = ?"); params.push(technicianId); }
  if (batchId) { conditions.push("d.receive_batch_id = ?"); params.push(batchId); }
  if (search) {
    conditions.push("(d.serial_number ILIKE ? OR d.device_model ILIKE ? OR d.vehicle_registration ILIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = conditions.join(" AND ");
  const rows = await pgAll(
    `SELECT d.*, u.email AS custodian_email_ref, rb.batch_ref AS receive_batch_ref
     FROM di_tracker_devices d
     LEFT JOIN users u ON u.id = d.custodian_technician_id
     LEFT JOIN di_receive_batches rb ON rb.id = d.receive_batch_id
     WHERE ${where}
     ORDER BY d.created_at DESC LIMIT 500`,
    params
  );

  const sensitive = canSeeSensitive(req.user!.role);
  return ok(res, rows.map((d: any) => mapDevice(d, sensitive)));
});

// GET /devices/:id — Get single device (checks inv_items first, then di_tracker_devices)
router.get("/devices/:id", requireAuth, requireRole([...VIEW_ROLES]), async (req: AuthRequest, res) => {
  // Primary store: inv_items
  const item = await pgGet(
    `SELECT i.id, i.serial_number, i.imei, i.sim_phone, i.status, i.installation_id,
            p.device_model, p.product_name, p.requires_sim
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     WHERE i.id = ? AND i.deleted_at IS NULL`,
    [req.params.id]
  );
  if (item) {
    return ok(res, {
      id: item.id,
      serialNumber: item.serial_number,
      deviceModel: item.device_model || item.product_name || null,
      productName: item.product_name || null,
      imei: item.imei || null,
      simIccid: item.sim_phone || null,
      requiresSim: item.requires_sim !== false,
      inventoryStatus: item.installation_id ? "AssignedToJob" : "InCustody",
      jobId: item.installation_id || null,
    });
  }
  // Fall back to di_tracker_devices
  const d = await pgGet(
    `SELECT d.* FROM di_tracker_devices d WHERE d.id = ? AND d.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!d) return errorResponse(res, 404, "NOT_FOUND", "Device not found");
  const sensitive = canSeeSensitive(req.user!.role);
  return ok(res, mapDevice(d, sensitive));
});

// PATCH /devices/:id/status — Mark device faulty or returned (Clerks + Admin)
router.patch("/devices/:id/status", requireAuth, requireRole([...CLERK_ROLES]), async (req: AuthRequest, res) => {
  const { status, notes } = req.body;
  const allowed = ["Faulty", "Returned", "InInventory"];
  if (!allowed.includes(status)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", `status must be one of: ${allowed.join(", ")}`);
  }
  const d = await pgGet(
    `SELECT * FROM di_tracker_devices WHERE id = ? AND deleted_at IS NULL`, [req.params.id]
  );
  if (!d) return errorResponse(res, 404, "NOT_FOUND", "Device not found");

  const now = new Date().toISOString();
  const resetCustodianFields = status === "Returned" || status === "InInventory"
    ? ", custodian_technician_id = NULL, custodian_technician_email = NULL, custodian_assigned_at = NULL, issuance_batch_id = NULL"
    : "";

  await pgRun(
    `UPDATE di_tracker_devices SET inventory_status = ?, notes = ?, updated_at = ?${resetCustodianFields} WHERE id = ?`,
    [status, notes || d.notes, now, req.params.id]
  );

  auditLog(req, "DI_DEVICE_STATUS_UPDATED", `di_tracker_devices:${req.params.id}`, "Info",
    { previousStatus: d.inventory_status, newStatus: status }).catch(console.error);

  return ok(res, { id: req.params.id, status }, "Device status updated");
});

// ═══════════════════════════════════════════════════════════════════════════════
// TECHNICIAN CUSTODY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

// GET /technicians — List technicians with custody stats
// ?issueOnly=true  → only 'Technician' role (field technicians who physically receive devices)
// Delegates to the central /technical-team/members endpoint logic
router.get("/technicians", requireAuth, requireRole([...CLERK_ROLES, ...TECH_ROLES, "InstallOffice"]), async (req: AuthRequest, res) => {
  const issueOnly = req.query.issueOnly === "true";
  const roleFilter = issueOnly ? ("Technician" as const) : ("all" as const);

  const members = await fetchTechnicalTeam({ roleFilter, activeOnly: true });

  // Augment each member with custody stats + config
  const result = await Promise.all(members.map(async (t) => {
    const stats = await pgGet(
      `SELECT
         count(*) FILTER (WHERE inventory_status = 'InCustody')    AS in_custody,
         count(*) FILTER (WHERE inventory_status = 'AssignedToJob') AS assigned_to_job,
         count(*) FILTER (WHERE inventory_status = 'Installed')     AS installed,
         count(*) FILTER (WHERE inventory_status = 'IssuedToTechnician') AS pending_ack
       FROM di_tracker_devices
       WHERE custodian_technician_id = ? AND deleted_at IS NULL`,
      [t.id]
    ).catch(() => ({ in_custody: 0, assigned_to_job: 0, installed: 0, pending_ack: 0 }));

    const config = await pgGet(
      `SELECT * FROM di_technician_custody_config WHERE technician_id = ?`, [t.id]
    ).catch(() => null);

    return {
      id: t.id,
      email: t.email,
      name: t.fullName,
      fullName: t.fullName,
      memberRole: t.memberRole,
      jobRoleTitle: t.jobRoleTitle,
      inCustody: Number(stats.in_custody || 0),
      assignedToJob: Number(stats.assigned_to_job || 0),
      installed: Number(stats.installed || 0),
      pendingAck: Number(stats.pending_ack || 0),
      config: config ? {
        region: config.region,
        maxStockLevel: config.max_stock_level,
        minStockLevel: config.min_stock_level,
        reorderLevel: config.reorder_level,
      } : null,
    };
  }));

  return ok(res, result);
});

// GET /technicians/:id/config — Get custody config for a technician
router.get("/technicians/:id/config", requireAuth, requireRole([...CLERK_ROLES, ...TECH_ROLES]), async (req: AuthRequest, res) => {
  const config = await pgGet(
    `SELECT * FROM di_technician_custody_config WHERE technician_id = ?`, [req.params.id]
  );
  if (!config) return ok(res, null);
  return ok(res, {
    id: config.id,
    technicianId: config.technician_id,
    technicianEmail: config.technician_email,
    region: config.region,
    maxStockLevel: config.max_stock_level,
    minStockLevel: config.min_stock_level,
    reorderLevel: config.reorder_level,
    createdAt: config.created_at,
    updatedAt: config.updated_at,
  });
});

// PUT /technicians/:id/config — Upsert custody config (Clerks + Admin)
router.put("/technicians/:id/config", requireAuth, requireRole([...CLERK_ROLES]), async (req: AuthRequest, res) => {
  const { region, maxStockLevel, minStockLevel, reorderLevel, technicianEmail } = req.body;
  if (maxStockLevel == null || minStockLevel == null || reorderLevel == null) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "maxStockLevel, minStockLevel, and reorderLevel are required");
  }
  const now = new Date().toISOString();
  const existing = await pgGet(
    `SELECT id FROM di_technician_custody_config WHERE technician_id = ?`, [req.params.id]
  );

  if (existing) {
    await pgRun(
      `UPDATE di_technician_custody_config
       SET region = ?, max_stock_level = ?, min_stock_level = ?, reorder_level = ?, technician_email = ?, updated_at = ?
       WHERE technician_id = ?`,
      [region || null, Number(maxStockLevel), Number(minStockLevel), Number(reorderLevel), technicianEmail || null, now, req.params.id]
    );
  } else {
    const id = uuidv4();
    await pgRun(
      `INSERT INTO di_technician_custody_config (id, technician_id, technician_email, region, max_stock_level, min_stock_level, reorder_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, technicianEmail || null, region || null, Number(maxStockLevel), Number(minStockLevel), Number(reorderLevel), now, now]
    );
  }

  auditLog(req, "DI_CUSTODY_CONFIG_UPDATED", `di_tech_config:${req.params.id}`, "Info",
    { region, maxStockLevel, minStockLevel, reorderLevel }).catch(console.error);

  return ok(res, { technicianId: req.params.id }, "Custody configuration saved");
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEVICE ISSUANCE
// ═══════════════════════════════════════════════════════════════════════════════

// POST /issue — Clerk issues devices to a technician
router.post("/issue", requireAuth, requireRole([...CLERK_ROLES]), async (req: AuthRequest, res) => {
  const { technicianId, technicianEmail, deviceIds, notes } = req.body;
  if (!technicianId) return errorResponse(res, 400, "VALIDATION_ERROR", "technicianId is required");
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "deviceIds array is required");
  }

  // Verify all devices are available in inventory
  for (const devId of deviceIds) {
    const dev = await pgGet(
      `SELECT id, inventory_status FROM di_tracker_devices WHERE id = ? AND deleted_at IS NULL`, [devId]
    );
    if (!dev) return errorResponse(res, 404, "NOT_FOUND", `Device ${devId} not found`);
    if (dev.inventory_status !== "InInventory") {
      return errorResponse(res, 409, "DEVICE_NOT_AVAILABLE",
        `Device ${devId} is not in inventory (status: ${dev.inventory_status})`);
    }
  }

  const now = new Date().toISOString();
  const batchId = uuidv4();
  const batchRef = await nextIssuanceBatchRef();
  const clerkEmail = req.user!.email;

  await pgRun(
    `INSERT INTO di_issuance_batches
       (id, batch_ref, technician_id, technician_email, clerk_user_id, clerk_email, device_count, status, issued_at, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?)`,
    [batchId, batchRef, technicianId, technicianEmail || null, req.user!.id, clerkEmail, deviceIds.length, now, notes || null, now, now]
  );

  // Update each device status
  for (const devId of deviceIds) {
    await pgRun(
      `UPDATE di_tracker_devices
       SET inventory_status = 'IssuedToTechnician',
           custodian_technician_id = ?, custodian_technician_email = ?,
           issuance_batch_id = ?, updated_at = ?
       WHERE id = ?`,
      [technicianId, technicianEmail || null, batchId, now, devId]
    );
  }

  // Notify technician
  await createNotification({
    targetUserId: technicianId,
    type: "info",
    title: "Devices Issued to You",
    body: `${deviceIds.length} device(s) have been issued to you (batch ${batchRef}). Please acknowledge custody.`,
    link: "/technician-custody.html",
  }).catch(() => {});

  auditLog(req, "DI_DEVICES_ISSUED", `di_issuance_batches:${batchId}`, "Info",
    { batchRef, technicianId, technicianEmail, deviceCount: deviceIds.length }).catch(console.error);

  return created(res, { batchId, batchRef, deviceCount: deviceIds.length },
    `${deviceIds.length} device(s) issued to technician — awaiting acknowledgement`);
});

// GET /issue — List issuance batches
router.get("/issue", requireAuth, requireRole([...CLERK_ROLES, ...TECH_ROLES]), async (req: AuthRequest, res) => {
  const { status, technicianId } = req.query as Record<string, string>;
  const user = req.user!;

  const conditions: string[] = [];
  const params: any[] = [];

  // Technicians can only see their own issuances
  if (TECH_ROLES.some(r => r === user.role)) {
    conditions.push("b.technician_id = ?");
    params.push(user.id);
  } else {
    if (technicianId) { conditions.push("b.technician_id = ?"); params.push(technicianId); }
  }
  if (status) { conditions.push("b.status = ?"); params.push(status); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await pgAll(
    `SELECT b.* FROM di_issuance_batches b ${where} ORDER BY b.created_at DESC LIMIT 200`,
    params
  );

  // Attach device list to each batch
  const batches = await Promise.all(rows.map(async (b: any) => {
    const devices = await pgAll(
      `SELECT id, serial_number, device_model, inventory_status FROM di_tracker_devices WHERE issuance_batch_id = ? AND deleted_at IS NULL`,
      [b.id]
    );
    return { ...mapIssuanceBatch(b), devices: devices.map((d: any) => ({ id: d.id, serialNumber: d.serial_number, deviceModel: d.device_model, status: d.inventory_status })) };
  }));

  return ok(res, batches);
});

// POST /issue/:id/acknowledge — Technician acknowledges or rejects an issuance batch
router.post("/issue/:id/acknowledge", requireAuth, requireRole([...TECH_ROLES]), async (req: AuthRequest, res) => {
  const { action, rejectionReason } = req.body; // action: "accept" | "reject"
  if (!["accept", "reject"].includes(action)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "action must be 'accept' or 'reject'");
  }

  const batch = await pgGet(
    `SELECT * FROM di_issuance_batches WHERE id = ? AND status = 'Pending'`, [req.params.id]
  );
  if (!batch) return errorResponse(res, 404, "NOT_FOUND", "Issuance batch not found or already processed");

  // ABAC: technician must be the recipient
  if (batch.technician_id !== req.user!.id) {
    return errorResponse(res, 403, "FORBIDDEN", "You can only acknowledge your own issuances");
  }

  const now = new Date().toISOString();

  if (action === "accept") {
    await pgRun(
      `UPDATE di_issuance_batches SET status = 'Acknowledged', acknowledged_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, req.params.id]
    );
    // Move devices to InCustody
    await pgRun(
      `UPDATE di_tracker_devices SET inventory_status = 'InCustody', custodian_assigned_at = ?, updated_at = ? WHERE issuance_batch_id = ?`,
      [now, now, req.params.id]
    );

    auditLog(req, "DI_ISSUANCE_ACKNOWLEDGED", `di_issuance_batches:${req.params.id}`, "Info",
      { batchRef: batch.batch_ref, action: "accept" }).catch(console.error);

    // Notify clerk
    await createNotification({
      targetUserId: batch.clerk_user_id,
      type: "success",
      title: "Issuance Acknowledged",
      body: `Technician ${req.user!.email} accepted batch ${batch.batch_ref} (${batch.device_count} device(s)) into custody.`,
      link: "/device-issuance.html",
    }).catch(() => {});

    // Check if this created a reorder situation
    await triggerReorderCheck(req.user!.id);

    return ok(res, { batchId: req.params.id, status: "Acknowledged" }, "Devices accepted into custody");

  } else {
    await pgRun(
      `UPDATE di_issuance_batches SET status = 'Rejected', acknowledged_at = ?, rejection_reason = ?, updated_at = ? WHERE id = ?`,
      [now, rejectionReason || null, now, req.params.id]
    );
    // Return devices to InInventory
    await pgRun(
      `UPDATE di_tracker_devices
       SET inventory_status = 'InInventory', custodian_technician_id = NULL,
           custodian_technician_email = NULL, issuance_batch_id = NULL, custodian_assigned_at = NULL, updated_at = ?
       WHERE issuance_batch_id = ?`,
      [now, req.params.id]
    );

    auditLog(req, "DI_ISSUANCE_REJECTED", `di_issuance_batches:${req.params.id}`, "Warning",
      { batchRef: batch.batch_ref, rejectionReason }).catch(console.error);

    await createNotification({
      targetUserId: batch.clerk_user_id,
      type: "warning",
      title: "Issuance Rejected",
      body: `Technician ${req.user!.email} rejected batch ${batch.batch_ref}. Reason: ${rejectionReason || "not specified"}. Devices returned to inventory.`,
      link: "/device-issuance.html",
    }).catch(() => {});

    return ok(res, { batchId: req.params.id, status: "Rejected" }, "Issuance rejected — devices returned to inventory");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MY DEVICES (Technician self-service)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /my-devices — Technician's own devices in custody (queries inv_items as primary store)
router.get("/my-devices", requireAuth, requireRole([...TECH_ROLES, "Admin"]), async (req: AuthRequest, res) => {
  const techId = req.user!.id;

  const ids = [...(await resolveTechnicianIdSet(techId))];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");

  const rows = await pgAll(
    `SELECT i.id, i.serial_number, i.imei, i.sim_phone, i.status, i.installation_id,
            i.issued_to_id, i.issued_to_name, i.issued_at, i.acknowledged_at,
            p.device_model, p.product_name
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     WHERE i.issued_to_id IN (${placeholders})
       AND i.status = 'Issued for Installation'
       AND i.deleted_at IS NULL
     ORDER BY i.issued_at DESC`,
    ids
  );
  return ok(res, rows.map((d: any) => ({
    id: d.id,
    serialNumber: d.serial_number,
    deviceModel: d.device_model || d.product_name || null,
    imei: d.imei || null,
    simPhone: d.sim_phone || null,
    status: d.status,
    inventoryStatus: d.installation_id ? "AssignedToJob" : (d.acknowledged_at ? "InCustody" : "IssuedToTechnician"),
    jobId: d.installation_id || null,
    issuedAt: d.issued_at || null,
    acknowledgedAt: d.acknowledged_at || null,
  })));
});

// GET /my-history — Full interaction history for devices ever in this technician's custody
router.get("/my-history", requireAuth, requireRole([...TECH_ROLES, "Admin"]), async (req: AuthRequest, res) => {
  const techId = req.user!.id;

  const ids = [...(await resolveTechnicianIdSet(techId))];
  const ph1 = ids.map((_, i) => `$${i + 1}`).join(", ");
  const ph2 = ids.map((_, i) => `$${ids.length + i + 1}`).join(", ");

  // Collect all item IDs ever issued to this technician via issuance batches
  const issuedItems = await pgAll(
    `SELECT DISTINCT i.id
     FROM inv_items i
     WHERE i.issuance_batch_id IN (
       SELECT id FROM inv_issuance_batches WHERE technician_id IN (${ph1})
     )
     OR i.issued_to_id IN (${ph2})`,
    [...ids, ...ids]
  ).catch(() => [] as any[]);

  if (issuedItems.length === 0) {
    return ok(res, { data: [] });
  }

  const itemIds = issuedItems.map((r: any) => r.id);
  const itemPh  = itemIds.map((_: any, i: number) => `$${i + 1}`).join(", ");

  const rows = await pgAll(
    `SELECT m.id, m.item_id, m.action, m.from_status, m.to_status,
            m.performed_by_email, m.notes, m.created_at, m.installation_id,
            i.serial_number, i.imei,
            p.device_model, p.product_name
     FROM inv_movements m
     JOIN inv_items i ON i.id = m.item_id
     LEFT JOIN inv_product_catalog p ON p.id = i.product_id
     WHERE m.item_id IN (${itemPh})
     ORDER BY m.created_at DESC
     LIMIT 500`,
    itemIds
  );

  return ok(res, {
    data: rows.map((r: any) => ({
      id:           r.id,
      itemId:       r.item_id,
      serialNumber: r.serial_number,
      imei:         r.imei,
      deviceModel:  r.device_model || r.product_name || null,
      action:       r.action,
      fromStatus:   r.from_status,
      toStatus:     r.to_status,
      performedBy:  r.performed_by_email,
      notes:        r.notes,
      installationId: r.installation_id,
      createdAt:    r.created_at,
    })),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEVICE TRANSFERS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /transfer — Initiate a device transfer between technicians
router.post("/transfer", requireAuth, requireRole([...TECH_ROLES, "Admin"]), async (req: AuthRequest, res) => {
  const { deviceId, toTechnicianId, toTechnicianEmail, transferReason } = req.body;
  if (!deviceId || !toTechnicianId) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "deviceId and toTechnicianId are required");
  }

  const device = await pgGet(
    `SELECT * FROM di_tracker_devices WHERE id = ? AND deleted_at IS NULL`, [deviceId]
  );
  if (!device) return errorResponse(res, 404, "NOT_FOUND", "Device not found");

  // ABAC: source must own the device (unless Admin)
  if (req.user!.role !== "Admin" && device.custodian_technician_id !== req.user!.id) {
    return errorResponse(res, 403, "FORBIDDEN", "You can only transfer devices in your own custody");
  }
  if (!["InCustody"].includes(device.inventory_status)) {
    return errorResponse(res, 409, "DEVICE_NOT_AVAILABLE",
      `Device must be InCustody to transfer (current: ${device.inventory_status})`);
  }
  if (device.custodian_technician_id === toTechnicianId) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Cannot transfer to the same technician");
  }

  // Prevent duplicate pending transfers for same device
  const existingTransfer = await pgGet(
    `SELECT id FROM di_device_transfers WHERE device_id = ? AND status = 'Pending'`, [deviceId]
  );
  if (existingTransfer) {
    return errorResponse(res, 409, "TRANSFER_PENDING", "A transfer is already pending for this device");
  }

  const now = new Date().toISOString();
  const transferId = uuidv4();

  await pgRun(
    `INSERT INTO di_device_transfers
       (id, device_id, device_serial, from_technician_id, from_technician_email,
        to_technician_id, to_technician_email, transfer_reason, status, initiated_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?)`,
    [
      transferId, deviceId, device.serial_number,
      device.custodian_technician_id, device.custodian_technician_email,
      toTechnicianId, toTechnicianEmail || null,
      transferReason || null, req.user!.id, now, now,
    ]
  );

  // Notify receiving technician
  await createNotification({
    targetUserId: toTechnicianId,
    type: "info",
    title: "Device Transfer Request",
    body: `${device.custodian_technician_email || req.user!.email} wants to transfer device ${device.serial_number} to you. Please accept or reject.`,
    link: "/technician-custody.html",
  }).catch(() => {});

  auditLog(req, "DI_TRANSFER_INITIATED", `di_device_transfers:${transferId}`, "Info",
    { deviceId, deviceSerial: device.serial_number, fromTechnicianId: device.custodian_technician_id, toTechnicianId }).catch(console.error);

  return created(res, { transferId }, "Transfer request sent — awaiting acknowledgement from receiving technician");
});

// POST /transfer/:id/respond — Accept or reject a transfer
router.post("/transfer/:id/respond", requireAuth, requireRole([...TECH_ROLES, "Admin"]), async (req: AuthRequest, res) => {
  const { action, rejectionReason } = req.body;
  if (!["accept", "reject"].includes(action)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "action must be 'accept' or 'reject'");
  }

  const transfer = await pgGet(
    `SELECT * FROM di_device_transfers WHERE id = ? AND status = 'Pending'`, [req.params.id]
  );
  if (!transfer) return errorResponse(res, 404, "NOT_FOUND", "Transfer not found or already processed");

  // ABAC: only the receiving technician may respond (or Admin)
  if (req.user!.role !== "Admin" && transfer.to_technician_id !== req.user!.id) {
    return errorResponse(res, 403, "FORBIDDEN", "Only the receiving technician can respond to this transfer");
  }

  const now = new Date().toISOString();

  if (action === "accept") {
    // Update transfer record
    await pgRun(
      `UPDATE di_device_transfers SET status = 'Acknowledged', acknowledged_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, req.params.id]
    );
    // Move device custody
    await pgRun(
      `UPDATE di_tracker_devices
       SET custodian_technician_id = ?, custodian_technician_email = ?, custodian_assigned_at = ?, updated_at = ?
       WHERE id = ?`,
      [transfer.to_technician_id, transfer.to_technician_email, now, now, transfer.device_id]
    );

    auditLog(req, "DI_TRANSFER_ACCEPTED", `di_device_transfers:${req.params.id}`, "Info",
      { deviceId: transfer.device_id, deviceSerial: transfer.device_serial, toTechnicianId: transfer.to_technician_id }).catch(console.error);

    await createNotification({
      targetUserId: transfer.initiated_by_user_id,
      type: "success",
      title: "Transfer Accepted",
      body: `${transfer.to_technician_email || req.user!.email} accepted the transfer of device ${transfer.device_serial}.`,
      link: "/device-issuance.html",
    }).catch(() => {});

    // Check reorder for origin technician
    await triggerReorderCheck(transfer.from_technician_id);

    return ok(res, { transferId: req.params.id, status: "Acknowledged" }, "Transfer accepted — device custody updated");

  } else {
    await pgRun(
      `UPDATE di_device_transfers SET status = 'Rejected', acknowledged_at = ?, rejection_reason = ?, updated_at = ? WHERE id = ?`,
      [now, rejectionReason || null, now, req.params.id]
    );

    auditLog(req, "DI_TRANSFER_REJECTED", `di_device_transfers:${req.params.id}`, "Warning",
      { deviceId: transfer.device_id, rejectionReason }).catch(console.error);

    await createNotification({
      targetUserId: transfer.initiated_by_user_id,
      type: "warning",
      title: "Transfer Rejected",
      body: `${transfer.to_technician_email || req.user!.email} rejected transfer of device ${transfer.device_serial}. Reason: ${rejectionReason || "not specified"}.`,
      link: "/device-issuance.html",
    }).catch(() => {});

    return ok(res, { transferId: req.params.id, status: "Rejected" }, "Transfer rejected");
  }
});

// GET /transfers — List transfers (own transfers for technicians, all for clerks)
router.get("/transfers", requireAuth, requireRole([...VIEW_ROLES]), async (req: AuthRequest, res) => {
  const user = req.user!;
  const { status } = req.query as Record<string, string>;

  const conditions: string[] = [];
  const params: any[] = [];

  if (TECH_ROLES.some(r => r === user.role)) {
    conditions.push("(t.from_technician_id = ? OR t.to_technician_id = ?)");
    params.push(user.id, user.id);
  }
  if (status) { conditions.push("t.status = ?"); params.push(status); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await pgAll(
    `SELECT t.* FROM di_device_transfers t ${where} ORDER BY t.created_at DESC LIMIT 200`,
    params
  );
  return ok(res, rows.map(mapTransfer));
});

// ═══════════════════════════════════════════════════════════════════════════════
// JOB ASSIGNMENT DEVICE SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

// GET /available-for-job?technicianId=xxx — Devices in custody available for job assignment
// Queries inv_items (the primary device store), resolving hr_employee_id via roster for
// technicians whose user_account_id is not yet linked (e.g. roster-unlinked accounts).
router.get("/available-for-job", requireAuth, requireRole([...VIEW_ROLES]), async (req: AuthRequest, res) => {
  const { technicianId } = req.query as Record<string, string>;
  const techId = technicianId || req.user!.id;

  const ids = [...(await resolveTechnicianIdSet(techId))];
  const placeholders = ids.map(() => "?").join(", ");

  const rows = await pgAll(
    `SELECT i.id, i.serial_number, i.imei, i.sim_phone, i.status, i.installation_id,
            p.device_model, p.product_name, p.requires_sim
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     WHERE i.issued_to_id IN (${placeholders})
       AND i.status = 'Issued for Installation'
       AND i.acknowledged_at IS NOT NULL
       AND i.deleted_at IS NULL
     ORDER BY i.issued_at DESC`,
    ids
  );
  return ok(res, rows.map((d: any) => ({
    id: d.id,
    serialNumber: d.serial_number,
    deviceModel: d.device_model || d.product_name || null,
    productName: d.product_name || null,
    imei: d.imei || null,
    simIccid: d.sim_phone || null,
    requiresSim: d.requires_sim !== false,
    inventoryStatus: d.installation_id ? "AssignedToJob" : "InCustody",
    jobId: d.installation_id || null,
  })));
});

// POST /assign-to-job — Link a device to an installation job
// Checks inv_items first (primary store), falls back to di_tracker_devices.
router.post("/assign-to-job", requireAuth, requireRole([...TECH_ROLES, "Admin", "InstallOffice"]), async (req: AuthRequest, res) => {
  const { deviceId, jobId, vehicleId, vehicleRegistration, simIccid, msisdn } = req.body;
  if (!deviceId || !jobId) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "deviceId and jobId are required");
  }

  // Primary store: inv_items
  const invItem = await pgGet(
    `SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL`, [deviceId]
  );
  if (invItem) {
    if (invItem.status !== "Issued for Installation" || !invItem.acknowledged_at) {
      return errorResponse(res, 409, "DEVICE_NOT_AVAILABLE",
        "Device must be acknowledged in custody before assigning to a job");
    }
    const now = new Date().toISOString();
    // Record the SIM the technician paired with this device (if any) so the
    // pairing is visible wherever the device is shown, not just in the job card draft.
    await pgRun(
      `UPDATE inv_items SET installation_id = ?, updated_at = ?,
         sim_serial = COALESCE(?, sim_serial), sim_phone = COALESCE(?, sim_phone)
       WHERE id = ?`,
      [jobId, now, simIccid || null, msisdn || null, deviceId]
    );
    auditLog(req, "DI_DEVICE_ASSIGNED_TO_JOB", `inv_items:${deviceId}`, "Info",
      { deviceId, jobId, simIccid: simIccid || null }).catch(console.error);
    return ok(res, { deviceId, jobId, status: "AssignedToJob" }, "Device assigned to job");
  }

  // Fall back to di_tracker_devices
  const device = await pgGet(
    `SELECT * FROM di_tracker_devices WHERE id = ? AND deleted_at IS NULL`, [deviceId]
  );
  if (!device) return errorResponse(res, 404, "NOT_FOUND", "Device not found");
  if (device.inventory_status !== "InCustody") {
    return errorResponse(res, 409, "DEVICE_NOT_AVAILABLE",
      `Device must be InCustody to assign to a job (current: ${device.inventory_status})`);
  }
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE di_tracker_devices
     SET inventory_status = 'AssignedToJob', job_id = ?, vehicle_id = ?, vehicle_registration = ?, updated_at = ?
     WHERE id = ?`,
    [jobId, vehicleId || null, vehicleRegistration || null, now, deviceId]
  );
  auditLog(req, "DI_DEVICE_ASSIGNED_TO_JOB", `di_tracker_devices:${deviceId}`, "Info",
    { deviceId, jobId, vehicleRegistration }).catch(console.error);
  return ok(res, { deviceId, jobId, status: "AssignedToJob" }, "Device assigned to job");
});

// POST /return-defective — Technician hands a defective device back to inventory
router.post("/return-defective", requireAuth, requireRole([...TECH_ROLES, "Admin"]), async (req: AuthRequest, res) => {
  const { deviceId, notes } = req.body;
  if (!deviceId?.trim()) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "deviceId is required");
  }

  const device = await pgGet(
    `SELECT i.*, p.device_model, p.product_name
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     WHERE i.id = ? AND i.deleted_at IS NULL`,
    [deviceId]
  );
  if (!device) return errorResponse(res, 404, "NOT_FOUND", "Device not found");

  // Only allow returning Defective devices
  if (device.status !== "Defective") {
    return errorResponse(res, 400, "INVALID_STATUS", `Device is not in Defective status (current: ${device.status})`);
  }

  // Technicians may only return devices issued to them
  if ([...TECH_ROLES].includes(req.user!.role as any)) {
    const myIdRows = await pgAll(
      `SELECT r.id AS roster_id, r.hr_employee_id
       FROM technical_team_roster r
       WHERE r.user_account_id = ?
          OR (r.user_account_id IS NULL AND r.email IN (
               SELECT u.email FROM users u WHERE u.id = ?
             ))`,
      [req.user!.id, req.user!.id]
    ).catch(() => [] as any[]);
    const validIds = new Set<string>([req.user!.id]);
    if ((req.user as any).hrEmployeeId) validIds.add((req.user as any).hrEmployeeId);
    for (const r of myIdRows as any[]) {
      if (r.roster_id)     validIds.add(r.roster_id);
      if (r.hr_employee_id) validIds.add(r.hr_employee_id);
    }
    if (!device.issued_to_id || !validIds.has(device.issued_to_id)) {
      return errorResponse(res, 403, "FORBIDDEN", "You can only return devices that were issued to you");
    }
  }

  const now = new Date().toISOString();
  const prevIssuedTo = device.issued_to_name || device.issued_to_id;

  // Clear custody (preserve issued_to_name + issued_at for historical display)
  // Keep status Defective so InventoryManager can process it
  await pgRun(
    `UPDATE inv_items
     SET issued_to_id = NULL,
         acknowledged_at = NULL, issuance_batch_id = NULL,
         notes = COALESCE(NULLIF(notes,''), '') || CASE WHEN notes IS NOT NULL AND notes <> '' THEN ' | ' ELSE '' END || ?,
         updated_at = ?
     WHERE id = ?`,
    [`Returned by technician ${req.user!.email} on ${now}${notes ? ': ' + notes : ''}`, now, deviceId]
  );

  // Log movement
  await pgRun(
    `INSERT INTO inv_movements
       (id, item_id, product_id, action, from_status, to_status,
        performed_by_user_id, performed_by_email, notes, created_at)
     VALUES (?, ?, ?, 'RETURNED_DEFECTIVE', 'Defective', 'Defective', ?, ?, ?, ?)`,
    [uuidv4(), device.id, device.product_id,
     req.user!.id, req.user!.email,
     `Defective device returned by technician${notes ? ': ' + notes : ''}`, now]
  );

  auditLog(req, "DI_DEFECTIVE_RETURNED", `inv_items:${deviceId}`, "Warning",
    { deviceSerial: device.serial_number, notes }).catch(console.error);

  // Bell notification to InventoryManager + Admin
  for (const role of ["InventoryManager", "Admin"] as const) {
    createNotification({
      targetRole: role,
      type: "warning",
      title: `Defective Device Returned — ${device.serial_number}`,
      body: `${req.user!.email} has returned defective device ${device.serial_number} (${device.device_model || device.product_name}) to inventory for processing.${notes ? ' Notes: ' + notes : ''}`,
      link: "/inventory-warranty.html",
    }).catch(console.error);
  }

  // Email notification to InventoryManagers
  if (isGraphConfigured()) {
    const managers = await pgAll(
      `SELECT email FROM users WHERE role = 'InventoryManager' AND status = 'Active'`, []
    );
    for (const mgr of managers) {
      if (!mgr.email) continue;
      sendEmailViaGraph({
        fromMailbox: MAILBOXES.notification,
        to: notifyEmail(mgr.email),
        subject: `[Finemark] Defective Device Returned — ${device.serial_number}`,
        htmlBody: `
          <p>Hello,</p>
          <p>A defective device has been returned to inventory by a technician.</p>
          <table style="border-collapse:collapse;font-size:14px">
            <tr><td style="padding:4px 12px 4px 0;font-weight:600">Device Serial</td><td>${device.serial_number}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;font-weight:600">Model</td><td>${device.device_model || device.product_name || '—'}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;font-weight:600">Returned By</td><td>${req.user!.email}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;font-weight:600">Notes</td><td>${notes || '—'}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;font-weight:600">Returned At</td><td>${now}</td></tr>
          </table>
          <p>Please log in to review this device under the Defective inventory.</p>
          ${process.env.DEV_NOTIFY_EMAIL ? `<p style="color:orange;font-style:italic">[DEV MODE — original recipient: ${mgr.email}]</p>` : ''}
        `,
      }).catch(e => console.error("[return-defective] email:", e));
    }
  }

  return ok(res, { deviceId, deviceSerial: device.serial_number }, "Device returned to inventory successfully");
});

// POST /mark-installed — Mark device installed (called on installation completion)
// Checks inv_items first (primary store), falls back to di_tracker_devices.
router.post("/mark-installed", requireAuth, requireRole([...TECH_ROLES, "Admin", "InstallOffice"]), async (req: AuthRequest, res) => {
  const { deviceId, vehicleId, vehicleRegistration } = req.body;
  if (!deviceId) return errorResponse(res, 400, "VALIDATION_ERROR", "deviceId is required");

  // Primary store: inv_items
  const invItem = await pgGet(
    `SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL`, [deviceId]
  );
  if (invItem) {
    const now = new Date().toISOString();
    await pgRun(
      `UPDATE inv_items
       SET status = 'Installed', deployed_at = ?, issued_to_id = NULL, updated_at = ?
       WHERE id = ?`,
      [now, now, deviceId]
    );
    auditLog(req, "DI_DEVICE_INSTALLED", `inv_items:${deviceId}`, "Info",
      { deviceId, vehicleId, vehicleRegistration }).catch(console.error);
    return ok(res, { deviceId, status: "Installed" }, "Device marked as installed");
  }

  // Fall back to di_tracker_devices
  const device = await pgGet(
    `SELECT * FROM di_tracker_devices WHERE id = ? AND deleted_at IS NULL`, [deviceId]
  );
  if (!device) return errorResponse(res, 404, "NOT_FOUND", "Device not found");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE di_tracker_devices
     SET inventory_status = 'Installed', vehicle_id = ?, vehicle_registration = ?,
         custodian_technician_id = NULL, custodian_technician_email = NULL, updated_at = ?
     WHERE id = ?`,
    [vehicleId || device.vehicle_id, vehicleRegistration || device.vehicle_registration, now, deviceId]
  );
  auditLog(req, "DI_DEVICE_INSTALLED", `di_tracker_devices:${deviceId}`, "Info",
    { deviceId, vehicleId, vehicleRegistration }).catch(console.error);
  if (device.custodian_technician_id) {
    await triggerReorderCheck(device.custodian_technician_id);
  }
  return ok(res, { deviceId, status: "Installed" }, "Device marked as installed");
});

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /stats — Inventory overview stats
router.get("/stats", requireAuth, requireRole([...CLERK_ROLES, "Technical", "InstallOffice"]), async (req: AuthRequest, res) => {
  const row = await pgGet(
    `SELECT
       count(*)                                                          AS total,
       count(*) FILTER (WHERE inventory_status = 'InInventory')         AS in_inventory,
       count(*) FILTER (WHERE inventory_status = 'IssuedToTechnician')  AS issued_pending_ack,
       count(*) FILTER (WHERE inventory_status = 'InCustody')           AS in_custody,
       count(*) FILTER (WHERE inventory_status = 'AssignedToJob')       AS assigned_to_job,
       count(*) FILTER (WHERE inventory_status = 'Installed')           AS installed,
       count(*) FILTER (WHERE inventory_status = 'Returned')            AS returned,
       count(*) FILTER (WHERE inventory_status = 'Faulty')              AS faulty
     FROM di_tracker_devices WHERE deleted_at IS NULL`,
    []
  );
  const pendingTransfers = await pgGet(
    `SELECT count(*) AS n FROM di_device_transfers WHERE status = 'Pending'`, []
  );
  return ok(res, {
    total: Number(row.total || 0),
    inInventory: Number(row.in_inventory || 0),
    issuedPendingAck: Number(row.issued_pending_ack || 0),
    inCustody: Number(row.in_custody || 0),
    assignedToJob: Number(row.assigned_to_job || 0),
    installed: Number(row.installed || 0),
    returned: Number(row.returned || 0),
    faulty: Number(row.faulty || 0),
    pendingTransfers: Number(pendingTransfers?.n || 0),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEFECTIVE DEVICE REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /defect-reports — Technician reports a defective device
router.post("/defect-reports", requireAuth, requireRole([...TECH_ROLES, ...CLERK_ROLES]), async (req: AuthRequest, res) => {
  const { deviceId, description, photoData } = req.body;
  if (!deviceId?.trim()) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "deviceId is required");
  }
  if (!description?.trim()) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "description is required");
  }

  // Validate device exists in inv_items (the inventory system used by custody module)
  const device = await pgGet(
    `SELECT i.*, p.device_model, p.product_name
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     WHERE i.id = ? AND i.deleted_at IS NULL`,
    [deviceId]
  );
  if (!device) {
    return errorResponse(res, 404, "NOT_FOUND", "Device not found");
  }

  // Technicians can only report devices in their custody.
  // issued_to_id may be the user's users.id, hr_employee_id, or roster id — resolve all.
  if ([...TECH_ROLES].includes(req.user!.role as any)) {
    const myIdRows = await pgAll(
      `SELECT r.id AS roster_id, r.hr_employee_id
       FROM technical_team_roster r
       WHERE r.user_account_id = ?
          OR (r.user_account_id IS NULL AND r.email IN (
               SELECT u.email FROM users u WHERE u.id = ?
             ))`,
      [req.user!.id, req.user!.id]
    ).catch(() => [] as any[]);
    const validIds = new Set<string>([req.user!.id]);
    if ((req.user as any).hrEmployeeId) validIds.add((req.user as any).hrEmployeeId);
    for (const r of myIdRows as any[]) {
      if (r.roster_id)     validIds.add(r.roster_id);
      if (r.hr_employee_id) validIds.add(r.hr_employee_id);
    }
    if (!device.issued_to_id || !validIds.has(device.issued_to_id)) {
      return errorResponse(res, 403, "FORBIDDEN", "You can only report devices in your custody");
    }
  }

  const now = new Date().toISOString();
  const reportId = uuidv4();

  await pgRun(
    `INSERT INTO di_defect_reports
       (id, device_id, device_serial, reported_by_user_id, reported_by_email,
        description, photo_data, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Reported', ?, ?)`,
    [reportId, device.id, device.serial_number, req.user!.id, req.user!.email,
     description.trim(), photoData || null, now, now]
  );

  // Update device status to Defective in inv_items
  await pgRun(
    `UPDATE inv_items SET status = 'Defective', updated_at = ? WHERE id = ?`,
    [now, device.id]
  );

  auditLog(req, "DI_DEFECT_REPORTED", `di_defect_reports:${reportId}`, "Warning",
    { deviceSerial: device.serial_number, description }).catch(console.error);

  // Bell notification to InventoryManager + Admin
  const notifBody = `${req.user!.email} has reported device ${device.serial_number} as defective. Description: ${description.slice(0, 100)}${description.length > 100 ? "…" : ""}`;
  for (const role of ["InventoryManager", "Admin"] as const) {
    createNotification({
      targetRole: role,
      type: "warning",
      title: `Defective Device Reported — ${device.serial_number}`,
      body: notifBody,
      link: "/inventory-warranty.html",
    }).catch(console.error);
  }

  // Email notification to all InventoryManager users
  if (isGraphConfigured()) {
    const managers = await pgAll(
      `SELECT email FROM users WHERE role = 'InventoryManager' AND status = 'Active'`, []
    );
    for (const mgr of managers) {
      if (!mgr.email) continue;
      const htmlBody = `
        <p>Hello,</p>
        <p>A device has been reported as defective on the Finemark portal.</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Device Serial</td><td>${device.serial_number}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Model</td><td>${device.device_model || "—"}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Reported By</td><td>${req.user!.email}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Description</td><td>${description}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Reported At</td><td>${now}</td></tr>
        </table>
        <p>Please log in to the portal to review this report and initiate an internal test.</p>
        ${process.env.DEV_NOTIFY_EMAIL ? `<p style="color:orange;font-style:italic">[DEV MODE — original recipient: ${mgr.email}]</p>` : ""}
      `;
      sendEmailViaGraph({
        fromMailbox: MAILBOXES.notification,
        to: notifyEmail(mgr.email),
        subject: `[Finemark] Defective Device Reported — ${device.serial_number}`,
        htmlBody,
      }).catch(e => console.error("[defect-report] email:", e));
    }
  }

  return created(res, { reportId, deviceSerial: device.serial_number }, "Defective device report submitted");
});

// GET /defect-reports — List all defect reports (Clerks/Managers)
router.get("/defect-reports", requireAuth, requireRole([...CLERK_ROLES, ...TECH_ROLES]), async (req: AuthRequest, res) => {
  const { status } = req.query as Record<string, string>;
  const conditions: string[] = [];
  const params: any[] = [];

  // Technicians see only their own reports
  if ([...TECH_ROLES].includes(req.user!.role as any)) {
    conditions.push("r.reported_by_user_id = ?");
    params.push(req.user!.id);
  }
  if (status) {
    conditions.push("r.status = ?");
    params.push(status);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const rows = await pgAll(
    `SELECT r.*,
            u.email AS reporter_email,
            t.email AS tester_email,
            t.name AS tester_name
     FROM di_defect_reports r
     LEFT JOIN users u ON u.id = r.reported_by_user_id
     LEFT JOIN users t ON t.id = r.tested_by_user_id
     ${where}
     ORDER BY r.created_at DESC LIMIT 200`,
    params
  );

  const mapped = rows.map((r: any) => ({
    id: r.id,
    deviceId: r.device_id,
    deviceSerial: r.device_serial,
    reportedByUserId: r.reported_by_user_id,
    reportedByEmail: r.reporter_email || r.reported_by_email,
    description: r.description,
    hasPhoto: !!r.photo_data,
    status: r.status,
    testOutcome: r.test_outcome || null,
    testNotes: r.test_notes || null,
    testedByEmail: r.tester_email || null,
    testedAt: r.tested_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return ok(res, mapped);
});

// GET /defect-reports/:id — Get single defect report
router.get("/defect-reports/:id", requireAuth, requireRole([...CLERK_ROLES, ...TECH_ROLES]), async (req: AuthRequest, res) => {
  const r = await pgGet(
    `SELECT r.*, u.email AS reporter_email, t.email AS tester_email
     FROM di_defect_reports r
     LEFT JOIN users u ON u.id = r.reported_by_user_id
     LEFT JOIN users t ON t.id = r.tested_by_user_id
     WHERE r.id = ?`,
    [req.params.id]
  );
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Report not found");

  // Technicians see only their own
  if ([...TECH_ROLES].includes(req.user!.role as any) && r.reported_by_user_id !== req.user!.id) {
    return errorResponse(res, 403, "FORBIDDEN", "Access denied");
  }

  return ok(res, {
    id: r.id,
    deviceId: r.device_id,
    deviceSerial: r.device_serial,
    reportedByUserId: r.reported_by_user_id,
    reportedByEmail: r.reporter_email || r.reported_by_email,
    description: r.description,
    photoData: r.photo_data || null,
    status: r.status,
    testOutcome: r.test_outcome || null,
    testNotes: r.test_notes || null,
    testedByEmail: r.tester_email || null,
    testedAt: r.tested_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
});

// POST /defect-reports/:id/test — Inventory manager records internal test outcome
router.post("/defect-reports/:id/test", requireAuth, requireRole([...CLERK_ROLES]), async (req: AuthRequest, res) => {
  const { outcome, testNotes } = req.body;
  if (!["Cleared", "Confirmed"].includes(outcome)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "outcome must be Cleared or Confirmed");
  }

  const report = await pgGet(
    `SELECT * FROM di_defect_reports WHERE id = ?`, [req.params.id]
  );
  if (!report) return errorResponse(res, 404, "NOT_FOUND", "Report not found");
  if (report.status === "Cleared" || report.status === "Confirmed") {
    return errorResponse(res, 409, "CONFLICT", "Report has already been tested");
  }

  const now = new Date().toISOString();

  await pgRun(
    `UPDATE di_defect_reports
     SET status = ?, test_outcome = ?, test_notes = ?, tested_by_user_id = ?, tested_at = ?, updated_at = ?
     WHERE id = ?`,
    [outcome, outcome, testNotes || null, req.user!.id, now, now, report.id]
  );

  // Update device status based on outcome. di_defect_reports.device_id is an
  // inv_items.id (defect reports are created against inv_items, the primary
  // device store) — this used to write to di_tracker_devices instead, a
  // silent no-op that left the device stuck on Defective even after a
  // passing test.
  const newDeviceStatus = outcome === "Cleared" ? "In Stock" : "Defective";
  await pgRun(
    `UPDATE inv_items SET status = ?, updated_at = ? WHERE id = ?`,
    [newDeviceStatus, now, report.device_id]
  );

  auditLog(req, "DI_DEFECT_TEST_RECORDED", `di_defect_reports:${report.id}`, "Info",
    { deviceSerial: report.device_serial, outcome, testNotes }).catch(console.error);

  // Notify the technician who reported it
  const reporter = await pgGet(`SELECT email FROM users WHERE id = ?`, [report.reported_by_user_id]);
  if (reporter?.email) {
    createNotification({
      targetUserId: report.reported_by_user_id,
      type: outcome === "Cleared" ? "success" : "warning",
      title: `Defect Test Result — ${report.device_serial}`,
      body: outcome === "Cleared"
        ? `Device ${report.device_serial} has passed the internal test and been cleared for reissue.`
        : `Device ${report.device_serial} has been confirmed defective. A supplier return process will be initiated.`,
      link: "/technician-custody.html",
    }).catch(console.error);
  }

  if (outcome === "Confirmed") {
    // Notify managers that a supplier return ticket is now needed
    for (const role of ["InventoryManager", "Admin"] as const) {
      createNotification({
        targetRole: role,
        type: "error",
        title: `Defective Confirmed — Supplier Return Required: ${report.device_serial}`,
        body: `Device ${report.device_serial} has been confirmed defective after internal test. Open a supplier return ticket.`,
        link: "/inventory-warranty.html",
      }).catch(console.error);
    }
  }

  const msg = outcome === "Cleared"
    ? `Device ${report.device_serial} cleared — returned to inventory`
    : `Device ${report.device_serial} confirmed defective — please open a supplier return ticket`;

  return ok(res, { reportId: report.id, outcome, newDeviceStatus }, msg);
});

// POST /defect-reports/:id/supplier-return — Open supplier return ticket
router.post("/defect-reports/:id/supplier-return", requireAuth, requireRole([...CLERK_ROLES]), async (req: AuthRequest, res) => {
  const { supplierName, notes } = req.body;

  const report = await pgGet(
    `SELECT * FROM di_defect_reports WHERE id = ?`, [req.params.id]
  );
  if (!report) return errorResponse(res, 404, "NOT_FOUND", "Report not found");
  if (report.test_outcome !== "Confirmed") {
    return errorResponse(res, 409, "CONFLICT", "Supplier return requires a Confirmed defect outcome first");
  }

  // Check not already opened
  const existing = await pgGet(
    `SELECT id FROM di_supplier_return_tickets WHERE defect_report_id = ?`, [report.id]
  );
  if (existing) {
    return errorResponse(res, 409, "CONFLICT", "A supplier return ticket already exists for this report");
  }

  const now = new Date().toISOString();
  const ticketId = uuidv4();
  const ticketRef = nextSupplierReturnTicketRef();

  // Get supplier from device's receive batch if not provided
  let resolvedSupplier = supplierName?.trim() || null;
  if (!resolvedSupplier) {
    const dev = await pgGet(
      `SELECT rb.supplier_name FROM di_tracker_devices d
       LEFT JOIN di_receive_batches rb ON rb.id = d.receive_batch_id
       WHERE d.id = ?`, [report.device_id]
    );
    resolvedSupplier = dev?.supplier_name || null;
  }

  await pgRun(
    `INSERT INTO di_supplier_return_tickets
       (id, defect_report_id, device_id, device_serial, ticket_ref,
        supplier_name, status, notes, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?)`,
    [ticketId, report.id, report.device_id, report.device_serial, ticketRef,
     resolvedSupplier, notes || null, req.user!.id, now, now]
  );

  // Update device status to Sent to Supplier (di_defect_reports.device_id is
  // an inv_items.id — see the same fix in POST /defect-reports/:id/test)
  await pgRun(
    `UPDATE inv_items SET status = 'Sent to Supplier', updated_at = ? WHERE id = ?`,
    [now, report.device_id]
  );

  // Update defect report
  await pgRun(
    `UPDATE di_defect_reports SET status = 'SupplierReturn', updated_at = ? WHERE id = ?`,
    [now, report.id]
  );

  auditLog(req, "DI_SUPPLIER_RETURN_OPENED", `di_supplier_return_tickets:${ticketId}`, "Info",
    { ticketRef, deviceSerial: report.device_serial, supplierName: resolvedSupplier }).catch(console.error);

  // Bell notifications
  for (const role of ["InventoryManager", "Admin"] as const) {
    createNotification({
      targetRole: role,
      type: "info",
      title: `Supplier Return Ticket Opened — ${ticketRef}`,
      body: `Return ticket ${ticketRef} opened for defective device ${report.device_serial}${resolvedSupplier ? " (supplier: " + resolvedSupplier + ")" : ""}.`,
      link: "/inventory-warranty.html",
    }).catch(console.error);
  }

  // Email notification
  if (isGraphConfigured()) {
    const managers = await pgAll(
      `SELECT email FROM users WHERE role IN ('InventoryManager', 'Admin') AND status != 'Disabled'`, []
    );
    for (const mgr of managers) {
      if (!mgr.email) continue;
      const htmlBody = `
        <p>Hello,</p>
        <p>A supplier return ticket has been opened for a confirmed defective device.</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Ticket Ref</td><td>${ticketRef}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Device Serial</td><td>${report.device_serial}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Supplier</td><td>${resolvedSupplier || "Not specified"}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Opened By</td><td>${req.user!.email}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Notes</td><td>${notes || "—"}</td></tr>
        </table>
        <p>Log in to the portal to track this return ticket under Warranty &amp; Defects.</p>
        ${process.env.DEV_NOTIFY_EMAIL ? `<p style="color:orange;font-style:italic">[DEV MODE — original recipient: ${mgr.email}]</p>` : ""}
      `;
      sendEmailViaGraph({
        fromMailbox: MAILBOXES.notification,
        to: notifyEmail(mgr.email),
        subject: `[Finemark] Supplier Return Ticket Opened — ${ticketRef}`,
        htmlBody,
      }).catch(e => console.error("[supplier-return] email:", e));
    }
  }

  return created(res, { ticketId, ticketRef, deviceSerial: report.device_serial }, `Supplier return ticket ${ticketRef} opened`);
});

// GET /defect-reports/supplier-returns — List all supplier return tickets
router.get("/supplier-returns", requireAuth, requireRole([...CLERK_ROLES]), async (req: AuthRequest, res) => {
  const { status } = req.query as Record<string, string>;
  const conditions: string[] = [];
  const params: any[] = [];

  if (status) { conditions.push("t.status = ?"); params.push(status); }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const rows = await pgAll(
    `SELECT t.*, u.email AS created_by_email
     FROM di_supplier_return_tickets t
     LEFT JOIN users u ON u.id = t.created_by_user_id
     ${where}
     ORDER BY t.created_at DESC LIMIT 200`,
    params
  );

  return ok(res, rows.map((t: any) => ({
    id: t.id,
    defectReportId: t.defect_report_id,
    deviceId: t.device_id,
    deviceSerial: t.device_serial,
    ticketRef: t.ticket_ref,
    supplierName: t.supplier_name || null,
    status: t.status,
    notes: t.notes || null,
    createdByEmail: t.created_by_email || null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  })));
});

// PATCH /supplier-returns/:id/status — Update supplier return ticket status
router.patch("/supplier-returns/:id/status", requireAuth, requireRole([...CLERK_ROLES]), async (req: AuthRequest, res) => {
  const { status, notes } = req.body;
  const allowed = ["Open", "Sent", "Acknowledged", "Closed"];
  if (!allowed.includes(status)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", `status must be one of: ${allowed.join(", ")}`);
  }

  const ticket = await pgGet(`SELECT * FROM di_supplier_return_tickets WHERE id = ?`, [req.params.id]);
  if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Supplier return ticket not found");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE di_supplier_return_tickets SET status = ?, notes = ?, updated_at = ? WHERE id = ?`,
    [status, notes || ticket.notes, now, ticket.id]
  );

  auditLog(req, "DI_SUPPLIER_RETURN_STATUS", `di_supplier_return_tickets:${ticket.id}`, "Info",
    { ticketRef: ticket.ticket_ref, previousStatus: ticket.status, newStatus: status }).catch(console.error);

  return ok(res, { id: ticket.id, ticketRef: ticket.ticket_ref, status }, "Ticket status updated");
});

export default router;
