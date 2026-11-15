import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { nextDatedBatchNumber } from "../utils/batchNumber.js";
import { closeOpenCheckouts } from "./inventory-items.js";
import { recordRetrieval } from "./device-retrievals.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();

// ── Role groups ──────────────────────────────────────────────────────────────
// Phase 1 left "Technical" hardcoded alongside Support/Operations/Finance/Sales
// across most routes, but ROLE_GROUPS.TEAM_TECHNICAL (the group that actually
// resolves to the "Technical" team via callerTeam() below) also includes
// Technician and InstallOffice — neither of which were ever in these arrays,
// so a field technician could be routed a Technical ticket but not view or
// act on it. Consolidated here (per route family, since Sales/Finance
// inclusion legitimately differs by action) so the gap can't reopen silently.
// The technical-office manager (`technical_manager`) is intentionally granted
// ticket access here — raise, view, and act on Technical-team tickets — WITHOUT
// being added to ROLE_GROUPS.TEAM_TECHNICAL. That group gates the whole
// technical pipeline (installation tickets, job cards, device custody, …); the
// request was only for ticket access, so it's scoped to the ticket role sets
// plus callerTeam() below (which maps it to the Technical team).
const TICKET_MANAGER = "technical_manager";
// Non-team roles that may raise & track tickets but only ever see the ones they
// opened (they aren't part of any resolving team, so there's no team inbox to
// scope them to). BDMCorporate raises support cases for its corporate customers
// and tracks them to resolution — same treatment as Sales.
const TICKET_SELF_SCOPE_ROLES = ["Sales", "BDMCorporate"];
const TICKET_VIEW_ROLES = Array.from(new Set(["Admin", "Support", "Operations", "Finance", TICKET_MANAGER, ...TICKET_SELF_SCOPE_ROLES, ...ROLE_GROUPS.TEAM_TECHNICAL]));
const TICKET_TEAM_ROLES = Array.from(new Set(["Admin", "Support", "Operations", "Finance", TICKET_MANAGER, ...ROLE_GROUPS.TEAM_TECHNICAL]));
const TICKET_CONSULT_ROLES = Array.from(new Set(["Admin", "Support", "Operations", TICKET_MANAGER, ...ROLE_GROUPS.TEAM_TECHNICAL]));

// SLA hours by priority
const SLA_MAP: Record<string, number> = {
  Critical: 4,
  High: 8,
  Normal: 24,
  Low: 72,
};

// ── Phase 1 revamp: schema migrations ───────────────────────────────────────
// customer_id is now nullable — Internal Ticket / Internal Billing categories
// (ticket_categories.requires_customer = false) never have a customer at all.
pgRun(`ALTER TABLE crm_tickets ALTER COLUMN customer_id DROP NOT NULL`, []).catch(() => {});
for (const col of [
  "team TEXT",
  "vehicle_id TEXT",
  "linked_installation_id TEXT",
  "linked_device_item_ids TEXT NOT NULL DEFAULT '[]'",
  "linked_sim_ids TEXT NOT NULL DEFAULT '[]'",
  "linked_invoice_id TEXT",
  "parent_ticket_id TEXT",
  "consulted_user_id TEXT",
]) {
  pgRun(`ALTER TABLE crm_tickets ADD COLUMN IF NOT EXISTS ${col}`, []).catch(() => {});
}
pgRun(`ALTER TABLE crm_ticket_actions ADD COLUMN IF NOT EXISTS to_team TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE crm_ticket_actions ADD COLUMN IF NOT EXISTS linked_ticket_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE crm_ticket_actions ADD COLUMN IF NOT EXISTS linked_reinstallation_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE crm_ticket_actions ADD COLUMN IF NOT EXISTS linked_credit_note_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE crm_ticket_actions ADD COLUMN IF NOT EXISTS linked_uninstall_queue_id TEXT`, []).catch(() => {});

// Ticket-numbering race fix: nextTicketNo() previously read MAX(ticket_no)
// then incremented in application code — two concurrent creates could read
// the same max and collide. A sequence is lock-free and atomic.
pgRun(`CREATE SEQUENCE IF NOT EXISTS crm_tickets_ticket_no_seq`, []).catch(() => {});
setTimeout(async () => {
  try {
    const row = await pgGet<{ max_no: string }>(
      `SELECT MAX(CAST(SUBSTRING(ticket_no FROM '\\d+$') AS INT)) AS max_no FROM crm_tickets`, []
    );
    const maxNo = Number(row?.max_no || 0);
    if (maxNo > 0) await pgRun(`SELECT setval('crm_tickets_ticket_no_seq', ?)`, [maxNo]);
  } catch (e) { console.error("[crm_tickets_ticket_no_seq] seed:", e); }
}, 1500);

// One-time backfill so pre-revamp tickets show up correctly in the new
// team-inbox filters immediately (category existed before team did).
setTimeout(async () => {
  await pgRun(
    `UPDATE crm_tickets SET team = (SELECT team FROM ticket_categories WHERE name = crm_tickets.category)
     WHERE team IS NULL AND EXISTS (SELECT 1 FROM ticket_categories WHERE name = crm_tickets.category)`,
    []
  ).catch((e) => console.error("[crm_tickets] team backfill:", e));
}, 2000);

