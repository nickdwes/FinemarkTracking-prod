/**
 * Vehicle Installation Management API
 * STRIDE/LINDDUN-aligned:
 *   – All PII (IMEI, SIM, VIN, engine no.) encrypted at rest via AES-256-GCM
 *   – RBAC on every route; ABAC for technician own-job enforcement
 *   – Full audit trail on every mutation
 *   – OTP confirmation for customer sign-off
 *   – Sensitive fields masked by role in responses
 */
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun, pgExec } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS, resolveTechnicianIdSet } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { encryptField, decryptField, maskValue } from "../services/cryptoService.js";
import { hashRefreshToken } from "../utils/tokens.js";
import { sendSms, isSmsConfigured } from "../services/smsService.js";
import { createNotification } from "./notifications.js";
import { isGraphConfigured, sendEmailViaGraph, MAILBOXES } from "../services/graphMailService.js";

/** Redirect email to DEV_NOTIFY_EMAIL when set, otherwise use actual address */
function notifyEmail(actual: string): string {
  return process.env.DEV_NOTIFY_EMAIL || actual;
}

const router = Router();

// This file's routes historically only checked the legacy "Sales" role
// string, silently locking out anyone whose account already carries a
// canonical sales role (CorporateSales/BDM/BDMCorporate/KAM/Telesales) —
// the same set installation-tickets.ts grants via ROLE_GROUPS.CAN_RAISE_TICKETS.
// Kept as a local shared constant (rather than importing CAN_RAISE_TICKETS
// directly) since every call site here additively spreads it alongside a
// different mix of Admin/Technical/Technician/InstallOffice, and "Sales"
// itself must stay for legacy accounts that haven't been migrated.
const SALES_ROLES = ["Sales", "BDM", "BDMCorporate", "CorporateSales", "KAM", "Telesales"];

// ── Ensure tables exist ────────────────────────────────────────────────────────
pgExec(`
  CREATE TABLE IF NOT EXISTS vi_installations (
    id TEXT PRIMARY KEY,
    vehicle_id TEXT,
    customer_id TEXT NOT NULL,
    ticket_ref TEXT,
    assigned_technician_id TEXT,
    assigned_technician_email TEXT,
    assigned_at TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    stage INTEGER NOT NULL DEFAULT 0,
    vin_enc TEXT,
    engine_number_enc TEXT,
    fuel_type TEXT,
    dashboard_config_json TEXT,
    electrical_notes TEXT,
    post_install_notes TEXT,
    completed_at TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`).catch(e => console.error("[vi_installations] init:", e));

