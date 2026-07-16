import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun, pgExec } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

const router = Router();

// Owns the gps_uninstall_queue domain table — a standalone operational queue
// (not a ticket-action artifact like credit_notes/di_reinstallations): rows
// are created by the daily loan-term-end scan (jobs/gpsUninstallScanCron.ts)
// or by Finance/Admin's manual "mark loan settled early" flag below, and are
// only later — optionally — linked to a crm_tickets row once staff raise an
// Uninstallation ticket from here. crm-tickets.ts's POST /:id/complete-
// uninstallation writes the terminal Completed transition directly into this
// table, mirroring how it already writes into credit_notes/di_reinstallations
// owned by other files.
pgExec(`
  CREATE TABLE IF NOT EXISTS gps_uninstall_queue (
    id                    TEXT PRIMARY KEY,
    vehicle_id            TEXT NOT NULL,
    vehicle_registration  TEXT,
    customer_id           TEXT,
    customer_name         TEXT,
    partner_id            TEXT,
    trigger_type          TEXT NOT NULL,
    eligible_date         TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'Scheduled',
    reason                TEXT,
    flagged_by_user_id    TEXT,
    flagged_by_email      TEXT,
    linked_ticket_id      TEXT,
    linked_ticket_no      TEXT,
    completed_at          TEXT,
    cancelled_at          TEXT,
    cancelled_reason      TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  )
`).catch(e => console.error("[gps_uninstall_queue] init:", e));

pgExec(`CREATE INDEX IF NOT EXISTS idx_guq_vehicle       ON gps_uninstall_queue(vehicle_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_guq_customer      ON gps_uninstall_queue(customer_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_guq_status        ON gps_uninstall_queue(status)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_guq_linked_ticket ON gps_uninstall_queue(linked_ticket_id)`).catch(() => {});

// A vehicle may only have ONE active (Scheduled/TicketRaised) queue row at a
// time — a partial unique index (not a plain UNIQUE(vehicle_id)) so a
// vehicle can cycle through the queue again after a prior entry reaches
// Completed/Cancelled (e.g. re-financed, later re-settled).
pgExec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_guq_vehicle_active ON gps_uninstall_queue(vehicle_id) WHERE status IN ('Scheduled','TicketRaised')`).catch(() => {});

const QUEUE_VIEW_ROLES = Array.from(new Set([...ROLE_GROUPS.TEAM_TECHNICAL, ...ROLE_GROUPS.TEAM_FINANCE]));

function mapRow(r: any) {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    vehicleRegistration: r.vehicle_registration,
    customerId: r.customer_id,
    customerName: r.customer_name,
    partnerId: r.partner_id,
    triggerType: r.trigger_type,
    eligibleDate: r.eligible_date,
    status: r.status,
    reason: r.reason,
    flaggedByUserId: r.flagged_by_user_id,
    flaggedByEmail: r.flagged_by_email,
    linkedTicketId: r.linked_ticket_id,
    linkedTicketNo: r.linked_ticket_no,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    cancelledReason: r.cancelled_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── List ─────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(QUEUE_VIEW_ROLES), async (req: AuthRequest, res) => {
  const { status, triggerType, search, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (pageNum - 1) * sizeNum;

  const filters: string[] = [];
  const params: any[] = [];
  if (status) { filters.push("status = ?"); params.push(status); }
  if (triggerType) { filters.push("trigger_type = ?"); params.push(triggerType); }
  if (search) {
    filters.push("(vehicle_registration ILIKE ? OR customer_name ILIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const rows = await pgAll(
    `SELECT * FROM gps_uninstall_queue ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) AS total FROM gps_uninstall_queue ${where}`, params);

  return ok(res, { data: rows.map(mapRow), meta: { total: Number(totalRow?.total ?? 0) } });
});

// ── Stats ────────────────────────────────────────────────────────────────────
router.get("/stats/summary", requireAuth, requireRole(QUEUE_VIEW_ROLES), async (_req, res) => {
  const row = await pgGet(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'Scheduled')    AS scheduled,
       COUNT(*) FILTER (WHERE status = 'TicketRaised')  AS ticket_raised,
       COUNT(*) FILTER (WHERE status = 'Completed')     AS completed,
       COUNT(*) FILTER (WHERE status = 'Cancelled')     AS cancelled
     FROM gps_uninstall_queue`,
    []
  );
  return ok(res, {
    scheduled: Number(row?.scheduled ?? 0),
    ticketRaised: Number(row?.ticket_raised ?? 0),
    completed: Number(row?.completed ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
  });
});

// ── Per-vehicle / per-customer history ──────────────────────────────────────
router.get("/vehicle/:vehicleId", requireAuth, requireRole(QUEUE_VIEW_ROLES), async (req: AuthRequest, res) => {
  const rows = await pgAll(`SELECT * FROM gps_uninstall_queue WHERE vehicle_id = ? ORDER BY created_at DESC`, [req.params.vehicleId]);
  return ok(res, { data: rows.map(mapRow) });
});

router.get("/customer/:customerId", requireAuth, requireRole(QUEUE_VIEW_ROLES), async (req: AuthRequest, res) => {
  const rows = await pgAll(`SELECT * FROM gps_uninstall_queue WHERE customer_id = ? ORDER BY created_at DESC`, [req.params.customerId]);
  return ok(res, { data: rows.map(mapRow) });
});