pgRun(`
  CREATE TABLE IF NOT EXISTS crm_ticket_attachments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    url TEXT NOT NULL,
    mimetype TEXT,
    size_bytes INTEGER,
    uploaded_by_user_id TEXT,
    uploaded_by_email TEXT,
    created_at TEXT NOT NULL
  )
`, []).catch((e) => console.error("[crm_ticket_attachments] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_ticket_attachments_ticket ON crm_ticket_attachments(ticket_id)`, []).catch(() => {});

// ── Ticket number generator (sequence-based, race-safe) ──────────────────────
async function nextTicketNo(): Promise<string> {
  const row = await pgGet<{ n: string }>(`SELECT nextval('crm_tickets_ticket_no_seq') AS n`, []);
  return `TKT-${String(row!.n).padStart(5, "0")}`;
}

function safeJsonArray(v: any): string[] {
  try { const parsed = JSON.parse(v || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function mapTicket(row: any) {
  return {
    id: row.id,
    ticketNo: row.ticket_no,
    customerId: row.customer_id,
    customerName: row.customer_name || null,
    subject: row.subject,
    description: row.description,
    category: row.category,
    team: row.team || null,
    priority: row.priority,
    status: row.status,
    assignedToUserId: row.assigned_to_user_id,
    assigneeEmail: row.assignee_email || null,
    consultedUserId: row.consulted_user_id || null,
    consultedEmail: row.consulted_email || null,
    slaHours: row.sla_hours,
    slaBreachAt: row.sla_breach_at,
    openedAt:   row.opened_at,
    assignedAt: row.assigned_at || null,
    resolvedAt: row.resolved_at,
    closedAt:   row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedItId:     row.linked_it_id     || null,
    linkedItNo:     row.linked_it_no     || null,
    linkedItStatus: row.linked_it_status || null,
    vehicleId: row.vehicle_id || null,
    vehicleRegistration: row.vehicle_registration || null,
    linkedInstallationId: row.linked_installation_id || null,
    linkedDeviceItemIds: safeJsonArray(row.linked_device_item_ids),
    linkedSimIds: safeJsonArray(row.linked_sim_ids),
    linkedInvoiceId: row.linked_invoice_id || null,
    linkedInvoice: row.linked_invoice_id ? {
      id: row.linked_invoice_id,
      invoiceNumber: row.li_invoice_number ?? null,
      total: row.li_total != null ? Number(row.li_total) : (row.li_amount != null ? Number(row.li_amount) : null),
      vatTotal: row.li_vat_total != null ? Number(row.li_vat_total) : null,
      status: row.li_status ?? null,
      currency: row.li_currency || "KES",
    } : null,
    parentTicketId: row.parent_ticket_id || null,
  };
}

// Resolves the caller's team membership from ROLE_GROUPS.TEAM_* — Admin is
// "all teams" (full visibility, matches hasCrmFullVisibility elsewhere).
function callerTeam(role: string): string | null {
  if (role === TICKET_MANAGER) return "Technical"; // technical-office manager: scoped to the Technical team's tickets
  if ((ROLE_GROUPS.TEAM_TECHNICAL as readonly string[]).includes(role) && role !== "Admin") return "Technical";
  if ((ROLE_GROUPS.TEAM_FINANCE as readonly string[]).includes(role) && role !== "Admin") return "Finance";
  if ((ROLE_GROUPS.TEAM_SUPPORT as readonly string[]).includes(role) && role !== "Admin") return "Support";
  return null;
}

// ── List tickets ───────────────────────────────────────────────────────────────
router.get(
  "/",
  requireAuth,
  requireRole(TICKET_VIEW_ROLES),
  async (req: AuthRequest, res) => {
    // myTeam=true is accepted for frontend-compatibility (the "My Team"
    // toggle) but is a no-op: non-Admin team roles are unconditionally
    // scoped to their own team below regardless of the flag, and Admin has
    // no single team for it to resolve to — Admin should use ?team= instead.
    const { search, status, priority, category, customerId, assignedToUserId, team: teamFilter, page = "1", pageSize = "50" } = req.query as any;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
    const offset = (pageNum - 1) * sizeNum;

    const filters: string[] = [];
    const params: any[] = [];

    // ABAC: Admin sees everything. Technical/Finance/Support/Operations are
    // scoped to their team's inbox (not just personally-assigned tickets —
    // that's the actual "team can view tickets raised to them" ask). Sales
    // only sees tickets they personally raised, since Sales isn't part of
    // any resolving team.
    if (req.user!.role !== "Admin") {
      const myTeam = callerTeam(req.user!.role);
      if (myTeam) {
        filters.push("t.team = ?");
        params.push(myTeam);
      } else if (TICKET_SELF_SCOPE_ROLES.includes(req.user!.role)) {
        filters.push("t.created_by_user_id = ?");
        params.push(req.user!.id);
      }
    }
    if (teamFilter) { filters.push("t.team = ?"); params.push(teamFilter); }

    if (search) {
      filters.push("(t.ticket_no ILIKE ? OR t.subject ILIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    // Merged (child) tickets are absorbed into their parent case and shouldn't
    // clutter the main queue — hide them unless someone explicitly asks for
    // status=Merged.
    if (status) { filters.push("t.status = ?"); params.push(status); }
    else { filters.push("t.status != 'Merged'"); }
    if (priority) { filters.push("t.priority = ?"); params.push(priority); }
    if (category) { filters.push("t.category = ?"); params.push(category); }
    if (customerId) { filters.push("t.customer_id = ?"); params.push(customerId); }
    if (assignedToUserId) { filters.push("t.assigned_to_user_id = ?"); params.push(assignedToUserId); }

    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const rows = await pgAll(
      `SELECT t.*, u.email AS assignee_email,
              COALESCE(ind.full_name, corp.company_name) AS customer_name,
              v.registration AS vehicle_registration,
              it.id AS linked_it_id, it.ticket_no AS linked_it_no, it.status AS linked_it_status
       FROM crm_tickets t
       LEFT JOIN users u ON u.id = t.assigned_to_user_id
       LEFT JOIN crm_customers c ON c.id = t.customer_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = t.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = t.customer_id
       LEFT JOIN crm_customer_vehicles v ON v.id = t.vehicle_id
       LEFT JOIN installation_tickets it ON it.crm_ticket_id = t.id AND it.deleted_at IS NULL
       ${where}
       ORDER BY
         CASE t.priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Normal' THEN 3 ELSE 4 END,
         t.opened_at DESC
       LIMIT ? OFFSET ?`,
      [...params, sizeNum, offset]
    );

    const totalRow = await pgGet(
      `SELECT COUNT(*) AS total FROM crm_tickets t ${where}`,
      params
    );

    return ok(res, { data: rows.map(mapTicket), meta: { total: Number(totalRow?.total ?? 0) } });
  }
);

// ── Vehicle lookup — powers ticket-creation auto-population ────────────────
// customer's vehicle -> its most recent completed installation -> the
// device(s)/SIM(s) installed on that job -> that job's assignee as "last
// technician." No direct vehicle->device link table exists; this is the join
// path the whole app already relies on (installation-tickets.ts flips
// inv_items/inv_sims to Installed against this same installation_id on
// ticket completion).
router.get(
  "/lookup/vehicle/:vehicleId",
  requireAuth,
  requireRole(TICKET_VIEW_ROLES),
  async (req: AuthRequest, res) => {
    const vehicle = await pgGet(
      `SELECT * FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL`,
      [req.params.vehicleId]
    );
    if (!vehicle) return errorResponse(res, 404, "NOT_FOUND", "Vehicle not found.");

    const installation = await pgGet(
      `SELECT it.*, u.email AS assigned_to_email_resolved
       FROM installation_tickets it
       LEFT JOIN users u ON u.id = it.assigned_to_user_id
       WHERE it.vehicle_id = ? AND it.status = 'Completed' AND it.deleted_at IS NULL
       ORDER BY it.created_at DESC LIMIT 1`,
      [req.params.vehicleId]
    );

    let devices: any[] = [];
    let sims: any[] = [];
    if (installation) {
      devices = await pgAll(
        `SELECT i.id, i.imei, i.serial_number, i.status, p.product_name, p.device_model
         FROM inv_items i LEFT JOIN inv_product_catalog p ON p.id = i.product_id
         WHERE i.installation_id = ? AND i.deleted_at IS NULL`,
        [installation.id]
      ).catch(() => []);
      const deviceIds = devices.map((d: any) => d.id);
      sims = await pgAll(
        `SELECT id, iccid, msisdn, status FROM inv_sims
         WHERE installation_id = ? OR device_item_id = ANY(?::text[])`,
        [installation.id, deviceIds.length ? deviceIds : [""]]
      ).catch(() => []);
    }

    return ok(res, {
      data: {
        vehicle: {
          id: vehicle.id, registration: vehicle.registration, make: vehicle.make,
          model: vehicle.model, chassisNumber: vehicle.chassis_number,
        },
        installation: installation ? {
          id: installation.id, ticketNo: installation.ticket_no, status: installation.status,
          completedAt: installation.updated_at,
        } : null,
        devices: devices.map((d: any) => ({ id: d.id, imei: d.imei, serialNumber: d.serial_number, status: d.status, productName: d.product_name, deviceModel: d.device_model })),
        sims: sims.map((s: any) => ({ id: s.id, iccid: s.iccid, msisdn: s.msisdn, status: s.status })),
        lastTechnician: installation?.assigned_to_user_id ? {
          userId: installation.assigned_to_user_id,
          email: installation.assigned_to_email || installation.assigned_to_email_resolved || null,
        } : null,
      },
    });
  }
);

// ── Ticket context — full vehicle + job card + installed devices + gadget location
// Powers the Uninstallation / Gadget Issue detail view: everything the technician
// needs to see the physical vehicle, its job card, the devices on it, and where the
// target gadget sits. The ticket's linked_device_item_ids are flagged as targets.
router.get(
  "/:id/context",
  requireAuth,
  requireRole(TICKET_VIEW_ROLES),
  async (req: AuthRequest, res) => {
    const ticket = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found.");

    const targetDeviceIds = safeJsonArray(ticket.linked_device_item_ids);
    const targetSimIds = safeJsonArray(ticket.linked_sim_ids);

    let vehicle: any = null;
    let installation: any = null;
    let devices: any[] = [];
    let sims: any[] = [];

    if (ticket.vehicle_id) {
      vehicle = await pgGet(`SELECT * FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL`, [ticket.vehicle_id]);
      installation = await pgGet(
        `SELECT it.*, u.email AS assigned_to_email_resolved
         FROM installation_tickets it
         LEFT JOIN users u ON u.id = it.assigned_to_user_id
         WHERE it.vehicle_id = ? AND it.status = 'Completed' AND it.deleted_at IS NULL
         ORDER BY it.created_at DESC LIMIT 1`,
        [ticket.vehicle_id]
      );
      if (installation) {
        devices = await pgAll(
          `SELECT i.id, i.imei, i.serial_number, i.status, i.sim_serial, i.sim_phone, p.product_name, p.device_model
           FROM inv_items i LEFT JOIN inv_product_catalog p ON p.id = i.product_id
           WHERE i.installation_id = ? AND i.deleted_at IS NULL`,
          [installation.id]
        ).catch(() => []);
        const deviceIds = devices.map((d: any) => d.id);
        sims = await pgAll(
          `SELECT id, iccid, msisdn, status, device_item_id FROM inv_sims
           WHERE installation_id = ? OR device_item_id = ANY(?::text[])`,
          [installation.id, deviceIds.length ? deviceIds : [""]]
        ).catch(() => []);
      }
    }

    // Per-device mounting position, captured in the job card (Step 4) and stored on
    // the installation ticket as device_install_json keyed by inv_items.id.
    let deviceInstall: Record<string, any> = {};
    try { deviceInstall = installation?.device_install_json ? JSON.parse(installation.device_install_json) : {}; } catch { deviceInstall = {}; }
    const mountOf = (id: string) => {
      const rec = deviceInstall[id];
      if (!rec) return null;
      return [rec.mountLocation, rec.mountDescription].filter(Boolean).join(" · ") || null;
    };

    // The ticket's linked devices, resolved to their current state (may include
    // devices already swapped out / removed — surfaced with their live status).
    const linkedDevices = targetDeviceIds.length
      ? await pgAll(
          `SELECT i.id, i.imei, i.serial_number, i.status, i.issued_to_id, i.issued_to_name, p.product_name, p.device_model
           FROM inv_items i LEFT JOIN inv_product_catalog p ON p.id = i.product_id
           WHERE i.id = ANY(?::text[]) AND i.deleted_at IS NULL`,
          [targetDeviceIds]
        ).catch(() => [])
      : [];

    return ok(res, {
      data: {
        ticket: {
          id: ticket.id, ticketNo: ticket.ticket_no, category: ticket.category,
          vehicleId: ticket.vehicle_id, linkedDeviceItemIds: targetDeviceIds, linkedSimIds: targetSimIds,
        },
        vehicle: vehicle ? {
          id: vehicle.id, registration: vehicle.registration, make: vehicle.make, model: vehicle.model,
          modelNumber: vehicle.model_number, bodyType: vehicle.body_type, color: vehicle.color,
          yearOfManufacture: vehicle.year_of_manufacture, chassisNumber: vehicle.chassis_number,
          engineNumber: vehicle.engine_number, vehicleCategory: vehicle.vehicle_category,
          vin: vehicle.vin, vehicleNo: vehicle.vehicle_no, fleetNumber: vehicle.fleet_number,
        } : null,
        installation: installation ? {
          id: installation.id, jobCardRef: installation.ticket_no, status: installation.status,
          installationLocation: installation.installation_location || null,
          lat: installation.installation_location_lat, lng: installation.installation_location_lng,
          jobCardPhotoUrl: installation.job_card_photo_url || null,
          completedAt: installation.updated_at,
          technicianEmail: installation.assigned_to_email || installation.assigned_to_email_resolved || null,
          technicianUserId: installation.assigned_to_user_id || null,
        } : null,
        devicesOnVehicle: devices.map((d: any) => ({
          id: d.id, imei: d.imei, serialNumber: d.serial_number, status: d.status,
          productName: d.product_name, deviceModel: d.device_model,
          simSerial: d.sim_serial, simPhone: d.sim_phone,
          mountPosition: mountOf(d.id),
          isTarget: targetDeviceIds.includes(d.id),
        })),
        sims: sims.map((s: any) => ({ id: s.id, iccid: s.iccid, msisdn: s.msisdn, status: s.status, deviceItemId: s.device_item_id, isTarget: targetSimIds.includes(s.id) })),
        linkedDevices: linkedDevices.map((d: any) => ({
          id: d.id, imei: d.imei, serialNumber: d.serial_number, status: d.status,
          productName: d.product_name, deviceModel: d.device_model,
          mountPosition: mountOf(d.id),
          issuedToId: d.issued_to_id, issuedToName: d.issued_to_name,
        })),
      },
    });
  }
);

// ── Last invoice lookup — powers ticket-creation auto-population ───────────
router.get(
  "/lookup/customer/:customerId/last-invoice",
  requireAuth,
  requireRole(TICKET_VIEW_ROLES),
  async (req: AuthRequest, res) => {
    const invoice = await pgGet(
      `SELECT id, invoice_number, amount, status, issued_on, due_on FROM invoices WHERE customer_id = ? ORDER BY issued_on DESC LIMIT 1`,
      [req.params.customerId]
    );
    return ok(res, {
      data: invoice ? {
        id: invoice.id, invoiceNumber: invoice.invoice_number, amount: Number(invoice.amount || 0),
        status: invoice.status, issuedOn: invoice.issued_on, dueOn: invoice.due_on,
      } : null,
    });
  }
);

// ── Create ticket ──────────────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireRole(TICKET_VIEW_ROLES),
  async (req: AuthRequest, res) => {
    const {
      customerId, subject, description, categoryId, category: categoryNameRaw, priority, assignedToUserId,
      vehicleIds, linkedInstallationId, linkedDeviceItemIds, linkedSimIds, linkedInvoiceId, team: teamRaw,
    } = req.body;

    if (!subject) return errorResponse(res, 400, "VALIDATION_ERROR", "subject is required");

    // Category drives team + whether a customer is required — resolve by id
    // if given, else fall back to matching the raw name (keeps the API
    // usable from older callers that only ever sent a category string).
    let categoryRow: any = null;
    if (categoryId) categoryRow = await pgGet(`SELECT * FROM ticket_categories WHERE id = ? AND is_active = TRUE`, [categoryId]);
    else if (categoryNameRaw) categoryRow = await pgGet(`SELECT * FROM ticket_categories WHERE name = ? AND is_active = TRUE`, [categoryNameRaw]);
    if (!categoryRow) return errorResponse(res, 400, "VALIDATION_ERROR", "A valid category is required.");

    // Team routing: the category implies a default team, but the requester/admin
    // may explicitly assign a different responsible team on the form. Accept only
    // the known teams (DB CHECK constrains ticket_categories.team to these);
    // anything else falls back to the category's team.
    const ALLOWED_TEAMS = ["Technical", "Finance", "Support"];
    const team = teamRaw && ALLOWED_TEAMS.includes(teamRaw) ? teamRaw : categoryRow.team;

    if (categoryRow.requires_customer && !customerId) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "customerId is required for this category.");
    }
    if (customerId) {
      const customer = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [customerId]);
      if (!customer) return errorResponse(res, 404, "NOT_FOUND", "Customer not found");
    }

    const vehicleIdList: string[] = Array.isArray(vehicleIds) ? vehicleIds.filter(Boolean) : [];
    const primaryVehicleId = vehicleIdList[0] || null;
    const extraVehicleIds = vehicleIdList.slice(1);

    const now = new Date().toISOString();
    const id = uuidv4();
    const ticketNo = await nextTicketNo();
    const slaHours = SLA_MAP[priority] || 24;
    const slaBreachAt = new Date(Date.now() + slaHours * 3600_000).toISOString();

    await pgRun(
      `INSERT INTO crm_tickets
         (id, ticket_no, customer_id, subject, description, category, team, priority, status,
          assigned_to_user_id, sla_hours, sla_breach_at, opened_at, assigned_at, created_by_user_id, created_at, updated_at,
          vehicle_id, linked_installation_id, linked_device_item_ids, linked_sim_ids, linked_invoice_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ticketNo, customerId || null, subject, description || null, categoryRow.name, team, priority || "Normal",
       assignedToUserId || null, slaHours, slaBreachAt, now, assignedToUserId ? now : null, req.user!.id, now, now,
       primaryVehicleId, linkedInstallationId || null,
       JSON.stringify(Array.isArray(linkedDeviceItemIds) ? linkedDeviceItemIds : []),
       JSON.stringify(Array.isArray(linkedSimIds) ? linkedSimIds : []),
       linkedInvoiceId || null]
    );

    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, new_status, by_user_id, by_user_email, created_at)
       VALUES (?, ?, 'Opened', ?, 'Open', ?, ?, ?)`,
      [uuidv4(), id, `Ticket opened: ${subject}`, req.user!.id, req.user!.email, now]
    );

    // Multiple vehicles on one case: create one auto-merged child ticket per
    // additional vehicle rather than a many-to-many schema — same
    // customer/subject/category, immediately linked under the primary via
    // parent_ticket_id (identical mechanism the Merge endpoint uses).
    const childTicketIds: string[] = [];
    for (const vehId of extraVehicleIds) {
      const childId = uuidv4();
      const childTicketNo = await nextTicketNo();
      await pgRun(
        `INSERT INTO crm_tickets
           (id, ticket_no, customer_id, subject, description, category, team, priority, status,
            sla_hours, sla_breach_at, opened_at, created_by_user_id, created_at, updated_at, vehicle_id, parent_ticket_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Merged', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [childId, childTicketNo, customerId || null, subject, description || null, categoryRow.name, team,
         priority || "Normal", slaHours, slaBreachAt, now, req.user!.id, now, now, vehId, id]
      );
      await pgRun(
        `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, new_status, linked_ticket_id, by_user_id, by_user_email, created_at)
         VALUES (?, ?, 'Merged', ?, 'Merged', ?, ?, ?, ?)`,
        [uuidv4(), childId, `Auto-merged into ${ticketNo} (multi-vehicle ticket)`, id, req.user!.id, req.user!.email, now]
      );
      childTicketIds.push(childId);
    }

    auditLog(req, "CRM_TICKET_CREATED", `crm_ticket:${id}`, "Info", { ticketNo, customerId, priority, category: categoryRow.name, team }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [id]);
    return created(res, { ...mapTicket(row), childTicketIds }, "Ticket created");
  }
);

// ── Get ticket ─────────────────────────────────────────────────────────────────
router.get(
  "/:id",
  requireAuth,
  requireRole(TICKET_VIEW_ROLES),
  async (req: AuthRequest, res) => {
    const row = await pgGet(
      `SELECT t.*, u.email AS assignee_email, cu.email AS consulted_email,
              COALESCE(ind.full_name, corp.company_name) AS customer_name,
              v.registration AS vehicle_registration,
              li.invoice_number AS li_invoice_number, li.total AS li_total, li.amount AS li_amount,
              li.vat_total AS li_vat_total, li.status AS li_status, li.currency AS li_currency
       FROM crm_tickets t
       LEFT JOIN users u ON u.id = t.assigned_to_user_id
       LEFT JOIN users cu ON cu.id = t.consulted_user_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = t.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = t.customer_id
       LEFT JOIN crm_customer_vehicles v ON v.id = t.vehicle_id
       LEFT JOIN invoices li ON li.id = t.linked_invoice_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found");

    // ABAC: Admin sees all; team-scoped roles must own the ticket's team;
    // Sales must have raised it themselves.
    if (req.user!.role !== "Admin") {
      const team = callerTeam(req.user!.role);
      if (team && row.team !== team) return errorResponse(res, 403, "FORBIDDEN", "Not your team's ticket");
      if (!team && req.user!.role === "Sales" && row.created_by_user_id !== req.user!.id) {
        return errorResponse(res, 403, "FORBIDDEN", "Not your ticket");
      }
    }

    const [actions, attachments, children] = await Promise.all([
      pgAll("SELECT * FROM crm_ticket_actions WHERE ticket_id = ? ORDER BY created_at ASC", [req.params.id]),
      pgAll("SELECT * FROM crm_ticket_attachments WHERE ticket_id = ? ORDER BY created_at DESC", [req.params.id]),
      pgAll("SELECT id, ticket_no, subject, status FROM crm_tickets WHERE parent_ticket_id = ?", [req.params.id]),
    ]);

    let parentTicket = null;
    if (row.parent_ticket_id) {
      parentTicket = await pgGet("SELECT id, ticket_no, subject, status FROM crm_tickets WHERE id = ?", [row.parent_ticket_id]);
    }

    return ok(res, { ticket: mapTicket(row), actions, attachments, linkedChildren: children, parentTicket });
  }
);

// ── Add action to ticket ───────────────────────────────────────────────────────
router.post(
  "/:id/actions",
  requireAuth,
  requireRole(TICKET_VIEW_ROLES),
  async (req: AuthRequest, res) => {
    const { actionType, comment, newStatus, assignedToUserId } = req.body;
    const now = new Date().toISOString();

    const ticket = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found");

    if (req.user!.role !== "Admin") {
      const team = callerTeam(req.user!.role);
      if (team && ticket.team !== team) return errorResponse(res, 403, "FORBIDDEN", "Not your team's ticket");
      if (!team && req.user!.role === "Sales" && ticket.created_by_user_id !== req.user!.id) {
        return errorResponse(res, 403, "FORBIDDEN", "Not your ticket");
      }
    }

    const validTypes = ["Comment", "StatusChange", "Escalated", "Reassigned", "Resolved", "Closed", "Reopened", "Transferred", "Merged", "Consulted", "DeviceSwapped", "BillingResolved", "UninstallationCompleted"];
    if (!actionType || !validTypes.includes(actionType)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", `actionType must be one of: ${validTypes.join(", ")}`);
    }

    const actionId = uuidv4();
    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, new_status, by_user_id, by_user_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [actionId, req.params.id, actionType, comment || null, newStatus || null, req.user!.id, req.user!.email, now]
    );

    const updates: string[] = ["updated_at = ?"];
    const upParams: any[] = [now];

    if (newStatus) {
      updates.push("status = ?");
      upParams.push(newStatus);
      if (newStatus === "Resolved") { updates.push("resolved_at = ?"); upParams.push(now); }
      if (newStatus === "Closed") { updates.push("closed_at = ?"); upParams.push(now); }
      if (newStatus === "Open") { updates.push("resolved_at = NULL, closed_at = NULL"); }
    }
    if (assignedToUserId !== undefined) {
      updates.push("assigned_to_user_id = ?");
      upParams.push(assignedToUserId || null);
      if (assignedToUserId) {
        updates.push("assigned_at = ?");
        upParams.push(now);
      }
    }
    upParams.push(req.params.id);
    await pgRun(`UPDATE crm_tickets SET ${updates.join(", ")} WHERE id = ?`, upParams);

    auditLog(req, "CRM_TICKET_ACTION", `crm_ticket:${req.params.id}`, "Info", { actionType, newStatus }).catch(console.error);
    const action = await pgGet("SELECT * FROM crm_ticket_actions WHERE id = ?", [actionId]);
    return created(res, action, "Action recorded");
  }
);

// ── Transfer — re-route a ticket to a different team ────────────────────────
router.post(
  "/:id/transfer",
  requireAuth,
  requireRole(TICKET_TEAM_ROLES),
  async (req: AuthRequest, res) => {
    const { toTeam, comment } = req.body || {};
    if (!["Technical", "Finance", "Support"].includes(toTeam)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "toTeam must be Technical, Finance, or Support.");
    }
    const ticket = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found");
    if (req.user!.role !== "Admin") {
      const team = callerTeam(req.user!.role);
      if (team && ticket.team !== team) return errorResponse(res, 403, "FORBIDDEN", "Not your team's ticket");
    }

    const now = new Date().toISOString();
    const fromTeam = ticket.team;
    await pgRun(`UPDATE crm_tickets SET team = ?, updated_at = ? WHERE id = ?`, [toTeam, now, req.params.id]);
    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, to_team, by_user_id, by_user_email, created_at)
       VALUES (?, ?, 'Transferred', ?, ?, ?, ?, ?)`,
      [uuidv4(), req.params.id, comment || `Transferred from ${fromTeam || "—"} to ${toTeam}`, toTeam, req.user!.id, req.user!.email, now]
    );

    auditLog(req, "CRM_TICKET_TRANSFERRED", `crm_ticket:${req.params.id}`, "Info", { fromTeam, toTeam }).catch(console.error);
    const updated = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    return ok(res, { data: mapTicket(updated!) }, "Ticket transferred.");
  }
);

// ── Merge — link a ticket as a child case of another (multiple issues, ─────
// one root cause) ────────────────────────────────────────────────────────────
router.post(
  "/:id/merge",
  requireAuth,
  requireRole(TICKET_TEAM_ROLES),
  async (req: AuthRequest, res) => {
    const { childTicketId, comment } = req.body || {};
    if (!childTicketId) return errorResponse(res, 400, "VALIDATION_ERROR", "childTicketId is required.");
    if (childTicketId === req.params.id) return errorResponse(res, 400, "VALIDATION_ERROR", "A ticket cannot be merged into itself.");

    const [parent, child] = await Promise.all([
      pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]),
      pgGet("SELECT * FROM crm_tickets WHERE id = ?", [childTicketId]),
    ]);
    if (!parent) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found.");
    if (!child) return errorResponse(res, 404, "NOT_FOUND", "Child ticket not found.");
    if (child.parent_ticket_id) return errorResponse(res, 409, "ALREADY_MERGED", "That ticket is already merged into another.");

    const now = new Date().toISOString();
    await pgRun(`UPDATE crm_tickets SET parent_ticket_id = ?, status = 'Merged', updated_at = ? WHERE id = ?`, [req.params.id, now, childTicketId]);
    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, new_status, linked_ticket_id, by_user_id, by_user_email, created_at)
       VALUES (?, ?, 'Merged', ?, 'Merged', ?, ?, ?, ?)`,
      [uuidv4(), childTicketId, comment || `Merged into ${parent.ticket_no}`, req.params.id, req.user!.id, req.user!.email, now]
    );
    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, linked_ticket_id, by_user_id, by_user_email, created_at)
       VALUES (?, ?, 'Merged', ?, ?, ?, ?, ?)`,
      [uuidv4(), req.params.id, `${child.ticket_no} merged into this ticket`, childTicketId, req.user!.id, req.user!.email, now]
    );

    auditLog(req, "CRM_TICKET_MERGED", `crm_ticket:${req.params.id}`, "Info", { childTicketId }).catch(console.error);
    return ok(res, { message: "Tickets merged." });
  }
);

// ── Consult — flag another technician for input without reassigning ────────
router.post(
  "/:id/consult",
  requireAuth,
  requireRole(TICKET_CONSULT_ROLES),
  async (req: AuthRequest, res) => {
    const { technicianUserId, comment } = req.body || {};
    if (!technicianUserId) return errorResponse(res, 400, "VALIDATION_ERROR", "technicianUserId is required.");

    const ticket = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found");

    const technician = await pgGet("SELECT id, email FROM users WHERE id = ?", [technicianUserId]);
    if (!technician) return errorResponse(res, 404, "NOT_FOUND", "Technician not found.");

    const now = new Date().toISOString();
    await pgRun(`UPDATE crm_tickets SET consulted_user_id = ?, updated_at = ? WHERE id = ?`, [technicianUserId, now, req.params.id]);
    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, by_user_id, by_user_email, created_at)
       VALUES (?, ?, 'Consulted', ?, ?, ?, ?)`,
      [uuidv4(), req.params.id, comment || `Consulted ${technician.email}`, req.user!.id, req.user!.email, now]
    );

    auditLog(req, "CRM_TICKET_CONSULTED", `crm_ticket:${req.params.id}`, "Info", { technicianUserId }).catch(console.error);
    const updated = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    return ok(res, { data: mapTicket(updated!) }, "Technician consulted.");
  }
);