// Allow NULL vehicle_id — proforma-approval auto-creates tickets before a vehicle is assigned
pgExec(`ALTER TABLE vi_installations ALTER COLUMN vehicle_id DROP NOT NULL`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_vi_inst_vehicle ON vi_installations(vehicle_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_vi_inst_customer ON vi_installations(customer_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_vi_inst_technician ON vi_installations(assigned_technician_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_vi_inst_status ON vi_installations(status)`).catch(() => {});

pgExec(`
  CREATE TABLE IF NOT EXISTS vi_gadgets (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    device_type TEXT NOT NULL,
    device_model TEXT,
    imei_enc TEXT,
    sim_number_enc TEXT,
    serial_number TEXT,
    activation_status TEXT NOT NULL DEFAULT 'Inactive',
    installation_status TEXT NOT NULL DEFAULT 'Pending',
    assigned_by_user_id TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`).catch(e => console.error("[vi_gadgets] init:", e));
pgExec(`CREATE INDEX IF NOT EXISTS idx_vi_gadgets_inst ON vi_gadgets(installation_id)`).catch(() => {});

pgExec(`
  CREATE TABLE IF NOT EXISTS vi_inspections (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    technician_id TEXT,
    technician_notes TEXT,
    customer_confirmed_at TEXT,
    customer_confirmed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`).catch(e => console.error("[vi_inspections] init:", e));
pgExec(`CREATE INDEX IF NOT EXISTS idx_vi_inspections_inst ON vi_inspections(installation_id)`).catch(() => {});

pgExec(`
  CREATE TABLE IF NOT EXISTS vi_photos (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    photo_type TEXT NOT NULL,
    label TEXT,
    data_url TEXT NOT NULL,
    uploaded_by_user_id TEXT,
    uploaded_at TEXT NOT NULL
  )
`).catch(e => console.error("[vi_photos] init:", e));
pgExec(`CREATE INDEX IF NOT EXISTS idx_vi_photos_inst ON vi_photos(installation_id)`).catch(() => {});

pgExec(`
  CREATE TABLE IF NOT EXISTS vi_stages (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    stage INTEGER NOT NULL,
    stage_name TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    technician_id TEXT,
    notes TEXT
  )
`).catch(e => console.error("[vi_stages] init:", e));
pgExec(`CREATE INDEX IF NOT EXISTS idx_vi_stages_inst ON vi_stages(installation_id)`).catch(() => {});

pgExec(`
  CREATE TABLE IF NOT EXISTS vi_otp (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    otp_hash TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'SMS',
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT,
    created_at TEXT NOT NULL
  )
`).catch(e => console.error("[vi_otp] init:", e));
pgExec(`CREATE INDEX IF NOT EXISTS idx_vi_otp_inst ON vi_otp(installation_id)`).catch(() => {});

// ── Constants ─────────────────────────────────────────────────────────────────
const STAGE_NAMES = [
  "Unassigned",             // 0 = not started / not assigned yet
  "Vehicle Inspection",     // 1
  "Device Assignment",      // 2
  "Tracker Installation",   // 3
  "Sensor Installation",    // 4
  "Device Testing",         // 5
  "Customer Verification",  // 6
  "Installation Complete",  // 7
];

const CHECKLIST_ITEMS = [
  "Battery condition",
  "Dashboard warning lights",
  "Ignition functionality",
  "Headlights",
  "Brake lights",
  "Indicators",
  "Power windows",
  "Central locking",
  "Radio system",
  "Alarm system",
  "OBD port condition",
];

const REQUIRED_PHOTO_TYPES = [
  { type: "front", label: "Front of vehicle" },
  { type: "rear", label: "Rear of vehicle" },
  { type: "left", label: "Left side" },
  { type: "right", label: "Right side" },
  { type: "interior", label: "Interior cabin" },
  { type: "dashboard", label: "Dashboard" },
  { type: "vin_plate", label: "VIN plate" },
  { type: "engine_bay", label: "Engine bay" },
  { type: "device_location", label: "Device installation location" },
  { type: "device_wide", label: "Wide shot of installed device area" },
];

// resolveTechnicianIdSet now lives in ../middleware/rbac.ts (imported above)
// — this file, device-custody.ts, and inventory-sims.ts all duplicated this
// exact roster-ID-resolution query before it was consolidated there.

// ── ABAC helper: does the user own this installation? ─────────────────────────
async function assertAccess(
  instId: string,
  user: { id: string; role: string },
  res: any
): Promise<any | null> {
  const inst = await pgGet(
    "SELECT * FROM vi_installations WHERE id = ? AND deleted_at IS NULL",
    [instId]
  );
  if (!inst) {
    errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
    return null;
  }
  if (user.role === "Technician") {
    const techIds = await resolveTechnicianIdSet(user.id);
    if (!techIds.has(inst.assigned_technician_id)) {
      errorResponse(res, 403, "FORBIDDEN", "Not assigned to this installation.");
      return null;
    }
  }
  // InstallOffice has full access like Technical
  return inst;
}

// ── Map row → safe response (mask PII by role) ────────────────────────────────
function mapInst(row: any, role: string, full = false) {
  const canSeePii = ["Admin", "Technical", "InstallOffice", ...SALES_ROLES].includes(role);
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    customerId: row.customer_id,
    ticketRef: row.ticket_ref,
    assignedTechnicianId: row.assigned_technician_id,
    assignedTechnicianEmail: row.assigned_technician_email,
    assignedAt: row.assigned_at,
    status: row.status,
    stage: row.stage,
    stageName: STAGE_NAMES[row.stage] || "Unknown",
    fuelType: row.fuel_type,
    dashboardConfig: row.dashboard_config_json
      ? JSON.parse(row.dashboard_config_json)
      : null,
    electricalNotes: row.electrical_notes,
    postInstallNotes: row.post_install_notes,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // PII – decrypted only for privileged roles
    ...(full && canSeePii
      ? {
          vin: decryptField(row.vin_enc),
          engineNumber: decryptField(row.engine_number_enc),
        }
      : {
          vin: canSeePii ? decryptField(row.vin_enc) : maskValue(decryptField(row.vin_enc)),
          engineNumber: canSeePii
            ? decryptField(row.engine_number_enc)
            : maskValue(decryptField(row.engine_number_enc)),
        }),
  };
}

function mapGadget(g: any, role: string) {
  const canSeePii = ["Admin", "Technical", "Technician", "InstallOffice"].includes(role);
  return {
    id: g.id,
    installationId: g.installation_id,
    deviceType: g.device_type,
    deviceModel: g.device_model,
    serialNumber: g.serial_number,
    activationStatus: g.activation_status,
    installationStatus: g.installation_status,
    notes: g.notes,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
    imei: canSeePii ? decryptField(g.imei_enc) : maskValue(decryptField(g.imei_enc)),
    simNumber: canSeePii ? decryptField(g.sim_number_enc) : maskValue(decryptField(g.sim_number_enc)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── CREATE Installation ────────────────────────────────────────────────────────
router.post(
  "/",
  requireAuth,
  requireRole(["Admin", ...SALES_ROLES, "Technical", "InstallOffice"]),
  async (req: AuthRequest, res) => {
    const { vehicleId, customerId, ticketRef } = req.body;
    if (!vehicleId || !customerId) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "vehicleId and customerId are required.");
    }

    // Verify vehicle exists and belongs to customer
    const vehicle = await pgGet(
      "SELECT * FROM crm_customer_vehicles WHERE id = ? AND customer_id = ? AND deleted_at IS NULL",
      [vehicleId, customerId]
    );
    if (!vehicle) {
      return errorResponse(res, 404, "NOT_FOUND", "Vehicle not found for this customer.");
    }

    // Check for active duplicate
    const existing = await pgGet(
      "SELECT id FROM vi_installations WHERE vehicle_id = ? AND status NOT IN ('Completed','Cancelled') AND deleted_at IS NULL",
      [vehicleId]
    );
    if (existing) {
      return errorResponse(
        res, 409, "CONFLICT",
        "An active installation already exists for this vehicle.",
      );
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    await pgRun(
      `INSERT INTO vi_installations
         (id, vehicle_id, customer_id, ticket_ref, status, stage, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Pending', 0, ?, ?, ?)`,
      [id, vehicleId, customerId, ticketRef || null, req.user!.id, now, now]
    );

    auditLog(req, "VI_INSTALLATION_CREATED", `vi_installation:${id}`, "Info", {
      vehicleId, customerId, ticketRef, registration: vehicle.registration,
    }).catch(console.error);

    const row = await pgGet("SELECT * FROM vi_installations WHERE id = ?", [id]);
    return created(res, mapInst(row, req.user!.role), "Installation created.");
  }
);

// ── LIST Installations ─────────────────────────────────────────────────────────
router.get(
  "/",
  requireAuth,
  requireRole(["Admin", ...SALES_ROLES, "Technical", "Technician", "InstallOffice", "Finance"]),
  async (req: AuthRequest, res) => {
    const { customerId, status, technicianId, page = "1", pageSize = "50" } = req.query as any;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
    const offset = (pageNum - 1) * sizeNum;

    const filters: string[] = ["i.deleted_at IS NULL"];
    const params: any[] = [];

    if (customerId) { filters.push("i.customer_id = ?"); params.push(customerId); }
    if (status) { filters.push("i.status = ?"); params.push(status); }
    if (technicianId) { filters.push("i.assigned_technician_id = ?"); params.push(technicianId); }

    // ABAC: Technicians see only their own assigned jobs.
    if (req.user!.role === "Technician") {
      const ids = [...(await resolveTechnicianIdSet(req.user!.id))];
      if (ids.length === 1) {
        filters.push("i.assigned_technician_id = ?");
        params.push(ids[0]);
      } else {
        filters.push(`i.assigned_technician_id IN (${ids.map(() => "?").join(", ")})`);
        params.push(...ids);
      }
    }

    const where = `WHERE ${filters.join(" AND ")}`;
    const rows = await pgAll(
      `SELECT i.*, v.registration, v.make, v.model, v.color,
              c.account_no, ind.full_name, corp.company_name,
              COALESCE(te.full_name, tu.name) AS technician_display_name
       FROM vi_installations i
       LEFT JOIN crm_customer_vehicles v ON v.id = i.vehicle_id
       JOIN crm_customers c ON c.id = i.customer_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
       LEFT JOIN users tu ON tu.id = i.assigned_technician_id
       LEFT JOIN hr_employees te ON te.id = i.assigned_technician_id
       ${where}
       ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
      [...params, sizeNum, offset]
    );
    const totalRow = await pgGet(
      `SELECT COUNT(*) as total FROM vi_installations i ${where}`,
      params
    );

    auditLog(req, "VI_LIST_VIEWED", "vi_installations", "Info", { customerId, status }).catch(console.error);

    return ok(res, {
      data: rows.map(r => ({
        ...mapInst(r, req.user!.role),
        registration: r.registration,
        vehicleMake: r.make,
        vehicleModel: r.model,
        vehicleColor: r.color,
        accountNo: r.account_no,
        customerName: r.full_name || r.company_name || "—",
        technicianName: r.technician_display_name || null,
      })),
      meta: { total: Number(totalRow?.total ?? 0) },
    });
  }
);

// ── GET by Vehicle ID ─────────────────────────────────────────────────────────
router.get(
  "/by-vehicle/:vehicleId",
  requireAuth,
  requireRole(["Admin", ...SALES_ROLES, "Technical", "Technician", "InstallOffice", "Finance"]),
  async (req: AuthRequest, res) => {
    const rows = await pgAll(
      `SELECT i.*, v.registration, v.make, v.model, v.year_of_manufacture, v.color,
              c.account_no, ind.full_name, corp.company_name
       FROM vi_installations i
       LEFT JOIN crm_customer_vehicles v ON v.id = i.vehicle_id
       JOIN crm_customers c ON c.id = i.customer_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
       WHERE i.vehicle_id = ? AND i.deleted_at IS NULL
       ORDER BY i.created_at DESC`,
      [req.params.vehicleId]
    );
    auditLog(req, "VI_VEHICLE_VIEW", `vehicle:${req.params.vehicleId}`, "Info", {}).catch(console.error);
    return ok(res, rows.map(r => ({
      ...mapInst(r, req.user!.role),
      registration: r.registration, vehicleMake: r.make, vehicleModel: r.model,
      vehicleYear: r.year_of_manufacture, vehicleColor: r.color,
      accountNo: r.account_no, customerName: r.full_name || r.company_name || "—",
    })));
  }
);

// ── GET Full Installation Detail ───────────────────────────────────────────────
router.get(
  "/:id",
  requireAuth,
  requireRole(["Admin", ...SALES_ROLES, "Technical", "Technician", "InstallOffice", "Finance"]),
  async (req: AuthRequest, res) => {
    const inst = await pgGet(
      `SELECT i.*,
              v.registration, v.make, v.model, v.year_of_manufacture, v.color,
              v.body_type, v.model_number, v.loan_tenure_months, v.loan_start_date,
              c.id as cust_id, c.account_no, c.type as cust_type,
              c.account_manager_id,
              ind.full_name, ind.phone_enc, ind.email_enc,
              corp.company_name,
              u.name as technician_name, u.email as tech_email
       FROM vi_installations i
       LEFT JOIN crm_customer_vehicles v ON v.id = i.vehicle_id
       JOIN crm_customers c ON c.id = i.customer_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
       LEFT JOIN users u ON u.id = i.assigned_technician_id
       WHERE i.id = ? AND i.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!inst) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");

    // ABAC: Technician can only see their own.
    if (req.user!.role === "Technician") {
      const techIds = await resolveTechnicianIdSet(req.user!.id);
      if (!techIds.has(inst.assigned_technician_id)) {
        return errorResponse(res, 403, "FORBIDDEN", "Not assigned to this installation.");
      }
    }

    const canSeePii = ["Admin", "Technical", ...SALES_ROLES].includes(req.user!.role);
    const phone = decryptField(inst.phone_enc);
    const email = decryptField(inst.email_enc);

    // Load related data in parallel
    const [gadgets, inspections, photos, stages] = await Promise.all([
      pgAll("SELECT * FROM vi_gadgets WHERE installation_id = ? ORDER BY created_at", [inst.id]),
      pgAll("SELECT * FROM vi_inspections WHERE installation_id = ? ORDER BY created_at", [inst.id]),
      pgAll("SELECT id, photo_type, label, uploaded_at, uploaded_by_user_id FROM vi_photos WHERE installation_id = ? ORDER BY uploaded_at", [inst.id]),
      pgAll("SELECT * FROM vi_stages WHERE installation_id = ? ORDER BY stage", [inst.id]),
    ]);

    auditLog(req, "VI_DETAIL_VIEWED", `vi_installation:${inst.id}`, "Info", {
      vehicleId: inst.vehicle_id, role: req.user!.role,
    }).catch(console.error);

    return ok(res, {
      installation: {
        ...mapInst(inst, req.user!.role, true),
        vehicle: {
          id: inst.vehicle_id,
          registration: inst.registration,
          make: inst.make,
          model: inst.model,
          modelNumber: inst.model_number,
          bodyType: inst.body_type,
          year: inst.year_of_manufacture,
          color: inst.color,
          loanTenureMonths: inst.loan_tenure_months ?? null,
          loanStartDate: inst.loan_start_date ?? null,
        },
        customer: {
          id: inst.cust_id,
          accountNo: inst.account_no,
          type: inst.cust_type,
          name: inst.full_name || inst.company_name || "—",
          phone: canSeePii ? phone : maskValue(phone),
          email: canSeePii ? email : maskValue(email),
        },
        technician: inst.assigned_technician_id
          ? {
              id: inst.assigned_technician_id,
              name: inst.technician_name || "—",
              email: inst.tech_email || inst.assigned_technician_email,
              assignedAt: inst.assigned_at,
            }
          : null,
      },
      gadgets: gadgets.map(g => mapGadget(g, req.user!.role)),
      inspections: inspections.map(i => ({
        id: i.id,
        type: i.type,
        items: JSON.parse(i.items_json || "[]"),
        technicianId: i.technician_id,
        technicianNotes: i.technician_notes,
        customerConfirmedAt: i.customer_confirmed_at,
        createdAt: i.created_at,
      })),
      photos: photos.map(p => ({ id: p.id, type: p.photo_type, label: p.label, uploadedAt: p.uploaded_at })),
      requiredPhotoTypes: REQUIRED_PHOTO_TYPES,
      stages: stages.map(s => ({ stage: s.stage, name: STAGE_NAMES[s.stage], completedAt: s.completed_at, notes: s.notes })),
      stageNames: STAGE_NAMES.slice(1),
      checklistItems: CHECKLIST_ITEMS,
    });
  }
);

// ── ASSIGN Technician ──────────────────────────────────────────────────────────
router.patch(
  "/:id/assign",
  requireAuth,
  requireRole(ROLE_GROUPS.TICKET_MANAGEMENT),
  async (req: AuthRequest, res) => {
    const { technicianId, assignedAt } = req.body;
    if (!technicianId) return errorResponse(res, 400, "VALIDATION_ERROR", "technicianId required.");

    // Accept either a system user ID or an HR employee ID
    let techEmail: string | null = null;
    const userRow = await pgGet("SELECT * FROM users WHERE id = ? AND status = 'Active'", [technicianId]);
    if (userRow && ["Technician", "Technical", "Admin"].includes(userRow.role)) {
      techEmail = userRow.email;
    } else {
      // Fall back: check hr_employees (technicians without user accounts)
      const hrRow = await pgGet("SELECT * FROM hr_employees WHERE id = ?", [technicianId]);
      if (!hrRow) return errorResponse(res, 404, "NOT_FOUND", "Technician not found.");
      techEmail = hrRow.work_email || hrRow.email || null;
    }

    const inst = await pgGet("SELECT * FROM vi_installations WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!inst) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
    const now = new Date().toISOString();
    await pgRun(
      `UPDATE vi_installations SET assigned_technician_id = ?, assigned_technician_email = ?, assigned_at = ?, status = 'Assigned', updated_at = ? WHERE id = ?`,
      [technicianId, techEmail, assignedAt || now, now, inst.id]
    );
    auditLog(req, "VI_TECHNICIAN_ASSIGNED", `vi_installation:${inst.id}`, "Info", {
      technicianId, techEmail,
    }).catch(console.error);

    // ── SMS notification to the assigned technician ─────────────────────────
    if (isSmsConfigured()) {
      try {
        // Look up technician phone from roster
        const rosterRow = await pgGet(
          `SELECT phone FROM technical_team_roster
           WHERE user_account_id = ? OR hr_employee_id = ? OR id = ?
           LIMIT 1`,
          [technicianId, technicianId, technicianId]
        );
        const techPhone = rosterRow?.phone || null;
        if (techPhone) {
          // Look up vehicle registration + install location from installation ticket
          const itRow = await pgGet(
            `SELECT vehicle_registration, installation_location
             FROM installation_tickets
             WHERE vi_installation_id = ? AND deleted_at IS NULL
             LIMIT 1`,
            [inst.id]
          );
          const reg      = itRow?.vehicle_registration || inst.ticket_ref || "";
          const rawLoc   = itRow?.installation_location || "";
          const location = rawLoc.length > 35 ? rawLoc.slice(0, 32) + "…" : rawLoc;
          const ticketRef = inst.ticket_ref || inst.id.slice(0, 8).toUpperCase();

          // Build message ≤ 150 chars
          const msgParts = [`FM: Job ${ticketRef} assigned.`];
          if (reg)      msgParts.push(`Vehicle: ${reg}.`);
          if (location) msgParts.push(`Location: ${location}.`);
          msgParts.push("Log in to Finemark portal.");
          const smsBody = msgParts.join(" ").slice(0, 150);

          sendSms([techPhone], smsBody).catch(e =>
            console.error("[assign] SMS to technician failed:", e)
          );
        }
      } catch (e) {
        console.error("[assign] SMS lookup failed:", e);
      }
    }

    // ── Bell notification to the assigned technician ─────────────────────────
    await createNotification({
      targetUserId: technicianId,
      type: "info",
      title: `New Job Assigned: ${inst.ticket_ref || inst.id.slice(0, 8).toUpperCase()}`,
      body: `You have been assigned a new installation job. Please review and start when ready.`,
      link: `technician-jobs.html`,
    }).catch(console.error);

    // ── Email notification to the assigned technician ─────────────────────────
    if (isGraphConfigured() && techEmail) {
      const ticketLabel = inst.ticket_ref || inst.id.slice(0, 8).toUpperCase();
      const subject = `[Finemark] New Job Assigned — ${ticketLabel}`;
      const htmlBody = `
        <p>Hello,</p>
        <p>You have been assigned a new installation job on the Finemark portal.</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Ticket</td><td>${ticketLabel}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Assigned by</td><td>${req.user!.email}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:600">Scheduled at</td><td>${assignedAt || "As soon as possible"}</td></tr>
        </table>
        <p>Log in to the portal to view your job card and begin the installation workflow.</p>
        ${process.env.DEV_NOTIFY_EMAIL ? "<p style=\"color:orange;font-style:italic\">[DEV MODE — original recipient: " + techEmail + "]</p>" : ""}
      `;
      sendEmailViaGraph({
        fromMailbox: MAILBOXES.notification,
        to: notifyEmail(techEmail),
        subject,
        htmlBody,
      }).catch(e => console.error("[assign] email technician:", e));
    }

    const updated = await pgGet("SELECT * FROM vi_installations WHERE id = ?", [inst.id]);
    return ok(res, mapInst(updated, req.user!.role), "Technician assigned.");
  }
);

// ── UPDATE Vehicle Technical Data (Technician fills this in) ──────────────────
router.patch(
  "/:id/vehicle-technical",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const { vin, engineNumber, fuelType, dashboardConfig, electricalNotes } = req.body;
    const now = new Date().toISOString();
    await pgRun(
      `UPDATE vi_installations SET
         vin_enc = COALESCE(?, vin_enc),
         engine_number_enc = COALESCE(?, engine_number_enc),
         fuel_type = COALESCE(?, fuel_type),
         dashboard_config_json = COALESCE(?, dashboard_config_json),
         electrical_notes = COALESCE(?, electrical_notes),
         updated_at = ?
       WHERE id = ?`,
      [
        vin ? encryptField(vin) : null,
        engineNumber ? encryptField(engineNumber) : null,
        fuelType || null,
        dashboardConfig ? JSON.stringify(dashboardConfig) : null,
        electricalNotes || null,
        now, inst.id,
      ]
    );
    auditLog(req, "VI_TECHNICAL_UPDATED", `vi_installation:${inst.id}`, "Info", {
      fieldsUpdated: Object.keys(req.body),
    }).catch(console.error);
    const updated = await pgGet("SELECT * FROM vi_installations WHERE id = ?", [inst.id]);
    return ok(res, mapInst(updated, req.user!.role, true), "Technical data updated.");
  }
);

// ── GADGETS ────────────────────────────────────────────────────────────────────
router.get(
  "/:id/gadgets",
  requireAuth,
  requireRole(["Admin", ...SALES_ROLES, "Technical", "Technician", "InstallOffice", "Finance"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const rows = await pgAll("SELECT * FROM vi_gadgets WHERE installation_id = ? ORDER BY created_at", [inst.id]);
    return ok(res, rows.map(g => mapGadget(g, req.user!.role)));
  }
);

router.post(
  "/:id/gadgets",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const { deviceType, deviceModel, imei, simNumber, serialNumber, notes } = req.body;
    if (!deviceType) return errorResponse(res, 400, "VALIDATION_ERROR", "deviceType is required.");
    const id = uuidv4();
    const now = new Date().toISOString();
    await pgRun(
      `INSERT INTO vi_gadgets
         (id, installation_id, device_type, device_model, imei_enc, sim_number_enc, serial_number, activation_status, installation_status, assigned_by_user_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Inactive', 'Pending', ?, ?, ?, ?)`,
      [
        id, inst.id, deviceType, deviceModel || null,
        imei ? encryptField(imei) : null,
        simNumber ? encryptField(simNumber) : null,
        serialNumber || null,
        req.user!.id, notes || null, now, now,
      ]
    );
    auditLog(req, "VI_GADGET_ASSIGNED", `vi_installation:${inst.id}`, "Info", {
      gadgetId: id, deviceType, deviceModel,
      imei: imei ? maskValue(imei) : null,
    }).catch(console.error);
    const row = await pgGet("SELECT * FROM vi_gadgets WHERE id = ?", [id]);
    return created(res, mapGadget(row, req.user!.role), "Gadget assigned.");
  }
);

router.patch(
  "/:id/gadgets/:gid",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const gadget = await pgGet("SELECT * FROM vi_gadgets WHERE id = ? AND installation_id = ?", [req.params.gid, inst.id]);
    if (!gadget) return errorResponse(res, 404, "NOT_FOUND", "Gadget not found.");
    const { activationStatus, installationStatus, notes, imei, simNumber, serialNumber } = req.body;
    const now = new Date().toISOString();
    await pgRun(
      `UPDATE vi_gadgets SET
         activation_status = COALESCE(?, activation_status),
         installation_status = COALESCE(?, installation_status),
         notes = COALESCE(?, notes),
         imei_enc = COALESCE(?, imei_enc),
         sim_number_enc = COALESCE(?, sim_number_enc),
         serial_number = COALESCE(?, serial_number),
         updated_at = ?
       WHERE id = ?`,
      [
        activationStatus || null, installationStatus || null, notes || null,
        imei ? encryptField(imei) : null,
        simNumber ? encryptField(simNumber) : null,
        serialNumber || null, now, gadget.id,
      ]
    );
    auditLog(req, "VI_GADGET_UPDATED", `vi_gadget:${gadget.id}`, "Info", {
      installationId: inst.id, changes: Object.keys(req.body),
    }).catch(console.error);
    const updated = await pgGet("SELECT * FROM vi_gadgets WHERE id = ?", [gadget.id]);
    return ok(res, mapGadget(updated, req.user!.role), "Gadget updated.");
  }
);

router.delete(
  "/:id/gadgets/:gid",
  requireAuth,
  requireRole(ROLE_GROUPS.TICKET_MANAGEMENT),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const gadget = await pgGet("SELECT id FROM vi_gadgets WHERE id = ? AND installation_id = ?", [req.params.gid, inst.id]);
    if (!gadget) return errorResponse(res, 404, "NOT_FOUND", "Gadget not found.");
    await pgRun("DELETE FROM vi_gadgets WHERE id = ?", [gadget.id]);
    auditLog(req, "VI_GADGET_REMOVED", `vi_gadget:${gadget.id}`, "Warning", { installationId: inst.id }).catch(console.error);
    return ok(res, null, "Gadget removed.");
  }
);

// ── INSPECTIONS ────────────────────────────────────────────────────────────────
router.get(
  "/:id/inspections",
  requireAuth,
  requireRole(["Admin", ...SALES_ROLES, "Technical", "Technician", "InstallOffice", "Finance"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const rows = await pgAll(
      "SELECT * FROM vi_inspections WHERE installation_id = ? ORDER BY created_at",
      [inst.id]
    );
    return ok(res, rows.map(r => ({
      id: r.id, type: r.type,
      items: JSON.parse(r.items_json || "[]"),
      technicianId: r.technician_id, technicianNotes: r.technician_notes,
      customerConfirmedAt: r.customer_confirmed_at,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })));
  }
);

router.post(
  "/:id/inspections",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const { type, items, technicianNotes } = req.body;
    if (!type || !["pre", "post"].includes(type)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "type must be 'pre' or 'post'.");
    }
    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "items checklist array is required.");
    }
    const id = uuidv4();
    const now = new Date().toISOString();
    await pgRun(
      `INSERT INTO vi_inspections
         (id, installation_id, type, items_json, technician_id, technician_notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, inst.id, type, JSON.stringify(items), req.user!.id, technicianNotes || null, now, now]
    );
    auditLog(req, `VI_INSPECTION_${type.toUpperCase()}_SUBMITTED`, `vi_installation:${inst.id}`, "Info", {
      inspectionId: id, itemCount: items.length,
    }).catch(console.error);
    const row = await pgGet("SELECT * FROM vi_inspections WHERE id = ?", [id]);
    return created(res, {
      id: row.id, type: row.type,
      items: JSON.parse(row.items_json || "[]"),
      technicianNotes: row.technician_notes,
      createdAt: row.created_at,
    }, `${type} inspection submitted.`);
  }
);

// Customer confirms inspection (signed off)
router.post(
  "/:id/inspections/:iid/confirm",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const insp = await pgGet("SELECT * FROM vi_inspections WHERE id = ? AND installation_id = ?", [req.params.iid, inst.id]);
    if (!insp) return errorResponse(res, 404, "NOT_FOUND", "Inspection not found.");
    const now = new Date().toISOString();
    await pgRun(
      "UPDATE vi_inspections SET customer_confirmed_at = ?, customer_confirmed_by = ?, updated_at = ? WHERE id = ?",
      [now, req.body.confirmedBy || "Customer", now, insp.id]
    );
    auditLog(req, "VI_INSPECTION_CUSTOMER_CONFIRMED", `vi_inspection:${insp.id}`, "Info", {
      installationId: inst.id, type: insp.type,
    }).catch(console.error);
    return ok(res, null, "Customer confirmation recorded.");
  }
);

// ── PHOTOS ─────────────────────────────────────────────────────────────────────
router.post(
  "/:id/photos",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const { photos } = req.body; // array of { type, label, dataUrl }
    if (!Array.isArray(photos) || photos.length === 0) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "photos array required.");
    }
    const now = new Date().toISOString();
    const inserted: string[] = [];
    for (const p of photos) {
      if (!p.type || !p.dataUrl) continue;
      const id = uuidv4();
      await pgRun(
        `INSERT INTO vi_photos (id, installation_id, photo_type, label, data_url, uploaded_by_user_id, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, inst.id, p.type, p.label || p.type, p.dataUrl, req.user!.id, now]
      );
      inserted.push(p.type);
    }
    auditLog(req, "VI_PHOTOS_UPLOADED", `vi_installation:${inst.id}`, "Info", {
      count: inserted.length, types: inserted,
    }).catch(console.error);
    return created(res, { uploaded: inserted.length }, `${inserted.length} photo(s) uploaded.`);
  }
);