// ── Mark loan settled early — Finance/Admin manually flags a vehicle ───────
router.post(
  "/mark-settled-early",
  requireAuth,
  requireRole(ROLE_GROUPS.TEAM_FINANCE),
  async (req: AuthRequest, res) => {
    const { vehicleId, settlementDate, reason } = req.body || {};
    if (!vehicleId) return errorResponse(res, 400, "VALIDATION_ERROR", "vehicleId is required.");
    if (!reason?.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "reason is required.");

    const vehicle = await pgGet(
      `SELECT v.id, v.registration, v.customer_id, v.partner_id,
              COALESCE(ind.full_name, corp.company_name) AS customer_name
       FROM crm_customer_vehicles v
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = v.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = v.customer_id
       WHERE v.id = ? AND v.deleted_at IS NULL`,
      [vehicleId]
    );
    if (!vehicle) return errorResponse(res, 404, "NOT_FOUND", "Vehicle not found.");

    const existingActive = await pgGet(
      `SELECT id, status FROM gps_uninstall_queue WHERE vehicle_id = ? AND status IN ('Scheduled','TicketRaised')`,
      [vehicleId]
    );
    if (existingActive) {
      return errorResponse(res, 409, "ALREADY_QUEUED", `This vehicle is already in the GPS uninstallation queue (status: ${existingActive.status}).`);
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    const eligibleDate = (settlementDate && /^\d{4}-\d{2}-\d{2}$/.test(settlementDate)) ? settlementDate : now.slice(0, 10);

    await pgRun(
      `INSERT INTO gps_uninstall_queue
         (id, vehicle_id, vehicle_registration, customer_id, customer_name, partner_id,
          trigger_type, eligible_date, status, reason, flagged_by_user_id, flagged_by_email,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'EarlyRepayment', ?, 'Scheduled', ?, ?, ?, ?, ?)`,
      [id, vehicle.id, vehicle.registration, vehicle.customer_id, vehicle.customer_name, vehicle.partner_id,
       eligibleDate, reason.trim(), req.user!.id, req.user!.email, now, now]
    );

    auditLog(req, "GPS_UNINSTALL_QUEUE_EARLY_REPAYMENT_FLAGGED", `gps_uninstall_queue:${id}`, "Info", {
      vehicleId: vehicle.id, registration: vehicle.registration, eligibleDate,
    }).catch(console.error);

    const row = await pgGet(`SELECT * FROM gps_uninstall_queue WHERE id = ?`, [id]);
    return created(res, mapRow(row!), "Vehicle queued for GPS uninstallation.");
  }
);

// ── Link a raised ticket back to its queue entry ────────────────────────────
router.patch(
  "/:id/link-ticket",
  requireAuth,
  requireRole(QUEUE_VIEW_ROLES),
  async (req: AuthRequest, res) => {
    const { ticketId } = req.body || {};
    if (!ticketId) return errorResponse(res, 400, "VALIDATION_ERROR", "ticketId is required.");

    const queueRow = await pgGet(`SELECT * FROM gps_uninstall_queue WHERE id = ?`, [req.params.id]);
    if (!queueRow) return errorResponse(res, 404, "NOT_FOUND", "Queue entry not found.");
    if (queueRow.status !== "Scheduled") {
      return errorResponse(res, 409, "CONFLICT", `Queue entry is not raisable from its current status (${queueRow.status}).`);
    }

    const ticket = await pgGet(`SELECT id, ticket_no, category, vehicle_id FROM crm_tickets WHERE id = ?`, [ticketId]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found.");
    if (ticket.category !== "Uninstallation") {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Linked ticket must be of category 'Uninstallation'.");
    }
    if (ticket.vehicle_id !== queueRow.vehicle_id) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "The ticket's vehicle does not match this queue entry's vehicle.");
    }

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE gps_uninstall_queue SET status = 'TicketRaised', linked_ticket_id = ?, linked_ticket_no = ?, updated_at = ? WHERE id = ?`,
      [ticket.id, ticket.ticket_no, now, req.params.id]
    );

    auditLog(req, "GPS_UNINSTALL_QUEUE_TICKET_RAISED", `gps_uninstall_queue:${req.params.id}`, "Info", { ticketId: ticket.id, ticketNo: ticket.ticket_no }).catch(console.error);
    const row = await pgGet(`SELECT * FROM gps_uninstall_queue WHERE id = ?`, [req.params.id]);
    return ok(res, { data: mapRow(row!) }, "Queue entry linked to ticket.");
  }
);

// ── Cancel — safety valve for a wrongly-queued vehicle ──────────────────────
router.post(
  "/:id/cancel",
  requireAuth,
  requireRole(QUEUE_VIEW_ROLES),
  async (req: AuthRequest, res) => {
    const { reason } = req.body || {};
    if (!reason?.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "reason is required.");

    const queueRow = await pgGet(`SELECT * FROM gps_uninstall_queue WHERE id = ?`, [req.params.id]);
    if (!queueRow) return errorResponse(res, 404, "NOT_FOUND", "Queue entry not found.");
    if (queueRow.status !== "Scheduled") {
      return errorResponse(res, 409, "CONFLICT", `Only a Scheduled entry can be cancelled (current: ${queueRow.status}).`);
    }

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE gps_uninstall_queue SET status = 'Cancelled', cancelled_at = ?, cancelled_reason = ?, updated_at = ? WHERE id = ?`,
      [now, reason.trim(), now, req.params.id]
    );

    auditLog(req, "GPS_UNINSTALL_QUEUE_CANCELLED", `gps_uninstall_queue:${req.params.id}`, "Info", { reason: reason.trim() }).catch(console.error);
    const row = await pgGet(`SELECT * FROM gps_uninstall_queue WHERE id = ?`, [req.params.id]);
    return ok(res, { data: mapRow(row!) }, "Queue entry cancelled.");
  }
);

export default router;