// ── Swap Device — technician removes a faulty device (and optionally its
// SIM) from the vehicle and installs a replacement in one action, captured
// as a reinstallation. No approval gate: the defect report this creates
// simply lands in the existing Warranty & Defects queue. Never touches the
// (possibly locked/Completed) installation_tickets row itself — only the
// devices' own FKs are repointed, so the vehicle->device resolution join
// (GET /lookup/vehicle/:vehicleId above) keeps working unchanged.
// Extract a device's mounting position from an installation ticket's
// device_install_json (keyed by inv_items.id) — e.g. "Roof Lining · left side".
function mountFromInstall(instRow: any, deviceId: string): string | null {
  if (!instRow?.device_install_json) return null;
  try {
    const rec = JSON.parse(instRow.device_install_json)?.[deviceId];
    return rec ? ([rec.mountLocation, rec.mountDescription].filter(Boolean).join(" · ") || null) : null;
  } catch { return null; }
}

// A SIM pulled off a vehicle alongside its device is retained in the recovering
// technician's custody (status 'issued') — not freed straight back to the pool —
// so it shows under the technician's "My SIMs" until physically handed back.
async function retainSimToCustody(sim: any, custodianId: string, custodianName: string, actor: { id: string; email: string }, now: string) {
  await pgRun(
    `UPDATE inv_sims SET status = 'issued', issued_to_id = ?, issued_to_name = ?, issued_at = ?, acknowledged_at = ?, installation_id = NULL, device_item_id = NULL, updated_at = ? WHERE id = ?`,
    [custodianId, custodianName, now, now, now, sim.id]
  );
  await pgRun(
    `INSERT INTO inv_sim_ledger (id, sim_id, action, from_status, to_status, actor_id, actor_email, notes, created_at) VALUES (?, ?, 'RETAINED_TO_CUSTODY', ?, 'issued', ?, ?, ?, ?)`,
    [uuidv4(), sim.id, sim.status || null, actor.id, actor.email, `Retained by ${custodianName} on retrieval`, now]
  );
}