router.get(
  "/:id/photos",
  requireAuth,
  requireRole(["Admin", ...SALES_ROLES, "Technical", "Technician", "InstallOffice", "Finance"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const { withData } = req.query;
    const cols = withData === "1"
      ? "id, photo_type, label, data_url, uploaded_at, uploaded_by_user_id"
      : "id, photo_type, label, uploaded_at, uploaded_by_user_id";
    const rows = await pgAll(
      `SELECT ${cols} FROM vi_photos WHERE installation_id = ? ORDER BY uploaded_at`,
      [inst.id]
    );
    auditLog(req, "VI_PHOTOS_VIEWED", `vi_installation:${inst.id}`, "Info", {}).catch(console.error);
    return ok(res, rows.map(p => ({
      id: p.id, type: p.photo_type, label: p.label,
      uploadedAt: p.uploaded_at,
      ...(withData === "1" ? { dataUrl: p.data_url } : {}),
    })));
  }
);

// ── STAGE PROGRESSION ─────────────────────────────────────────────────────────
router.post(
  "/:id/stage",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const { stage, notes } = req.body;
    const nextStage = typeof stage === "number" ? stage : inst.stage + 1;
    if (nextStage < 1 || nextStage > 7) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Stage must be 1–7.");
    }
    if (nextStage !== inst.stage + 1 && req.user!.role !== "Admin") {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Stages must be completed in order.");
    }

    // Business rules
    if (nextStage === 5) {
      // Device Testing: need at least one gadget
      const gadgets = await pgGet("SELECT COUNT(*) as n FROM vi_gadgets WHERE installation_id = ?", [inst.id]);
      if (Number(gadgets?.n ?? 0) === 0) {
        return errorResponse(res, 400, "PRECONDITION_FAILED", "Assign at least one device before testing.");
      }
    }
    if (nextStage === 6) {
      // Customer Verification: need at least 10 photos
      const photoCount = await pgGet("SELECT COUNT(*) as n FROM vi_photos WHERE installation_id = ?", [inst.id]);
      if (Number(photoCount?.n ?? 0) < 10) {
        return errorResponse(res, 400, "PRECONDITION_FAILED", `${10 - Number(photoCount?.n ?? 0)} more photo(s) required before customer verification.`);
      }
    }

    const now = new Date().toISOString();
    const stageId = uuidv4();
    await pgRun(
      `INSERT INTO vi_stages (id, installation_id, stage, stage_name, completed_at, technician_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [stageId, inst.id, nextStage, STAGE_NAMES[nextStage], now, req.user!.id, notes || null]
    );

    const newStatus = nextStage === 7 ? "Completed" : "InProgress";
    await pgRun(
      "UPDATE vi_installations SET stage = ?, status = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      [nextStage, newStatus, now, nextStage === 7 ? now : inst.completed_at, inst.id]
    );

    auditLog(req, "VI_STAGE_COMPLETED", `vi_installation:${inst.id}`, "Info", {
      stage: nextStage, stageName: STAGE_NAMES[nextStage],
    }).catch(console.error);

    return ok(res, { stage: nextStage, stageName: STAGE_NAMES[nextStage], status: newStatus }, `Stage ${nextStage}: ${STAGE_NAMES[nextStage]} completed.`);
  }
);

// ── OTP: Request ──────────────────────────────────────────────────────────────
router.post(
  "/:id/otp/request",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;

    // Look up customer phone
    const customer = await pgGet(
      `SELECT ind.phone_enc, ind.full_name, corp.company_name
       FROM crm_customers c
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
       WHERE c.id = ?`,
      [inst.customer_id]
    );

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = hashRefreshToken(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // Invalidate prior OTPs
    await pgRun(
      "UPDATE vi_otp SET verified_at = ? WHERE installation_id = ? AND verified_at IS NULL",
      [now, inst.id]
    );

    await pgRun(
      `INSERT INTO vi_otp (id, installation_id, otp_hash, channel, expires_at, attempts, created_at)
       VALUES (?, ?, ?, 'SMS', ?, 0, ?)`,
      [uuidv4(), inst.id, otpHash, expiresAt, now]
    );

    // Attempt SMS delivery
    let smsSent = false;
    const phone = decryptField(customer?.phone_enc);
    if (phone) {
      try {
        const customerName = customer.full_name || customer.company_name || "Customer";
        await sendSms(
          [phone],
          `Finemark Installation OTP: ${otp}\nPlease share this code with the technician to confirm your vehicle installation.\nExpires in 10 minutes.`
        );
        smsSent = true;
      } catch (e) {
        console.error("[VI OTP] SMS failed:", e);
      }
    }

    auditLog(req, "VI_OTP_REQUESTED", `vi_installation:${inst.id}`, "Info", { smsSent }).catch(console.error);

    const response: any = { message: "OTP sent to customer.", data: { expiresAt, smsSent } };
    // Expose OTP in non-prod for testing
    if (process.env.NODE_ENV !== "production") response.data.devOtp = otp;
    return res.status(200).json(response);
  }
);

// ── OTP: Verify ───────────────────────────────────────────────────────────────
router.post(
  "/:id/otp/verify",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await assertAccess(req.params.id, req.user!, res);
    if (!inst) return;
    const { otp } = req.body;
    if (!otp) return errorResponse(res, 400, "VALIDATION_ERROR", "otp is required.");

    const otpRow = await pgGet(
      "SELECT * FROM vi_otp WHERE installation_id = ? AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [inst.id]
    );
    if (!otpRow) return errorResponse(res, 404, "NOT_FOUND", "No active OTP found. Request a new OTP.");
    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      return errorResponse(res, 401, "UNAUTHORIZED", "OTP has expired. Please request a new one.");
    }
    if (otpRow.attempts >= 5) {
      return errorResponse(res, 429, "TOO_MANY_ATTEMPTS", "Too many failed attempts. Request a new OTP.");
    }

    const hash = hashRefreshToken(String(otp));
    const attempts = otpRow.attempts + 1;
    if (otpRow.otp_hash !== hash) {
      await pgRun("UPDATE vi_otp SET attempts = ? WHERE id = ?", [attempts, otpRow.id]);
      return errorResponse(res, 401, "UNAUTHORIZED", `Invalid OTP. ${5 - attempts} attempt(s) remaining.`);
    }

    const now = new Date().toISOString();
    await pgRun("UPDATE vi_otp SET verified_at = ?, attempts = ? WHERE id = ?", [now, attempts, otpRow.id]);

    // Auto-advance stage to Customer Verification complete if on stage 6
    if (inst.stage === 6) {
      const stageId = uuidv4();
      await pgRun(
        `INSERT INTO vi_stages (id, installation_id, stage, stage_name, completed_at, technician_id, notes)
         VALUES (?, ?, 6, 'Customer Verification', ?, ?, 'Customer confirmed via OTP')`,
        [stageId, inst.id, now, req.user!.id]
      );
      await pgRun(
        "UPDATE vi_installations SET stage = 6, updated_at = ? WHERE id = ?",
        [now, inst.id]
      );
    }

    auditLog(req, "VI_OTP_VERIFIED", `vi_installation:${inst.id}`, "Info", {
      technicianId: req.user!.id, otpId: otpRow.id, verifiedAt: now,
    }).catch(console.error);

    return ok(res, { verified: true, verifiedAt: now }, "OTP verified. Customer confirmation recorded.");
  }
);

// ── CANCEL Installation ────────────────────────────────────────────────────────
router.patch(
  "/:id/cancel",
  requireAuth,
  requireRole(["Admin", ...SALES_ROLES]),
  async (req: AuthRequest, res) => {
    const inst = await pgGet("SELECT * FROM vi_installations WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!inst) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
    if (inst.status === "Completed") {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Cannot cancel a completed installation.");
    }
    const now = new Date().toISOString();
    await pgRun("UPDATE vi_installations SET status = 'Cancelled', updated_at = ? WHERE id = ?", [now, inst.id]);
    auditLog(req, "VI_INSTALLATION_CANCELLED", `vi_installation:${inst.id}`, "Warning", {
      reason: req.body.reason || "No reason provided",
    }).catch(console.error);
    return ok(res, null, "Installation cancelled.");
  }
);

// ── ACCEPT Installation (Technician confirms the job) ──────────────────────────
router.post(
  "/:id/accept",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await pgGet("SELECT * FROM vi_installations WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!inst) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
    if (!["Pending", "Assigned"].includes(inst.status)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", `Cannot accept an installation in '${inst.status}' status.`);
    }
    // Technician must be the assigned one (unless Admin or InstallOffice/Technical supervisors)
    const isSupervisor = ["Admin", "Technical", "InstallOffice"].includes(req.user!.role);
    if (!isSupervisor) {
      const techIds = await resolveTechnicianIdSet(req.user!.id);
      if (!techIds.has(inst.assigned_technician_id)) {
        return errorResponse(res, 403, "FORBIDDEN", "You are not assigned to this installation.");
      }
    }
    const now = new Date().toISOString();
    await pgRun(
      `UPDATE vi_installations SET status = 'In Progress', updated_at = ? WHERE id = ?`,
      [now, inst.id]
    );
    auditLog(req, "VI_INSTALLATION_ACCEPTED", `vi_installation:${inst.id}`, "Info", {}).catch(console.error);
    return ok(res, null, "Installation accepted — status set to In Progress.");
  }
);

// ── REJECT Installation (Technician rejects, triggers reassignment) ────────────
router.post(
  "/:id/reject",
  requireAuth,
  requireRole([...ROLE_GROUPS.TICKET_MANAGEMENT, "Technician"]),
  async (req: AuthRequest, res) => {
    const inst = await pgGet("SELECT * FROM vi_installations WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!inst) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
    if (!["Pending", "Assigned"].includes(inst.status)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", `Cannot reject an installation in '${inst.status}' status.`);
    }
    if (req.user!.role !== "Admin") {
      const techIds = await resolveTechnicianIdSet(req.user!.id);
      if (!techIds.has(inst.assigned_technician_id)) {
        return errorResponse(res, 403, "FORBIDDEN", "You are not assigned to this installation.");
      }
    }
    const { reason } = req.body;
    if (!reason) return errorResponse(res, 400, "MISSING_FIELD", "Rejection reason is required.");

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE vi_installations
       SET status = 'Pending', assigned_technician_id = NULL, assigned_technician_email = NULL,
           assigned_at = NULL, post_install_notes = ?, updated_at = ?
       WHERE id = ?`,
      [`REJECTED: ${reason}`, now, inst.id]
    );
    auditLog(req, "VI_INSTALLATION_REJECTED", `vi_installation:${inst.id}`, "Warning", { reason }).catch(console.error);
    return ok(res, null, "Installation rejected — returned to Pending for reassignment.");
  }
);