router.post(
  "/:id/swap-device",
  requireAuth,
  requireRole(ROLE_GROUPS.TEAM_TECHNICAL),
  async (req: AuthRequest, res) => {
    const { oldDeviceItemId, newDeviceItemId, reason, oldSimId, newSimId, custodianUserId } = req.body || {};
    if (!oldDeviceItemId || !newDeviceItemId) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "oldDeviceItemId and newDeviceItemId are required.");
    }
    if (!reason?.trim()) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "reason is required.");
    }
    if (oldDeviceItemId === newDeviceItemId) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Replacement device must be different from the device being removed.");
    }

    const ticket = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found");
    if (req.user!.role !== "Admin") {
      const team = callerTeam(req.user!.role);
      if (team && ticket.team !== team) return errorResponse(res, 403, "FORBIDDEN", "Not your team's ticket");
    }

    const linkedDeviceIds = safeJsonArray(ticket.linked_device_item_ids);
    if (!linkedDeviceIds.includes(oldDeviceItemId)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "That device is not linked to this ticket.");
    }

    const oldDevice = await pgGet(
      `SELECT i.*, p.device_model, p.product_name FROM inv_items i
       JOIN inv_product_catalog p ON p.id = i.product_id
       WHERE i.id = ? AND i.deleted_at IS NULL`,
      [oldDeviceItemId]
    );
    if (!oldDevice) return errorResponse(res, 404, "NOT_FOUND", "Device being removed not found.");
    if (!oldDevice.installation_id) {
      return errorResponse(res, 409, "CONFLICT", "Device is not currently linked to an installation.");
    }

    const newDevice = await pgGet(
      `SELECT i.*, p.device_model, p.product_name FROM inv_items i
       JOIN inv_product_catalog p ON p.id = i.product_id
       WHERE i.id = ? AND i.deleted_at IS NULL`,
      [newDeviceItemId]
    );
    if (!newDevice) return errorResponse(res, 404, "NOT_FOUND", "Replacement device not found.");
    if (newDevice.status !== "In Stock") {
      return errorResponse(res, 409, "DEVICE_NOT_AVAILABLE", `Replacement device must be In Stock (current: ${newDevice.status}).`);
    }

    // Optional SIM swap alongside the device swap
    let oldSim: any = null, newSim: any = null;
    if (oldSimId || newSimId) {
      if (!oldSimId || !newSimId) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "oldSimId and newSimId must both be provided to swap a SIM.");
      }
      oldSim = await pgGet(`SELECT * FROM inv_sims WHERE id = ? AND deleted_at IS NULL`, [oldSimId]);
      if (!oldSim || oldSim.device_item_id !== oldDeviceItemId) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "oldSimId is not the SIM installed on that device.");
      }
      newSim = await pgGet(`SELECT * FROM inv_sims WHERE id = ? AND deleted_at IS NULL`, [newSimId]);
      if (!newSim || newSim.status !== "available") {
        return errorResponse(res, 409, "DEVICE_NOT_AVAILABLE", `Replacement SIM must be available (current: ${newSim?.status || "not found"}).`);
      }
    }

    const now = new Date().toISOString();
    const installationId = oldDevice.installation_id;
    const priorCustomerId = oldDevice.customer_id;
    const defectReportId = uuidv4();
    const reinstallationId = uuidv4();
    // Custody recipient for the removed device = the ticket's technician (ISO can
    // override via custodianUserId). The swapped-out gadget is retrieved into THEIR
    // custody and flows through the retrieval lifecycle (not straight to Defective).
    const custodianId = custodianUserId || ticket.assigned_to_user_id || req.user!.id;
    const custodianRow = await pgGet("SELECT id, name, email FROM users WHERE id = ?", [custodianId]);
    const custodianName = custodianRow?.name || custodianRow?.email || req.user!.email;
    const oldInst = installationId
      ? await pgGet("SELECT ticket_no, installation_location, vehicle_registration, device_install_json FROM installation_tickets WHERE id = ?", [installationId])
      : null;
    const swapVehicle = ticket.vehicle_id
      ? await pgGet("SELECT registration FROM crm_customer_vehicles WHERE id = ?", [ticket.vehicle_id])
      : null;
    // Trackers are sometimes catalogued with only an IMEI and no serial_number
    // — di_defect_reports.device_serial is NOT NULL, so fall back the same way
    // the rest of the app treats IMEI as the effective identifier when absent.
    const oldDeviceLabel = oldDevice.serial_number || oldDevice.imei || oldDevice.id;
    const newDeviceLabel = newDevice.serial_number || newDevice.imei || newDevice.id;

    // 1. Auto-create a defect report for the removed device — surfaces it in
    //    the existing Warranty & Defects manager queue (device-custody.ts).
    await pgRun(
      `INSERT INTO di_defect_reports
         (id, device_id, device_serial, reported_by_user_id, reported_by_email,
          description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Reported', ?, ?)`,
      [defectReportId, oldDevice.id, oldDeviceLabel, req.user!.id, req.user!.email,
       `Swapped out via ticket ${ticket.ticket_no}: ${reason.trim()}`, now, now]
    );

    // 2. Old device: retrieved into the technician's custody (Awaiting Return),
    //    unlinked from the job/customer, still pointing at its replacement + defect
    //    report for traceability. The Repair/Dispose/Restock decision is made later
    //    at the retrieval "Return to Inventory" step.
    await pgRun(
      `UPDATE inv_items
       SET status = 'Awaiting Return', issued_to_id = ?, issued_to_name = ?, issued_at = ?, acknowledged_at = ?,
           installation_id = NULL, customer_id = NULL,
           replaced_by_item_id = ?, defect_ticket_id = ?, updated_at = ?
       WHERE id = ?`,
      [custodianId, custodianName, now, now, newDevice.id, defectReportId, now, oldDevice.id]
    );
    await pgRun(
      `INSERT INTO inv_movements (id, item_id, product_id, action, from_status, to_status, performed_by_user_id, performed_by_email, notes, created_at)
       VALUES (?, ?, ?, 'SWAPPED_TO_CUSTODY', 'Installed', 'Awaiting Return', ?, ?, ?, ?)`,
      [uuidv4(), oldDevice.id, oldDevice.product_id, req.user!.id, req.user!.email,
       `Swapped out via ticket ${ticket.ticket_no} into ${custodianName}'s custody: ${reason.trim()}`, now]
    );
    await recordRetrieval({
      device: oldDevice, sim: oldSim,
      vehicleId: ticket.vehicle_id || null,
      vehicleRegistration: oldInst?.vehicle_registration || swapVehicle?.registration || null,
      installationId, jobCardRef: oldInst?.ticket_no || null,
      installationLocation: oldInst?.installation_location || null,
      mountPosition: mountFromInstall(oldInst, oldDevice.id),
      supportTicketId: ticket.id, ticketNo: ticket.ticket_no,
      retrievalType: "Swap", reason: reason.trim(),
      previousStatus: "Installed", newStatus: "Awaiting Return",
      technicianId: custodianId, technicianName: custodianName,
      processedByUserId: req.user!.id, processedByEmail: req.user!.email,
    }).catch((e) => console.error("[swap-device] recordRetrieval failed", e));

    // 3. New device: Installed, takes over the old device's job/customer link
    await pgRun(
      `UPDATE inv_items
       SET status = 'Installed', installation_id = ?, customer_id = ?, deployed_at = ?, updated_at = ?
       WHERE id = ?`,
      [installationId, priorCustomerId, now, now, newDevice.id]
    );
    // Custody ends at install — clear any open checkout on the newly-installed device.
    await closeOpenCheckouts(newDevice.id, "system: closed on install", now);

    // 4. Optional SIM swap, same repoint pattern — the removed SIM is retained in
    //    the technician's custody (like the removed device), not freed to the pool.
    if (oldSim && newSim) {
      await retainSimToCustody(oldSim, custodianId, custodianName, { id: req.user!.id, email: req.user!.email }, now);
      await pgRun(
        `UPDATE inv_sims SET status = 'installed', installation_id = ?, device_item_id = ?, installed_at = ?, updated_at = ? WHERE id = ?`,
        [installationId, newDevice.id, now, now, newSim.id]
      );
    }

    // 5. Reinstallation audit record
    await pgRun(
      `INSERT INTO di_reinstallations
         (id, ticket_id, ticket_no, vehicle_id, installation_id,
          old_device_item_id, old_device_serial, new_device_item_id, new_device_serial,
          old_sim_id, new_sim_id, defect_report_id, reason, performed_by_user_id, performed_by_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reinstallationId, ticket.id, ticket.ticket_no, ticket.vehicle_id, installationId,
       oldDevice.id, oldDeviceLabel, newDevice.id, newDeviceLabel,
       oldSim?.id || null, newSim?.id || null, defectReportId, reason.trim(), req.user!.id, req.user!.email, now]
    );

    // 6. Update the ticket's linked device list (swap old id for new)
    const updatedDeviceIds = linkedDeviceIds.map((did: string) => (did === oldDeviceItemId ? newDeviceItemId : did));
    await pgRun(
      `UPDATE crm_tickets SET linked_device_item_ids = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(updatedDeviceIds), now, ticket.id]
    );

    // 7. Ticket timeline entry
    const swapComment = `Swapped device ${oldDeviceLabel} → ${newDeviceLabel}` +
      (oldSim && newSim ? ` (SIM ${oldSim.iccid} → ${newSim.iccid})` : "") + `: ${reason.trim()}`;
    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, linked_reinstallation_id, by_user_id, by_user_email, created_at)
       VALUES (?, ?, 'DeviceSwapped', ?, ?, ?, ?, ?)`,
      [uuidv4(), ticket.id, swapComment, reinstallationId, req.user!.id, req.user!.email, now]
    );

    auditLog(req, "CRM_TICKET_DEVICE_SWAPPED", `crm_ticket:${ticket.id}`, "Warning", {
      oldDeviceItemId, oldDeviceSerial: oldDeviceLabel,
      newDeviceItemId, newDeviceSerial: newDeviceLabel,
      reinstallationId, defectReportId,
    }).catch(console.error);

    return created(res, {
      reinstallationId, defectReportId,
      oldDeviceSerial: oldDeviceLabel,
      newDeviceSerial: newDeviceLabel,
      custodian: custodianName,
    }, `Device swapped — removed device retrieved into ${custodianName}'s custody.`);
  }
);

// ── Retrieve a device into custody without a swap (Gadget Issue tickets) ──────
router.post(
  "/:id/retrieve-device",
  requireAuth,
  requireRole(ROLE_GROUPS.TEAM_TECHNICAL),
  async (req: AuthRequest, res) => {
    const { deviceItemId, reason, custodianUserId } = req.body || {};
    if (!deviceItemId) return errorResponse(res, 400, "VALIDATION_ERROR", "deviceItemId is required.");

    const ticket = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found");
    if (req.user!.role !== "Admin") {
      const team = callerTeam(req.user!.role);
      if (team && ticket.team !== team) return errorResponse(res, 403, "FORBIDDEN", "Not your team's ticket");
    }

    const device = await pgGet(
      `SELECT i.*, p.device_model, p.product_name FROM inv_items i
       JOIN inv_product_catalog p ON p.id = i.product_id
       WHERE i.id = ? AND i.deleted_at IS NULL`,
      [deviceItemId]
    );
    if (!device) return errorResponse(res, 404, "NOT_FOUND", "Device not found.");
    if (device.status !== "Installed" && !device.installation_id) {
      return errorResponse(res, 409, "CONFLICT", `Device is not currently installed on a vehicle (status: ${device.status}).`);
    }

    const now = new Date().toISOString();
    const custodianId = custodianUserId || ticket.assigned_to_user_id || req.user!.id;
    const custodianRow = await pgGet("SELECT id, name, email FROM users WHERE id = ?", [custodianId]);
    const custodianName = custodianRow?.name || custodianRow?.email || req.user!.email;
    const inst = device.installation_id
      ? await pgGet("SELECT ticket_no, installation_location, vehicle_registration, device_install_json FROM installation_tickets WHERE id = ?", [device.installation_id])
      : null;
    const retVehicle = ticket.vehicle_id
      ? await pgGet("SELECT registration FROM crm_customer_vehicles WHERE id = ?", [ticket.vehicle_id])
      : null;
    const pairedSim = await pgGet("SELECT * FROM inv_sims WHERE device_item_id = ? AND deleted_at IS NULL", [device.id]).catch(() => null);
    const prevInstallationId = device.installation_id;

    await pgRun(
      `UPDATE inv_items
         SET status = 'Awaiting Return', issued_to_id = ?, issued_to_name = ?, issued_at = ?, acknowledged_at = ?,
             installation_id = NULL, customer_id = NULL, updated_at = ?
       WHERE id = ?`,
      [custodianId, custodianName, now, now, now, device.id]
    );
    if (pairedSim) {
      await retainSimToCustody(pairedSim, custodianId, custodianName, { id: req.user!.id, email: req.user!.email }, now);
    }
    await pgRun(
      `INSERT INTO inv_movements (id, item_id, product_id, action, from_status, to_status, performed_by_user_id, performed_by_email, notes, created_at)
       VALUES (?, ?, ?, 'RETRIEVED_TO_CUSTODY', 'Installed', 'Awaiting Return', ?, ?, ?, ?)`,
      [uuidv4(), device.id, device.product_id, req.user!.id, req.user!.email,
       `Retrieved via ${ticket.ticket_no} into ${custodianName}'s custody${reason ? `: ${reason}` : ""}`, now]
    );
    const retrieval = await recordRetrieval({
      device, sim: pairedSim,
      vehicleId: ticket.vehicle_id || null,
      vehicleRegistration: inst?.vehicle_registration || retVehicle?.registration || null,
      installationId: prevInstallationId, jobCardRef: inst?.ticket_no || null,
      installationLocation: inst?.installation_location || null,
      mountPosition: mountFromInstall(inst, device.id),
      supportTicketId: ticket.id, ticketNo: ticket.ticket_no,
      retrievalType: "GadgetIssue", reason: reason?.trim() || `Retrieved via ${ticket.ticket_no}`,
      previousStatus: "Installed", newStatus: "Awaiting Return",
      technicianId: custodianId, technicianName: custodianName,
      processedByUserId: req.user!.id, processedByEmail: req.user!.email,
    }).catch((e) => { console.error("[retrieve-device] recordRetrieval failed", e); return null; });

    const deviceLabel = device.serial_number || device.imei || device.id;
    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, by_user_id, by_user_email, created_at)
       VALUES (?, ?, 'Comment', ?, ?, ?, ?)`,
      [uuidv4(), ticket.id, `Retrieved device ${deviceLabel} into ${custodianName}'s custody${reason ? `: ${reason.trim()}` : ""}`, req.user!.id, req.user!.email, now]
    );
    auditLog(req, "CRM_TICKET_DEVICE_RETRIEVED", `crm_ticket:${ticket.id}`, "Warning", { deviceItemId: device.id, custodianId }).catch(console.error);

    return created(res, {
      retrievalNo: retrieval?.retrieval_no || null,
      deviceSerial: deviceLabel,
      custodian: custodianName,
    }, `Device retrieved into ${custodianName}'s custody.`);
  }
);