// ── GENERATE Certificate from Completed Installation ──────────────────────────
router.post(
  "/:id/generate-certificate",
  requireAuth,
  requireRole(["Admin", "Technical", ...SALES_ROLES, "InstallOffice"]),
  async (req: AuthRequest, res) => {
    const inst = await pgGet(
      `SELECT i.*, v.registration, v.make, v.model, v.color,
              ind.full_name, ind.phone_enc,
              corp.company_name
       FROM vi_installations i
       LEFT JOIN crm_customer_vehicles v ON v.id = i.vehicle_id
       JOIN crm_customers c ON c.id = i.customer_id
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
       LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
       WHERE i.id = ? AND i.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!inst) return errorResponse(res, 404, "NOT_FOUND", "Installation not found.");
    if (inst.status !== "Completed") {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Certificate can only be generated for completed installations.");
    }

    const {
      serialNo, systemType, date, startDate, endDate, loanDurationYears, pdfBase64,
      imei1: bodyImei1, imei2: bodyImei2, trackerNo1: bodyTracker1, trackerNo2: bodyTracker2,
    } = req.body;

    if (!serialNo || !systemType || !date || !startDate || !endDate || !loanDurationYears || !pdfBase64) {
      return errorResponse(res, 400, "VALIDATION_ERROR",
        "serialNo, systemType, date, startDate, endDate, loanDurationYears and pdfBase64 are required.");
    }

    // Load gadgets for IMEI and serial numbers
    const gadgets = await pgAll(
      "SELECT * FROM vi_gadgets WHERE installation_id = ? ORDER BY created_at",
      [inst.id]
    );

    const phone       = decryptField(inst.phone_enc) || "";
    const customerName = inst.full_name || inst.company_name || "—";
    const registration = (inst.registration || "").replace(/\s+/g, '').toUpperCase();
    const vehicleModel = `${inst.make || ""} ${inst.model || ""}`.trim();
    const color        = inst.color || "";

    // Prefer gadget values; fall back to whatever was sent from the form
    const imei1     = (gadgets[0] ? decryptField(gadgets[0].imei_enc) : null) || bodyImei1 || "";
    const imei2     = (gadgets[1] ? decryptField(gadgets[1].imei_enc) : null) || bodyImei2 || null;
    const trackerNo1 = gadgets[0]?.serial_number || bodyTracker1 || "";
    const trackerNo2 = gadgets[1]?.serial_number || bodyTracker2 || null;

    if (!imei1 || !trackerNo1) {
      return errorResponse(res, 400, "VALIDATION_ERROR",
        "At least one device with IMEI and tracker/serial number is required. Assign a device to this installation first.");
    }

    const id  = uuidv4();
    const now = new Date().toISOString();
    try {
      await pgRun(
        `INSERT INTO certificates
           (id, serial_no, system_type, car_registration, model, date, name, color, phone,
            start_date, end_date, loan_duration_years, imei_1, imei_2, tracker_no_1, tracker_no_2,
            pdf_base64, created_by_user_id, created_by_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, serialNo.toUpperCase(), systemType, registration, vehicleModel, date,
         customerName, color, phone, startDate, endDate, Number(loanDurationYears),
         imei1, imei2 || null, trackerNo1, trackerNo2 || null,
         pdfBase64, req.user!.id, req.user!.email, now, now]
      );
    } catch (err: any) {
      if (err?.code === "23505" || String(err?.message).includes("UNIQUE")) {
        return errorResponse(res, 409, "CONFLICT", "A certificate with that serial number already exists.");
      }
      return errorResponse(res, 500, "INTERNAL", "Failed to create certificate.");
    }

    auditLog(req, "CERTIFICATE_GENERATED_FROM_INSTALLATION", `vi_installation:${inst.id}`, "Info", {
      certificateId: id, serialNo, registration,
    }).catch(console.error);

    return created(res,
      { certificateId: id, serialNo: serialNo.toUpperCase(), registration, customerName },
      "Certificate generated successfully."
    );
  }
);


// ── GET Certificate for Installation ─────────────────────────────────────────
router.get(
  '/:id/certificate',
  requireAuth,
  requireRole(['Admin','Technical',...SALES_ROLES,'Technician','Finance']),
  async (req, res) => {
    const inst = await pgGet(
      `SELECT i.id, v.registration
       FROM vi_installations i
       LEFT JOIN crm_customer_vehicles v ON v.id = i.vehicle_id
       WHERE i.id = ? AND i.deleted_at IS NULL`,
      [req.params.id]
    );
    const cert = await pgGet(
      `SELECT id, serial_no, system_type, car_registration, model, date, name, color, phone,
              start_date, end_date, loan_duration_years, imei_1, imei_2, tracker_no_1, tracker_no_2,
              pdf_base64, created_at
       FROM certificates
       WHERE car_registration = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [inst.registration]
    );
    return ok(res, cert);
  }
);

export default router;