// ── Resolve Billing — Finance confirms the legitimacy of a billing claim
// (having reviewed the linked quotation/invoice) and records the
// determination. If a reimbursement is warranted, a credit note or cheque is
// issued and the invoice is cancelled net of commission and tax. Mirrors
// swap-device's shape: a domain event triggered from a Finance-team ticket,
// written into its own domain table (credit_notes, owned by
// credit-notes.ts) plus the ticket's own timeline. The invoice cancellation
// is applied here directly (raw UPDATE) rather than via updateInvoice()/
// updateInvoiceStatusFromPayments() — those carry side effects (overdue
// re-flip, payments recompute) that have no business firing on a
// Finance-initiated cancellation.
router.post(
  "/:id/resolve-billing",
  requireAuth,
  requireRole(ROLE_GROUPS.TEAM_FINANCE),
  async (req: AuthRequest, res) => {
    const {
      approved, reason, reimbursementNeeded, method,
      claimAmount, commissionFee, taxAmount, chequeNumber,
    } = req.body || {};

    if (typeof approved !== "boolean") {
      return errorResponse(res, 400, "VALIDATION_ERROR", "approved (boolean) is required.");
    }
    if (!reason?.trim()) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "reason is required.");
    }
    if (!approved && reimbursementNeeded) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "A rejected claim cannot have a reimbursement.");
    }

    const ticket = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found");
    if (req.user!.role !== "Admin") {
      const team = callerTeam(req.user!.role);
      if (team && ticket.team !== team) return errorResponse(res, 403, "FORBIDDEN", "Not your team's ticket");
    }

    const already = await pgGet(
      `SELECT 1 FROM crm_ticket_actions WHERE ticket_id = ? AND action_type = 'BillingResolved'`,
      [req.params.id]
    );
    if (already) return errorResponse(res, 409, "ALREADY_RESOLVED", "This ticket's billing issue has already been resolved.");

    const wantsReimbursement = !!(approved && reimbursementNeeded);

    let invoice: any = null;
    let claimAmt = 0, commissionAmt = 0, taxAmt = 0, netAmt = 0;

    if (wantsReimbursement) {
      if (!["CreditNote", "ChequePayment"].includes(method)) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "method must be CreditNote or ChequePayment.");
      }
      if (!ticket.linked_invoice_id) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "This ticket has no linked invoice — reimbursement is not available.");
      }
      invoice = await pgGet("SELECT * FROM invoices WHERE id = ?", [ticket.linked_invoice_id]);
      if (!invoice) return errorResponse(res, 404, "NOT_FOUND", "Linked invoice not found.");
      if (invoice.status === "Cancelled") {
        return errorResponse(res, 409, "INVOICE_ALREADY_CANCELLED", "This invoice has already been cancelled.");
      }

      claimAmt = Number(claimAmount);
      commissionAmt = Number(commissionFee ?? 0);
      taxAmt = Number(taxAmount ?? 0);
      if (!Number.isFinite(claimAmt) || claimAmt <= 0) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "claimAmount must be a positive number.");
      }
      if (!Number.isFinite(commissionAmt) || commissionAmt < 0) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "commissionFee must be zero or a positive number.");
      }
      if (!Number.isFinite(taxAmt) || taxAmt < 0) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "taxAmount must be zero or a positive number.");
      }
      netAmt = claimAmt - commissionAmt - taxAmt;
      if (netAmt < 0) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "Net amount (claim minus commission minus tax) cannot be negative.");
      }
      if (method === "ChequePayment" && !chequeNumber?.trim()) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "chequeNumber is required for a cheque reimbursement.");
      }
    }

    const now = new Date().toISOString();
    const creditNoteId = uuidv4();
    const creditNoteNo = wantsReimbursement
      ? await nextDatedBatchNumber("CN", [{ table: "credit_notes", column: "credit_note_no" }])
      : null;

    await pgRun(
      `INSERT INTO credit_notes
         (id, credit_note_no, ticket_id, ticket_no, invoice_id, invoice_number, customer_id,
          outcome, reimbursement_issued, method, claim_amount, commission_fee, tax_amount, net_amount,
          cheque_number, reason, created_by_user_id, created_by_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [creditNoteId, creditNoteNo, ticket.id, ticket.ticket_no,
       wantsReimbursement ? ticket.linked_invoice_id : null,
       wantsReimbursement ? invoice.invoice_number : null,
       ticket.customer_id || null,
       approved ? "Approved" : "Rejected", wantsReimbursement,
       wantsReimbursement ? method : null,
       wantsReimbursement ? claimAmt : null,
       wantsReimbursement ? commissionAmt : null,
       wantsReimbursement ? taxAmt : null,
       wantsReimbursement ? netAmt : null,
       wantsReimbursement && method === "ChequePayment" ? chequeNumber.trim() : null,
       reason.trim(), req.user!.id, req.user!.email, now]
    );

    if (wantsReimbursement) {
      await pgRun(`UPDATE invoices SET status = 'Cancelled', updated_at = ? WHERE id = ?`, [now, ticket.linked_invoice_id]);
    }

    await pgRun(`UPDATE crm_tickets SET status = 'Resolved', resolved_at = ?, updated_at = ? WHERE id = ?`, [now, now, ticket.id]);

    const summary = approved
      ? (wantsReimbursement
          ? `Billing claim approved — ${method === "ChequePayment" ? `cheque ${chequeNumber.trim()}` : "credit note"} ${creditNoteNo} issued for KES ${netAmt.toLocaleString()} (claim ${claimAmt.toLocaleString()} minus commission ${commissionAmt.toLocaleString()} minus tax ${taxAmt.toLocaleString()}). Invoice ${invoice.invoice_number} cancelled.`
          : `Billing claim approved — no reimbursement required.`)
      : `Billing claim rejected: ${reason.trim()}`;

    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, new_status, linked_credit_note_id, by_user_id, by_user_email, created_at)
       VALUES (?, ?, 'BillingResolved', ?, 'Resolved', ?, ?, ?, ?)`,
      [uuidv4(), ticket.id, summary, creditNoteId, req.user!.id, req.user!.email, now]
    );

    auditLog(req, "CRM_TICKET_BILLING_RESOLVED", `crm_ticket:${ticket.id}`, wantsReimbursement ? "Warning" : "Info", {
      approved, reimbursementIssued: wantsReimbursement, method: wantsReimbursement ? method : null,
      creditNoteId, creditNoteNo, invoiceId: wantsReimbursement ? ticket.linked_invoice_id : null,
      claimAmount: wantsReimbursement ? claimAmt : null, netAmount: wantsReimbursement ? netAmt : null,
    }).catch(console.error);

    return created(res, {
      creditNoteId, creditNoteNo, outcome: approved ? "Approved" : "Rejected",
      reimbursementIssued: wantsReimbursement, invoiceCancelled: wantsReimbursement,
    }, "Billing issue resolved.");
  }
);

// ── Complete Uninstallation — technician confirms a device (and its SIM, if
// any) have been physically removed from a vehicle whose loan has ended or
// been settled early. Mirrors swap-device's shape (validate linkage, raw-SQL
// multi-step write, no DB transaction wrapper, timeline entry with a
// linked_X_id column) but WITHOUT installing a replacement — this is a
// permanent removal. Devices go to 'Returned' (not 'Defective' — a working
// device coming off a paid-off vehicle, not a fault) and are freed back to
// available inventory. Never touches the (possibly locked) installation_
// tickets row — only the devices'/SIMs' own FKs are repointed, same as
// swap-device. Writes the terminal transition directly into
// gps_uninstall_queue (owned by gps-uninstall-queue.ts), mirroring how this
// file already writes into credit_notes/di_reinstallations owned elsewhere.
router.post(
  "/:id/complete-uninstallation",
  requireAuth,
  requireRole(ROLE_GROUPS.TEAM_TECHNICAL),
  async (req: AuthRequest, res) => {
    const { deviceItemIds, simIds, notes, custodianUserId } = req.body || {};

    const ticket = await pgGet("SELECT * FROM crm_tickets WHERE id = ?", [req.params.id]);
    if (!ticket) return errorResponse(res, 404, "NOT_FOUND", "Ticket not found");
    if (req.user!.role !== "Admin") {
      const team = callerTeam(req.user!.role);
      if (team && ticket.team !== team) return errorResponse(res, 403, "FORBIDDEN", "Not your team's ticket");
    }
    if (ticket.category !== "Uninstallation") {
      return errorResponse(res, 400, "VALIDATION_ERROR", "This action is only available on Uninstallation tickets.");
    }

    const already = await pgGet(
      `SELECT 1 FROM crm_ticket_actions WHERE ticket_id = ? AND action_type = 'UninstallationCompleted'`,
      [req.params.id]
    );
    if (already) return errorResponse(res, 409, "ALREADY_COMPLETED", "This ticket's uninstallation has already been completed.");

    const linkedDeviceIds = safeJsonArray(ticket.linked_device_item_ids);
    const linkedSimIds = safeJsonArray(ticket.linked_sim_ids);

    const targetDeviceIds: string[] = Array.isArray(deviceItemIds) && deviceItemIds.length ? deviceItemIds : linkedDeviceIds;
    const targetSimIds: string[] = Array.isArray(simIds) && simIds.length ? simIds : linkedSimIds;

    if (!targetDeviceIds.length) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "This ticket has no linked devices to remove.");
    }
    for (const did of targetDeviceIds) {
      if (!linkedDeviceIds.includes(did)) return errorResponse(res, 400, "VALIDATION_ERROR", "One or more devices are not linked to this ticket.");
    }
    for (const sid of targetSimIds) {
      if (!linkedSimIds.includes(sid)) return errorResponse(res, 400, "VALIDATION_ERROR", "One or more SIMs are not linked to this ticket.");
    }

    // Load + validate every device/SIM up front, before writing anything —
    // avoids a partial removal if one ID turns out to be bad.
    const devices: any[] = [];
    for (const did of targetDeviceIds) {
      const d = await pgGet(
        `SELECT i.*, p.device_model, p.product_name FROM inv_items i
         JOIN inv_product_catalog p ON p.id = i.product_id
         WHERE i.id = ? AND i.deleted_at IS NULL`,
        [did]
      );
      if (!d) return errorResponse(res, 404, "NOT_FOUND", `Device ${did} not found.`);
      devices.push(d);
    }
    const sims: any[] = [];
    for (const sid of targetSimIds) {
      const s = await pgGet(`SELECT * FROM inv_sims WHERE id = ? AND deleted_at IS NULL`, [sid]);
      if (!s) return errorResponse(res, 404, "NOT_FOUND", `SIM ${sid} not found.`);
      sims.push(s);
    }

    const now = new Date().toISOString();

    // Custody recipient = the technician who performs the uninstall — the ticket's
    // assigned technician, else the staff member completing the action. The gadget
    // is retrieved into THEIR custody first; it only reaches inventory after a
    // separate "Return to Inventory" step (device-custody /return-recovered).
    const custodianId = custodianUserId || ticket.assigned_to_user_id || req.user!.id;
    const custodian = await pgGet("SELECT id, name, email FROM users WHERE id = ?", [custodianId]);
    const custodianName = custodian?.name || custodian?.email || req.user!.email;
    const ticketVehicle = ticket.vehicle_id
      ? await pgGet("SELECT registration FROM crm_customer_vehicles WHERE id = ?", [ticket.vehicle_id])
      : null;

    // 1. Devices: retrieved from the vehicle into the uninstalling technician's
    //    custody (status 'Awaiting Return') — NOT straight back to stock. The
    //    original installing technician is recorded on the item note + movement
    //    ledger for traceability.
    for (const d of devices) {
      let installerNote = "";
      let inst: any = null;
      if (d.installation_id) {
        inst = await pgGet(
          "SELECT id, ticket_no, installation_location, vehicle_registration, assigned_to_email, device_install_json FROM installation_tickets WHERE id = ?",
          [d.installation_id]
        );
        if (inst?.assigned_to_email) installerNote = ` Originally installed by ${inst.assigned_to_email}.`;
      }
      const prevInstallationId = d.installation_id;
      const recoveryNote = `Recovered via uninstall ticket ${ticket.ticket_no} on ${now}; held by ${custodianName}.${installerNote}`;
      await pgRun(
        `UPDATE inv_items
           SET status = 'Awaiting Return',
               issued_to_id = ?, issued_to_name = ?, issued_at = ?, acknowledged_at = ?,
               installation_id = NULL, customer_id = NULL,
               notes = COALESCE(NULLIF(notes,''),'') || CASE WHEN notes IS NOT NULL AND notes <> '' THEN ' | ' ELSE '' END || ?,
               updated_at = ?
         WHERE id = ?`,
        [custodianId, custodianName, now, now, recoveryNote, now, d.id]
      );
      await pgRun(
        `INSERT INTO inv_movements (id, item_id, product_id, action, from_status, to_status, performed_by_user_id, performed_by_email, notes, created_at)
         VALUES (?, ?, ?, 'UNINSTALLED_TO_CUSTODY', 'Installed', 'Awaiting Return', ?, ?, ?, ?)`,
        [uuidv4(), d.id, d.product_id, req.user!.id, req.user!.email, recoveryNote, now]
      );
      const pairedSim = sims.find((s) => s.device_item_id === d.id) || null;
      await recordRetrieval({
        device: d, sim: pairedSim,
        vehicleId: ticket.vehicle_id || null,
        vehicleRegistration: inst?.vehicle_registration || ticketVehicle?.registration || null,
        installationId: prevInstallationId || null,
        jobCardRef: inst?.ticket_no || null,
        installationLocation: inst?.installation_location || null,
        mountPosition: mountFromInstall(inst, d.id),
        supportTicketId: ticket.id, ticketNo: ticket.ticket_no,
        retrievalType: "Uninstallation",
        reason: notes?.trim() || `Uninstallation via ${ticket.ticket_no}`,
        previousStatus: "Installed", newStatus: "Awaiting Return",
        technicianId: custodianId, technicianName: custodianName,
        processedByUserId: req.user!.id, processedByEmail: req.user!.email,
      }).catch((e) => console.error("[complete-uninstallation] recordRetrieval failed", e));
    }

    // 2. SIMs: retained in the recovering technician's custody, unlinked from job/device
    for (const s of sims) {
      await retainSimToCustody(s, custodianId, custodianName, { id: req.user!.id, email: req.user!.email }, now);
    }

    // 3. Queue row -> Completed (best-effort link; a missing link doesn't
    //    block the physical removal, which is the operationally critical part)
    const queueRow = await pgGet(
      `SELECT id FROM gps_uninstall_queue WHERE linked_ticket_id = ? AND status = 'TicketRaised'`,
      [ticket.id]
    );
    if (queueRow) {
      await pgRun(
        `UPDATE gps_uninstall_queue SET status = 'Completed', completed_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, queueRow.id]
      );
    } else {
      console.warn(`[crm-tickets] complete-uninstallation: no TicketRaised queue row found for ticket ${ticket.id}`);
    }

    // 4. Ticket resolution + timeline entry
    const deviceLabels = devices.map((d) => d.serial_number || d.imei || d.id);
    const simLabels = sims.map((s) => s.iccid);
    const summary = `Uninstallation completed — ${deviceLabels.join(", ")} retrieved into ${custodianName}'s custody, awaiting return to inventory` +
      (simLabels.length ? ` (SIM${simLabels.length > 1 ? "s" : ""} ${simLabels.join(", ")} retained in custody)` : "") +
      (notes?.trim() ? `. ${notes.trim()}` : "");

    await pgRun(`UPDATE crm_tickets SET status = 'Resolved', resolved_at = ?, updated_at = ? WHERE id = ?`, [now, now, ticket.id]);
    await pgRun(
      `INSERT INTO crm_ticket_actions (id, ticket_id, action_type, comment, new_status, linked_uninstall_queue_id, by_user_id, by_user_email, created_at)
       VALUES (?, ?, 'UninstallationCompleted', ?, 'Resolved', ?, ?, ?, ?)`,
      [uuidv4(), ticket.id, summary, queueRow?.id || null, req.user!.id, req.user!.email, now]
    );

    auditLog(req, "CRM_TICKET_UNINSTALLATION_COMPLETED", `crm_ticket:${ticket.id}`, "Warning", {
      deviceItemIds: targetDeviceIds, simIds: targetSimIds, queueId: queueRow?.id || null,
    }).catch(console.error);

    return created(res, {
      removedDeviceSerials: deviceLabels,
      removedSimIccids: simLabels,
      queueId: queueRow?.id || null,
      queueLinked: !!queueRow,
      ticketStatus: "Resolved",
    }, "Uninstallation completed — device(s) returned to inventory.");
  }
);

// ── Attachments ────────────────────────────────────────────────────────────
const buildUploadStorage = (subDir: string) =>
  multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(process.cwd(), "uploads", subDir, (req.params as any).id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".bin";
      cb(null, uuidv4() + ext);
    },
  });

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

const ticketUploadMiddleware = multer({
  storage: buildUploadStorage("crm-tickets"),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error("Only images and PDFs are allowed."));
  },
}).single("file");

router.post(
  "/:id/upload",
  requireAuth,
  requireRole(TICKET_VIEW_ROLES),
  (req, res, next) => {
    pgGet(`SELECT id FROM crm_tickets WHERE id = ?`, [req.params.id]).then((t) => {
      if (!t) { res.status(404).json({ error: { code: "NOT_FOUND", message: "Ticket not found." } }); return; }
      ticketUploadMiddleware(req, res, (err) => {
        if (err) return res.status(400).json({ error: { code: "UPLOAD_ERROR", message: err.message } });
        next();
      });
    }).catch(next);
  },
  async (req: AuthRequest, res) => {
    if (!(req as any).file) return errorResponse(res, 400, "NO_FILE", "No file attached.");
    const f = (req as any).file as Express.Multer.File;
    const url = `/uploads/crm-tickets/${req.params.id}/${f.filename}`;
    const now = new Date().toISOString();
    const attachmentId = uuidv4();
    await pgRun(
      `INSERT INTO crm_ticket_attachments (id, ticket_id, filename, url, mimetype, size_bytes, uploaded_by_user_id, uploaded_by_email, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [attachmentId, req.params.id, f.filename, url, f.mimetype, f.size, req.user!.id, req.user!.email, now]
    );
    auditLog(req, "CRM_TICKET_ATTACHMENT_UPLOADED", `crm_ticket:${req.params.id}`, "Info", { filename: f.filename }).catch(console.error);
    return created(res, { data: { id: attachmentId, filename: f.filename, url, mimetype: f.mimetype, sizeBytes: f.size } });
  }
);

router.get("/:id/attachments", requireAuth, requireRole(TICKET_VIEW_ROLES), async (req: AuthRequest, res) => {
  const rows = await pgAll("SELECT * FROM crm_ticket_attachments WHERE ticket_id = ? ORDER BY created_at DESC", [req.params.id]);
  return ok(res, { data: rows });
});

router.delete("/:id/attachments/:attachmentId", requireAuth, requireRole(TICKET_VIEW_ROLES), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT * FROM crm_ticket_attachments WHERE id = ? AND ticket_id = ?", [req.params.attachmentId, req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Attachment not found.");
  await pgRun("DELETE FROM crm_ticket_attachments WHERE id = ?", [req.params.attachmentId]);
  fs.unlink(path.join(process.cwd(), "uploads", "crm-tickets", req.params.id, row.filename), () => {});
  auditLog(req, "CRM_TICKET_ATTACHMENT_DELETED", `crm_ticket:${req.params.id}`, "Info", { filename: row.filename }).catch(console.error);
  return ok(res, { message: "Attachment deleted." });
});

// ── Ticket stats ───────────────────────────────────────────────────────────────
router.get("/stats/summary", requireAuth, requireRole(TICKET_VIEW_ROLES), async (req: AuthRequest, res) => {
  // Self-scope roles (Sales, BDMCorporate) see counts for the tickets THEY raised,
  // matching their self-scoped list; team roles & Admin keep the global pulse.
  const selfScope = TICKET_SELF_SCOPE_ROLES.includes(req.user!.role);
  const s = selfScope ? " AND created_by_user_id = ?" : "";
  const p = selfScope ? [req.user!.id] : [];
  const [open, inProgress, resolved, breached] = await Promise.all([
    pgGet(`SELECT COUNT(*) AS n FROM crm_tickets WHERE status = 'Open'${s}`, [...p]),
    pgGet(`SELECT COUNT(*) AS n FROM crm_tickets WHERE status = 'In Progress'${s}`, [...p]),
    pgGet(`SELECT COUNT(*) AS n FROM crm_tickets WHERE status = 'Resolved'${s}`, [...p]),
    pgGet(`SELECT COUNT(*) AS n FROM crm_tickets WHERE status NOT IN ('Closed','Resolved','Merged') AND sla_breach_at < ?${s}`, [new Date().toISOString(), ...p]),
  ]);
  return ok(res, {
    open: Number(open?.n ?? 0),
    inProgress: Number(inProgress?.n ?? 0),
    resolved: Number(resolved?.n ?? 0),
    slaBreached: Number(breached?.n ?? 0),
  });
});

// ── Ticket dashboard — single aggregate call for support-dashboard.html.
// Scoped to the caller's team (callerTeam): a team member sees their own team's
// tickets; Admin / oversight roles (callerTeam === null) see ALL teams. Previously
// this was hardcoded to team='Support', so it read 0 for everyone whenever the
// active tickets lived on the Technical/Finance queues.
router.get("/stats/support-dashboard", requireAuth, requireRole(TICKET_TEAM_ROLES), async (req: AuthRequest, res) => {
  const now = new Date();
  const nowIso = now.toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400_000).toISOString();

  const team = callerTeam(req.user!.role); // null = Admin / oversight → all teams
  // team clause used in each query; `t.` prefixed variant for the aliased queries.
  const tf  = team ? "team = ?"   : "TRUE";
  const tfT = team ? "t.team = ?" : "TRUE";
  const tp  = team ? [team] : [];

  const [open, inProgress, resolvedThisWeek, breached, avgResolution, volumeRows, statusRows, categoryRows, oldestOpen, workloadRows] = await Promise.all([
    // "Open" = awaiting first action (unassigned); "In Progress" = being worked
    // on (assigned) — matches the card subtitles. crm_tickets has no distinct
    // 'In Progress' status, so the assigned/unassigned split is what's meaningful.
    pgGet(`SELECT COUNT(*) AS n FROM crm_tickets WHERE ${tf} AND status = 'Open' AND assigned_to_user_id IS NULL`, [...tp]),
    pgGet(`SELECT COUNT(*) AS n FROM crm_tickets WHERE ${tf} AND status = 'Open' AND assigned_to_user_id IS NOT NULL`, [...tp]),
    pgGet(`SELECT COUNT(*) AS n FROM crm_tickets WHERE ${tf} AND status = 'Resolved' AND resolved_at >= ?`, [...tp, sevenDaysAgo]),
    pgGet(`SELECT COUNT(*) AS n FROM crm_tickets WHERE ${tf} AND status NOT IN ('Closed','Resolved','Merged') AND sla_breach_at < ?`, [...tp, nowIso]),
    pgGet(
      `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at::timestamptz - opened_at::timestamptz)) / 3600) AS avg_hours
       FROM crm_tickets WHERE ${tf} AND resolved_at IS NOT NULL AND resolved_at >= ?`,
      [...tp, thirtyDaysAgo]
    ),
    pgAll(
      `SELECT TO_CHAR(opened_at::timestamptz, 'YYYY-MM-DD') AS day, COUNT(*) AS n
       FROM crm_tickets WHERE ${tf} AND opened_at >= ? GROUP BY day ORDER BY day`,
      [...tp, thirtyDaysAgo]
    ),
    pgAll(`SELECT status, COUNT(*) AS n FROM crm_tickets WHERE ${tf} GROUP BY status`, [...tp]),
    pgAll(`SELECT category, COUNT(*) AS n FROM crm_tickets WHERE ${tf} GROUP BY category`, [...tp]),
    pgAll(
      `SELECT t.id, t.ticket_no, t.subject, t.category, t.priority, t.status, t.opened_at, t.sla_breach_at,
              u.email AS assignee_email,
              COALESCE(ind.full_name, corp.company_name) AS customer_name
       FROM crm_tickets t
       LEFT JOIN users u ON u.id = t.assigned_to_user_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = t.customer_id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = t.customer_id
       WHERE ${tfT} AND t.status NOT IN ('Resolved','Closed','Merged')
       ORDER BY t.opened_at ASC LIMIT 10`,
      [...tp]
    ),
    pgAll(
      `SELECT u.email AS assignee_email, COUNT(*) AS n
       FROM crm_tickets t LEFT JOIN users u ON u.id = t.assigned_to_user_id
       WHERE ${tfT} AND t.status NOT IN ('Resolved','Closed','Merged')
       GROUP BY u.email ORDER BY n DESC`,
      [...tp]
    ),
  ]);

  // Zero-fill the 30-day volume trend so the chart has a continuous x-axis
  const volumeByDay: Record<string, number> = {};
  for (const r of volumeRows as any[]) volumeByDay[r.day] = Number(r.n);
  const volumeTrend: { date: string; count: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10);
    volumeTrend.push({ date: day, count: volumeByDay[day] || 0 });
  }

  return ok(res, {
    scope: team || "All teams",
    cards: {
      open: Number(open?.n ?? 0),
      inProgress: Number(inProgress?.n ?? 0),
      resolvedThisWeek: Number(resolvedThisWeek?.n ?? 0),
      slaBreached: Number(breached?.n ?? 0),
      avgResolutionHours: avgResolution?.avg_hours != null ? Math.round(Number(avgResolution.avg_hours) * 10) / 10 : null,
    },
    volumeTrend,
    statusBreakdown: (statusRows as any[]).map((r) => ({ status: r.status, count: Number(r.n) })),
    categoryBreakdown: (categoryRows as any[]).map((r) => ({ category: r.category, count: Number(r.n) })),
    oldestOpen: (oldestOpen as any[]).map((r) => ({
      id: r.id, ticketNo: r.ticket_no, subject: r.subject, category: r.category, priority: r.priority, status: r.status,
      openedAt: r.opened_at, slaBreachAt: r.sla_breach_at, assigneeEmail: r.assignee_email || null, customerName: r.customer_name || null,
    })),
    workload: (workloadRows as any[]).map((r) => ({ assigneeEmail: r.assignee_email || "Unassigned", count: Number(r.n) })),
  });
});

export default router;
