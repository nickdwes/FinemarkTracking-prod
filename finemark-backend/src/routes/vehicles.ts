import { Router } from "express";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS, buildCustomerOwnershipFilter } from "../middleware/rbac.js";
import { ok, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { isValidKeRegistration } from "../utils/validators.js";

const router = Router();

// Harmonize a (newly-entered) vehicle registration onto the denormalized copies the
// Retail Leads list and installation pipeline read — a vehicle first captured as
// "Not Registered" (chassis only) otherwise keeps showing its chassis after the plate
// is added. Matched by vehicle_id; no-op when no plate is supplied.
async function syncRegistrationToLeadAndTicket(vehicleId: string, rawReg: any): Promise<void> {
  if (!rawReg || !String(rawReg).trim()) return;
  const reg = String(rawReg).replace(/\s+/g, "").toUpperCase();
  const now = new Date().toISOString();
  await pgRun(`UPDATE retail_lead_vehicles SET registration = ?, registration_known = TRUE WHERE vehicle_id = ?`, [reg, vehicleId]).catch(() => {});
  await pgRun(`UPDATE installation_tickets SET vehicle_registration = ?, updated_at = ? WHERE vehicle_id = ? AND deleted_at IS NULL`, [reg, now, vehicleId]).catch(() => {});
}

const ALL_ROLES = ["Admin", "Sales", "Telesales", "FieldSales", "Support", "Finance", "Operations", "BDM", "BDMCorporate", "Technical", "Technician", "InstallOffice", "KAM", "CorporateSales", "CertAdmin", "Executive", "InventoryManager", "HR"];
// CorporateSales/KAM/Telesales were previously missing here — only the legacy
// "Sales" string and BDM/BDMCorporate could create/edit vehicles, silently
// blocking anyone whose account already carries the canonical role name.
// CertAdmin added so certificate generation (create-certificate.html) can sync
// corrected vehicle details (make/model/body type/chassis/engine) back to the
// vehicle record it's certifying — previously missing, so a CertAdmin-only
// account would 403 on that sync even though CERT_ACCESS already lets them
// generate the certificate itself.
const WRITE_ROLES = ["Admin", "Sales", "Operations", "BDM", "BDMCorporate", "CorporateSales", "KAM", "Telesales", "Technical", "InstallOffice", "CertAdmin"];
const OVERRIDE_ROLES: string[] = [...ROLE_GROUPS.ADMIN_ONLY]; // can override duplicate blocks
const ADMIN_ROLES: string[] = [...ROLE_GROUPS.ADMIN_ONLY];

// ── Vehicle change-request workflow ─────────────────────────────────────────
// Once a vehicle is installed (has a Completed vi_installation), edits by
// non-admins are NOT applied directly — they are captured as a pending change
// request for an admin to review and approve, preserving the integrity of the
// data behind an issued installation / certificate.
pgRun(`
  CREATE TABLE IF NOT EXISTS vehicle_change_requests (
    id                    TEXT PRIMARY KEY,
    vehicle_id            TEXT NOT NULL,
    customer_id           TEXT,
    registration          TEXT,
    changes_json          TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'Pending',
    requested_by_user_id  TEXT,
    requested_by_email    TEXT,
    requested_at          TEXT NOT NULL,
    reviewed_by_user_id   TEXT,
    reviewed_by_email     TEXT,
    reviewed_at           TEXT,
    review_notes          TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  )
`, []).catch((e) => console.error("[vehicle_change_requests] init:", e));
// Where the edit came from — lets the vehicle Timeline distinguish a manual
// Vehicle 360 edit from one synced automatically during certificate generation.
pgRun(`ALTER TABLE vehicle_change_requests ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_vcr_status  ON vehicle_change_requests(status)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_vcr_vehicle ON vehicle_change_requests(vehicle_id)`, []).catch(() => {});

/** A vehicle is "installed" (and thus change-gated) once it has a Completed installation. */
async function isVehicleInstalled(vehicleId: string): Promise<boolean> {
  const row = await pgGet(
    "SELECT 1 FROM vi_installations WHERE vehicle_id = ? AND status = 'Completed' AND deleted_at IS NULL LIMIT 1",
    [vehicleId],
  );
  return !!row;
}

// buildCustomerOwnershipFilter now lives in ../middleware/rbac.ts — this file
// had crm-customers.ts's exact same ABAC filter duplicated (applied here via
// the vehicle's linked crm_customers row, aliased `c`, already LEFT JOINed by
// every caller below); both now share one copy instead.
const buildVehicleAbacFilter = buildCustomerOwnershipFilter;

// Registration format validation now lives in ../utils/validators.ts
// (isValidKeRegistration) — shared with the frontend and category-aware
// (tractors/tuktuks/special equipment get a looser check than standard
// motor vehicles, since they often aren't NTSA-plated the same way).
// No VIN/chassis format regex — real-world chassis numbers on older or
// non-standard vehicles don't always fit the strict 17-character ISO 3779
// shape, same relaxation already applied to the leads/cert/job-card modules.

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildVehicleListQuery(params: {
  search?: string;
  customerId?: string;
  partnerId?: string;
  status?: string;
  make?: string;
  yearFrom?: string;
  yearTo?: string;
  hasDevice?: string;
  ticketStatus?: string;
  page: number;
  pageSize: number;
  abac?: { clause: string; params: any[] };
}) {
  const { search, customerId, partnerId, status, make, yearFrom, yearTo, hasDevice, ticketStatus, page, pageSize, abac } = params;
  const where: string[] = ["v.deleted_at IS NULL"];
  const vals: any[] = [];
  let i = 1;

  if (abac?.clause) {
    // Renumber the abac clause's own "?" placeholders onto this query's
    // shared $N counter, in order, so it composes with every other filter
    // below rather than colliding with their numbering.
    const renumbered = abac.clause.replace(/\?/g, () => `$${i++}`);
    where.push(renumbered);
    vals.push(...abac.params);
  }
  if (search) {
    where.push(`(v.registration ILIKE $${i} OR v.make ILIKE $${i} OR v.model ILIKE $${i} OR v.vehicle_no ILIKE $${i} OR v.chassis_number ILIKE $${i})`);
    vals.push(`%${search}%`); i++;
  }
  if (customerId) { where.push(`v.customer_id = $${i}`); vals.push(customerId); i++; }
  if (partnerId)  { where.push(`v.partner_id = $${i}`);  vals.push(partnerId); i++; }
  if (make)       { where.push(`v.make ILIKE $${i}`);    vals.push(`%${make}%`); i++; }
  if (yearFrom)   { where.push(`v.year_of_manufacture >= $${i}`); vals.push(Number(yearFrom)); i++; }
  if (yearTo)     { where.push(`v.year_of_manufacture <= $${i}`); vals.push(Number(yearTo)); i++; }
  if (status)     { where.push(`v.status = $${i}`); vals.push(status); i++; }
  if (hasDevice === "true") {
    where.push(`EXISTS (SELECT 1 FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL AND it.status = 'Completed')`);
  } else if (hasDevice === "false") {
    where.push(`NOT EXISTS (SELECT 1 FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL AND it.status = 'Completed')`);
  }
  if (ticketStatus) {
    where.push(`EXISTS (SELECT 1 FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL AND it.status = $${i})`);
    vals.push(ticketStatus); i++;
  }

  const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";
  const offset = (page - 1) * pageSize;

  const dataQuery = `
    SELECT
      v.id, v.registration, v.registration_known, v.make, v.model, v.model_number, v.body_type, v.color,
      v.year_of_manufacture, v.chassis_number, v.engine_number, v.vehicle_no,
      v.customer_id, v.partner_id, v.loan_tenure_months, v.loan_start_date,
      v.notes, v.created_at, v.updated_at,
      c.account_no AS customer_account_no, c.type AS customer_type, c.segment AS customer_segment, c.status AS customer_status, c.region AS customer_region,
      COALESCE(ind.full_name, corp.company_name) AS customer_name,
      p.name AS partner_name, p.tier AS partner_tier, p.regions AS partner_regions,
      (SELECT COUNT(*)::int FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL) AS ticket_count,
      (SELECT COUNT(*)::int FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL AND it.status = 'Completed') AS completed_ticket_count,
      (SELECT COUNT(*)::int FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL AND it.status NOT IN ('Completed','Cancelled')) AS open_ticket_count,
      (SELECT it.ticket_no FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL ORDER BY it.created_at::timestamptz DESC LIMIT 1) AS latest_ticket_no,
      (SELECT it.status FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL ORDER BY it.created_at::timestamptz DESC LIMIT 1) AS latest_ticket_status,
      (SELECT it.assigned_to_email FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL ORDER BY it.created_at::timestamptz DESC LIMIT 1) AS latest_technician_email,
      (SELECT it.stage FROM installation_tickets it WHERE it.vehicle_id = v.id AND it.deleted_at IS NULL ORDER BY it.created_at::timestamptz DESC LIMIT 1) AS latest_ticket_stage,
      (SELECT cert.id FROM certificates cert WHERE cert.car_registration = v.registration AND cert.deleted_at IS NULL ORDER BY cert.created_at DESC LIMIT 1) AS certificate_id
    FROM crm_customer_vehicles v
    LEFT JOIN crm_customers c ON c.id = v.customer_id
    LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
    LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
    LEFT JOIN partners p ON p.id = v.partner_id
    ${whereClause}
    ORDER BY v.created_at DESC
    LIMIT $${i} OFFSET $${i+1}`;

  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM crm_customer_vehicles v
    LEFT JOIN crm_customers c ON c.id = v.customer_id
    LEFT JOIN partners p ON p.id = v.partner_id
    ${whereClause}`;

  vals.push(pageSize, offset);
  return { dataQuery, countQuery, vals: vals.slice(0, -2), countVals: vals.slice(0, -2), dataVals: vals };
}

// ── GET /check-duplicate ───────────────────────────────────────────────────────
// Real-time duplicate check: ?registration=&vin=&engine=&excludeId=
router.get("/check-duplicate", requireAuth, requireRole(ALL_ROLES), async (req: AuthRequest, res) => {
  const { registration, vin, engine, excludeId } = req.query as Record<string, string>;
  const result: Record<string, { isDuplicate: boolean; existingId?: string; existingRef?: string }> = {};

  if (registration) {
    const row = await pgGet(
      `SELECT id, registration, vehicle_no FROM crm_customer_vehicles WHERE UPPER(TRIM(registration)) = UPPER(TRIM(?)) AND deleted_at IS NULL${excludeId ? " AND id != ?" : ""}`,
      excludeId ? [registration, excludeId] : [registration]
    );
    result.registration = { isDuplicate: !!row, existingId: row?.id, existingRef: row?.registration };
  }
  if (vin) {
    const row = await pgGet(
      `SELECT id, registration FROM crm_customer_vehicles WHERE UPPER(TRIM(chassis_number)) = UPPER(TRIM(?)) AND deleted_at IS NULL${excludeId ? " AND id != ?" : ""}`,
      excludeId ? [vin, excludeId] : [vin]
    );
    result.vin = { isDuplicate: !!row, existingId: row?.id, existingRef: row?.registration };
  }
  if (engine) {
    const row = await pgGet(
      `SELECT id, registration FROM crm_customer_vehicles WHERE UPPER(TRIM(engine_number)) = UPPER(TRIM(?)) AND deleted_at IS NULL${excludeId ? " AND id != ?" : ""}`,
      excludeId ? [engine, excludeId] : [engine]
    );
    result.engine = { isDuplicate: !!row, existingId: row?.id, existingRef: row?.registration };
  }

  return ok(res, result);
});

// ── POST / ────────────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole(WRITE_ROLES), async (req: AuthRequest, res) => {
  const {
    registration, registrationKnown, make, model, model_number, body_type, color,
    year_of_manufacture, chassis_number, engine_number, vehicle_no,
    customer_id, partner_id, loan_tenure_months, loan_start_date, notes,
    overrideDuplicate, lead_id, vehicle_category,
  } = req.body as Record<string, any>;

  // registrationKnown defaults true (undefined = "not specified" from an older
  // caller that predates this field) so existing integrations keep requiring
  // a registration exactly as before; explicitly false is the new "not yet
  // registered" path, requiring a chassis number instead.
  const isRegistered = registrationKnown !== false;

  // ── Format validation ──────────────────────────────────────────────────────
  if (isRegistered) {
    if (!registration) return errorResponse(res, 400, "VALIDATION_ERROR", "Registration number is required.");
    if (!isValidKeRegistration(registration, vehicle_category)) {
      await auditLog(req, "VEHICLE_REG_FORMAT_INVALID", `reg:${registration}`, "Warning", { registration }).catch(console.error);
      return errorResponse(res, 400, "INVALID_FORMAT", "Invalid Kenyan registration number format. Please enter a valid plate number.");
    }
  } else if (!chassis_number) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Chassis / VIN number is required for a vehicle that isn't registered yet.");
  }

  // Bank financing: a partner/financier and a loan tenure always go together.
  // Enforcing this here (not just on the form) is what closes the data gap that
  // leaves installed gadgets with no partner bank on reports.
  const hasPartner = !!(partner_id && String(partner_id).trim());
  const hasTenure = Number(loan_tenure_months) > 0;
  if (hasPartner && !hasTenure) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "A loan tenure (months) is required when a partner / financier is selected.");
  }
  if (hasTenure && !hasPartner) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "A partner / financier is required when a loan tenure is entered.");
  }
  // No format/length check on chassis_number — real-world chassis numbers on
  // older or non-standard vehicles don't always fit the strict 17-character
  // ISO 3779 shape (same relaxation already applied to the leads and job card
  // modules), so free text is accepted here too.

  // ── Duplicate checks ───────────────────────────────────────────────────────
  const [dupReg, dupVin, dupEngine] = await Promise.all([
    isRegistered ? pgGet("SELECT id, registration FROM crm_customer_vehicles WHERE UPPER(TRIM(registration)) = UPPER(TRIM(?)) AND deleted_at IS NULL", [registration]) : Promise.resolve(null),
    chassis_number ? pgGet("SELECT id, registration FROM crm_customer_vehicles WHERE UPPER(TRIM(chassis_number)) = UPPER(TRIM(?)) AND deleted_at IS NULL", [chassis_number]) : Promise.resolve(null),
    engine_number  ? pgGet("SELECT id, registration FROM crm_customer_vehicles WHERE UPPER(TRIM(engine_number)) = UPPER(TRIM(?)) AND deleted_at IS NULL",  [engine_number])  : Promise.resolve(null),
  ]);

  const duplicates: any[] = [];
  if (dupReg)    duplicates.push({ field: "registration",   existingId: dupReg.id,    existingRef: dupReg.registration });
  if (dupVin)    duplicates.push({ field: "chassis_number", existingId: dupVin.id,    existingRef: dupVin.registration });
  if (dupEngine) duplicates.push({ field: "engine_number",  existingId: dupEngine.id, existingRef: dupEngine.registration });

  if (duplicates.length > 0) {
    const isAdmin = OVERRIDE_ROLES.includes(req.user?.role ?? "");
    if (!overrideDuplicate || !isAdmin) {
      await auditLog(req, "VEHICLE_DUPLICATE_BLOCKED", `reg:${registration}`, "Warning", { registration, duplicates, attemptedOverride: !!overrideDuplicate }).catch(console.error);
      return errorResponse(res, 409, "DUPLICATE_VEHICLE", "A vehicle with these details already exists.", { duplicates, canOverride: isAdmin });
    }
    // Admin override — log it
    await auditLog(req, "VEHICLE_DUPLICATE_OVERRIDE", `reg:${registration}`, "Warning", { registration, duplicates }).catch(console.error);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await pgRun(
    `INSERT INTO crm_customer_vehicles
      (id, registration, registration_known, make, model, model_number, body_type, color,
       year_of_manufacture, chassis_number, engine_number, vehicle_no,
       customer_id, partner_id, loan_tenure_months, loan_start_date, notes, lead_id, vehicle_category,
       created_by_user_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, isRegistered ? registration.trim().toUpperCase() : null, isRegistered,
     make||null, model||null, model_number||null,
     body_type||null, color||null, year_of_manufacture ? Number(year_of_manufacture) : null,
     chassis_number ? chassis_number.trim().toUpperCase() : null,
     engine_number  ? engine_number.trim().toUpperCase()  : null,
     vehicle_no||null, customer_id||null, partner_id||null,
     loan_tenure_months ? Number(loan_tenure_months) : null, loan_start_date||null,
     notes||null, lead_id||null, vehicle_category||"motor_vehicle", req.user?.id || null, now, now]
  );

  await auditLog(req, "VEHICLE_CREATED", `vehicle:${id}`, "Info", { id, registration: isRegistered ? registration.trim().toUpperCase() : null }).catch(console.error);
  const created = await pgGet("SELECT * FROM crm_customer_vehicles WHERE id = ?", [id]);
  return ok(res, created, "Vehicle registered successfully.");
});

// ── GET /stats ─────────────────────────────────────────────────────────────────
router.get("/stats", requireAuth, requireRole(ALL_ROLES), async (req: AuthRequest, res) => {
  const [
    totals,
    byMake,
    byCustomerType,
    byPartner,
    byRegion,
    monthlyReg,
    monthlyInstall,
    ticketSummary,
  ] = await Promise.all([
    pgGet(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(CASE WHEN v.deleted_at IS NULL THEN 1 END)::int AS active,
        COUNT(CASE WHEN EXISTS(SELECT 1 FROM installation_tickets it WHERE it.vehicle_id=v.id AND it.status='Completed' AND it.deleted_at IS NULL) THEN 1 END)::int AS with_device,
        COUNT(CASE WHEN NOT EXISTS(SELECT 1 FROM installation_tickets it WHERE it.vehicle_id=v.id AND it.deleted_at IS NULL) THEN 1 END)::int AS pending_installation,
        COUNT(CASE WHEN EXISTS(SELECT 1 FROM installation_tickets it WHERE it.vehicle_id=v.id AND it.status NOT IN ('Completed','Cancelled') AND it.deleted_at IS NULL) THEN 1 END)::int AS with_open_tickets,
        COUNT(CASE WHEN EXISTS(SELECT 1 FROM certificates cert WHERE cert.car_registration=v.registration AND cert.deleted_at IS NULL) THEN 1 END)::int AS with_certificate
      FROM crm_customer_vehicles v WHERE v.deleted_at IS NULL`),

    pgAll(`SELECT make, COUNT(*)::int AS n FROM crm_customer_vehicles WHERE deleted_at IS NULL AND make IS NOT NULL GROUP BY make ORDER BY n DESC LIMIT 10`),

    pgAll(`SELECT COALESCE(c.type,'Unknown') AS type, COUNT(*)::int AS n FROM crm_customer_vehicles v LEFT JOIN crm_customers c ON c.id=v.customer_id WHERE v.deleted_at IS NULL GROUP BY c.type ORDER BY n DESC`),

    pgAll(`SELECT p.name AS partner, COUNT(*)::int AS n FROM crm_customer_vehicles v LEFT JOIN partners p ON p.id=v.partner_id WHERE v.deleted_at IS NULL GROUP BY p.name ORDER BY n DESC LIMIT 10`),

    pgAll(`SELECT COALESCE(c.region,'Unknown') AS region, COUNT(*)::int AS n FROM crm_customer_vehicles v LEFT JOIN crm_customers c ON c.id=v.customer_id WHERE v.deleted_at IS NULL GROUP BY c.region ORDER BY n DESC LIMIT 10`),

    pgAll(`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') AS month, DATE_TRUNC('month', created_at) AS month_dt, COUNT(*)::int AS n FROM crm_customer_vehicles WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '12 months' GROUP BY month_dt ORDER BY month_dt ASC`),

    pgAll(`SELECT TO_CHAR(DATE_TRUNC('month', created_at::timestamptz), 'Mon YYYY') AS month, DATE_TRUNC('month', created_at::timestamptz) AS month_dt, COUNT(*)::int AS n FROM installation_tickets WHERE deleted_at IS NULL AND status='Completed' AND created_at::timestamptz >= NOW() - INTERVAL '12 months' GROUP BY month_dt ORDER BY month_dt ASC`),

    pgGet(`SELECT COUNT(*)::int AS total, COUNT(CASE WHEN status='Completed' THEN 1 END)::int AS completed, COUNT(CASE WHEN status NOT IN ('Completed','Cancelled') THEN 1 END)::int AS open FROM installation_tickets WHERE deleted_at IS NULL`),
  ]);

  return ok(res, { totals, byMake, byCustomerType, byPartner, byRegion, monthlyReg, monthlyInstall, ticketSummary });
});

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(ALL_ROLES), async (req: AuthRequest, res) => {
  const page     = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 25));
  const { search, customerId, partnerId, status, make, yearFrom, yearTo, hasDevice, ticketStatus } = req.query as Record<string, string>;

  const { dataQuery, countQuery, dataVals, countVals } = buildVehicleListQuery({
    search, customerId, partnerId, status, make, yearFrom, yearTo, hasDevice, ticketStatus, page, pageSize,
    abac: buildVehicleAbacFilter(req.user!),
  });

  // Run count and data queries (count uses same filters without LIMIT/OFFSET)
  const countValsForQuery = dataVals.slice(0, dataVals.length - 2);
  const [countRow, rows] = await Promise.all([
    pgGet(countQuery, countValsForQuery),
    pgAll(dataQuery, dataVals),
  ]);

  return ok(res, {
    data: rows,
    pagination: { page, pageSize, total: countRow?.total ?? 0 },
  });
});

// GET /vehicles/change-requests?status=Pending — admin review queue.
// Declared before "/:id" so the literal path isn't captured as an :id param.
router.get("/change-requests", requireAuth, requireRole(ADMIN_ROLES), async (req: AuthRequest, res) => {
  const status = (req.query.status as string) || "Pending";
  const rows = await pgAll(
    `SELECT r.*, v.make, v.model, v.registration AS vehicle_registration
     FROM vehicle_change_requests r
     LEFT JOIN crm_customer_vehicles v ON v.id = r.vehicle_id
     WHERE r.status = ? ORDER BY r.requested_at DESC LIMIT 500`,
    [status],
  );
  const data = rows.map((r: any) => ({
    id: r.id, vehicleId: r.vehicle_id, customerId: r.customer_id,
    registration: r.registration || r.vehicle_registration || null, make: r.make, model: r.model,
    changes: JSON.parse(r.changes_json || "{}"),
    status: r.status, requestedBy: r.requested_by_email, requestedAt: r.requested_at,
    reviewedBy: r.reviewed_by_email, reviewedAt: r.reviewed_at, reviewNotes: r.review_notes,
  }));
  return ok(res, data);
});

// ── GET /:id ─ Vehicle 360 ────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole(ALL_ROLES), async (req: AuthRequest, res) => {
  const { id } = req.params;
  const abac = buildVehicleAbacFilter(req.user!);

  const vehicle = await pgGet(
    `SELECT v.*,
      c.account_no AS customer_account_no, c.type AS customer_type, c.segment AS customer_segment, c.status AS customer_status, c.region AS customer_region,
      p.name AS partner_name, p.tier AS partner_tier, p.contact_email AS partner_email, p.contact_phone AS partner_phone
     FROM crm_customer_vehicles v
     LEFT JOIN crm_customers c ON c.id = v.customer_id
     LEFT JOIN partners p ON p.id = v.partner_id
     WHERE v.id = ? AND v.deleted_at IS NULL ${abac.clause ? `AND ${abac.clause}` : ""}`,
    [id, ...abac.params]
  );
  // Deliberately 404 (not 403) for an out-of-scope vehicle, same as
  // crm-customers.ts — avoids confirming the record exists to a caller who
  // isn't allowed to see it.
  if (!vehicle) return errorResponse(res, 404, "NOT_FOUND", "Vehicle not found.");

  const [tickets, viInstallations, certificates, contacts, devices, changeRequests] = await Promise.all([
    pgAll(
      `SELECT id, ticket_no, status, stage, assigned_to_email, assigned_at, created_at, updated_at,
              devices_json, activation_json, technician_signed_off_at, engineer_signed_off_at,
              sla_start_hours, sla_ack_hours, sla_signoff_hours, sla_iso_hours,
              sla_acknowledged_by_at, sla_signed_off_by_at, sla_iso_closed_by_at,
              arrived_at, installation_location, installation_location_lat, installation_location_lng,
              checkin_json, vehicle_details_json, co_technician_name
       FROM installation_tickets
       WHERE vehicle_id = ? AND deleted_at IS NULL
       ORDER BY created_at::timestamptz DESC`,
      [id]
    ),

    pgAll(
      `SELECT id, ticket_ref, status, stage, assigned_technician_email, assigned_at, completed_at, created_at, fuel_type
       FROM vi_installations
       WHERE vehicle_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [id]
    ),

    pgAll(
      `SELECT id, serial_no, system_type, start_date, end_date, name, phone, imei_1, imei_2, tracker_no_1, tracker_no_2, created_at,
              is_extension, extension_no, root_cert_id, extended_from_cert_id, prior_start_date, prior_end_date, extended_at
       FROM certificates
       WHERE car_registration = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [vehicle.registration]
    ),

    vehicle.customer_id
      ? pgAll(
          `SELECT id, contact_type, first_name, last_name, email, phone, is_primary
           FROM crm_customer_contacts
           WHERE customer_id = ? AND deleted_at IS NULL
           ORDER BY is_primary DESC, created_at ASC`,
          [vehicle.customer_id]
        ).catch(() => [])
      : Promise.resolve([]),

    // Actual installed devices — sourced from inv_items linked to this vehicle's
    // tickets via installation_id, not the tickets' devices_json (which only
    // records the requested category/quantity before assignment) or
    // activation_json (whose shape changed to a per-device map for multi-device
    // jobs and no longer matches a single flat {imei, iccid} object).
    pgAll(
      `SELECT i.id, i.serial_number, i.imei, i.sim_phone, i.status AS device_status,
              p.device_model, p.product_name,
              s.iccid AS sim_iccid, s.msisdn,
              t.id AS ticket_id, t.ticket_no, t.status AS ticket_status,
              COALESCE(t.arrived_at, t.created_at) AS install_date
       FROM inv_items i
       JOIN installation_tickets t ON t.id = i.installation_id
       LEFT JOIN inv_product_catalog p ON p.id = i.product_id
       LEFT JOIN inv_sims s ON s.device_item_id = i.id
       WHERE t.vehicle_id = ? AND i.deleted_at IS NULL AND t.deleted_at IS NULL
       ORDER BY i.created_at DESC`,
      [id]
    ).catch(() => []),

    // Full edit history for this vehicle — Applied (no approval needed),
    // Pending/Approved/Rejected (installed-vehicle gate) — surfaced on the
    // vehicle Timeline. Any authenticated viewer of this vehicle can see it
    // (unlike GET /audit-logs, which is Admin-only).
    pgAll(
      `SELECT id, changes_json, status, requested_by_email, requested_at,
              reviewed_by_email, reviewed_at, review_notes, source
       FROM vehicle_change_requests
       WHERE vehicle_id = ?
       ORDER BY requested_at DESC
       LIMIT 100`,
      [id]
    ).catch(() => []),
  ]);

  return ok(res, {
    vehicle, tickets, viInstallations, certificates, contacts, devices,
    changeRequests: (changeRequests as any[]).map((r) => ({
      id: r.id, changes: JSON.parse(r.changes_json || "{}"), status: r.status,
      requestedByEmail: r.requested_by_email, requestedAt: r.requested_at,
      reviewedByEmail: r.reviewed_by_email, reviewedAt: r.reviewed_at,
      reviewNotes: r.review_notes, source: r.source || "manual",
    })),
  });
});

// ── PATCH /:id ─────────────────────────────────────────────────────────────────
router.patch("/:id", requireAuth, requireRole(WRITE_ROLES), async (req: AuthRequest, res) => {
  const { id } = req.params;
  const row: any = await pgGet("SELECT * FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Vehicle not found.");

  const allowed = ["make", "model", "model_number", "body_type", "color", "year_of_manufacture",
                   "chassis_number", "engine_number", "vehicle_no", "notes", "loan_tenure_months",
                   "loan_start_date", "partner_id", "status", "vin", "fuel_type", "transmission",
                   "odometer", "insurance_details", "insurance_expiry", "ntsa_status", "fleet_number",
                   "asset_code", "trim", "registration", "registration_known"];
  const updates: string[] = [];
  const vals: any[] = [];
  const changed: Record<string, any> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      vals.push(req.body[key]);
      changed[key] = req.body[key];
    }
  }
  // Switching to not-registered clears any stale registration value instead
  // of leaving it sitting there — same rule the job card's mirror-back uses.
  if (req.body.registration_known === false && req.body.registration === undefined) {
    updates.push("registration = ?"); vals.push(null); changed["registration"] = null;
  }
  if (req.body.registration) {
    if (!isValidKeRegistration(req.body.registration, row.vehicle_category)) {
      return errorResponse(res, 400, "INVALID_FORMAT", "Invalid Kenyan registration number format. Please enter a valid plate number.");
    }
    // A caller supplying a real registration without also sending
    // registration_known (e.g. the generic Vehicle 360 edit form, which has
    // no separate toggle) clearly means "this vehicle is registered now" —
    // infer the flag rather than leaving it stuck at whatever it was before.
    if (req.body.registration_known === undefined) {
      updates.push("registration_known = ?"); vals.push(true); changed["registration_known"] = true;
    }
  }
  if (!updates.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No updatable fields provided.");

  // ── Change gate ───────────────────────────────────────────────────────────
  // Once a vehicle is installed, only admins may edit it directly. Everyone
  // else's edits are captured as a pending change request for admin review, so
  // the record behind an issued installation/certificate can't be silently
  // altered.
  const isAdmin = ADMIN_ROLES.includes(req.user!.role) ||
    (req.user!.effectiveRole ? ADMIN_ROLES.includes(req.user!.effectiveRole) : false);
  // Normalize + diff up front — both branches below need it: the gated branch
  // to decide/record what's pending, the immediate-apply branch to log what
  // was actually changed (so the vehicle Timeline has a real before/after,
  // not just a list of touched column names).
  const norm = (v: any) => (v === undefined || v === "" ? null : v);
  const diff: Record<string, { from: any; to: any }> = {};
  for (const [key, to] of Object.entries(changed)) {
    if (String(norm(row[key])) !== String(norm(to))) diff[key] = { from: norm(row[key]), to: norm(to) };
  }
  const source = typeof req.body?.source === "string" && req.body.source.trim() ? req.body.source.trim() : "manual";

  if (!isAdmin && await isVehicleInstalled(id)) {
    if (!Object.keys(diff).length) return ok(res, { pendingApproval: false, noChange: true }, "No changes to submit.");
    const now = new Date().toISOString();
    const reqId = crypto.randomUUID();
    await pgRun(
      `INSERT INTO vehicle_change_requests
         (id, vehicle_id, customer_id, registration, changes_json, status,
          requested_by_user_id, requested_by_email, requested_at, created_at, updated_at, source)
       VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?, ?)`,
      [reqId, id, row.customer_id || null, row.registration || null, JSON.stringify(diff),
       req.user!.id, req.user!.email || null, now, now, now, source],
    );
    auditLog(req, "VEHICLE_CHANGE_REQUESTED", `vehicle:${id}`, "Warning",
      { requestId: reqId, fields: Object.keys(diff), source }).catch(console.error);
    return ok(res, { pendingApproval: true, requestId: reqId },
      "This vehicle is installed — your changes were submitted for admin approval.");
  }

  const now = new Date().toISOString();
  updates.push("updated_at = ?"); vals.push(now);
  vals.push(id);
  await pgRun(`UPDATE crm_customer_vehicles SET ${updates.join(", ")} WHERE id = ?`, vals);
  if (changed.registration) await syncRegistrationToLeadAndTicket(id, changed.registration);
  // Record every applied edit in vehicle_change_requests too (status='Applied',
  // reviewed=requested — no approval was needed), not just the ones an
  // installed vehicle's gate queues as Pending. This makes the table a
  // complete history the vehicle Timeline can render regardless of whether an
  // edit went straight through or needed sign-off.
  if (Object.keys(diff).length) {
    const reqId = crypto.randomUUID();
    await pgRun(
      `INSERT INTO vehicle_change_requests
         (id, vehicle_id, customer_id, registration, changes_json, status,
          requested_by_user_id, requested_by_email, requested_at,
          reviewed_by_user_id, reviewed_by_email, reviewed_at,
          created_at, updated_at, source)
       VALUES (?, ?, ?, ?, ?, 'Applied', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reqId, id, row.customer_id || null, row.registration || null, JSON.stringify(diff),
       req.user!.id, req.user!.email || null, now, req.user!.id, req.user!.email || null, now, now, now, source],
    ).catch((e) => console.error("[vehicle_change_requests] applied-log insert:", e));
  }
  auditLog(req, "VEHICLE_UPDATED", `vehicle:${id}`, "Info", { updates: updates.slice(0, -1), changes: diff, source }).catch(console.error);
  const updated = await pgGet("SELECT * FROM crm_customer_vehicles WHERE id = ?", [id]);
  return ok(res, updated, "Vehicle updated.");
});

// ── Change-request review (admin only) ──────────────────────────────────────
const VCR_APPLYABLE = new Set(["make", "model", "model_number", "body_type", "color",
  "year_of_manufacture", "chassis_number", "engine_number", "vehicle_no", "notes",
  "loan_tenure_months", "loan_start_date", "partner_id", "status", "vin", "fuel_type",
  "transmission", "odometer", "insurance_details", "insurance_expiry", "ntsa_status",
  "fleet_number", "asset_code", "trim", "registration", "registration_known"]);

/** POST /vehicles/change-requests/:id/approve — apply the requested changes. */
router.post("/change-requests/:id/approve", requireAuth, requireRole(ADMIN_ROLES), async (req: AuthRequest, res) => {
  const reqRow: any = await pgGet("SELECT * FROM vehicle_change_requests WHERE id = ?", [req.params.id]);
  if (!reqRow) return errorResponse(res, 404, "NOT_FOUND", "Change request not found.");
  if (reqRow.status !== "Pending") return errorResponse(res, 409, "ALREADY_REVIEWED", `This request was already ${String(reqRow.status).toLowerCase()}.`);
  const vehicle = await pgGet("SELECT id FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL", [reqRow.vehicle_id]);
  if (!vehicle) return errorResponse(res, 404, "NOT_FOUND", "Vehicle no longer exists.");

  const diff = JSON.parse(reqRow.changes_json || "{}");
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [key, change] of Object.entries<any>(diff)) {
    if (!VCR_APPLYABLE.has(key)) continue;
    sets.push(`${key} = ?`);
    vals.push(change?.to ?? null);
  }
  const now = new Date().toISOString();
  if (sets.length) {
    sets.push("updated_at = ?"); vals.push(now); vals.push(reqRow.vehicle_id);
    await pgRun(`UPDATE crm_customer_vehicles SET ${sets.join(", ")} WHERE id = ?`, vals);
    if (diff.registration?.to) await syncRegistrationToLeadAndTicket(reqRow.vehicle_id, diff.registration.to);
  }
  await pgRun(
    `UPDATE vehicle_change_requests SET status='Approved', reviewed_by_user_id=?, reviewed_by_email=?, reviewed_at=?, review_notes=?, updated_at=? WHERE id=?`,
    [req.user!.id, req.user!.email || null, now, req.body?.notes || null, now, reqRow.id],
  );
  auditLog(req, "VEHICLE_CHANGE_APPROVED", `vehicle:${reqRow.vehicle_id}`, "Info", { requestId: reqRow.id, fields: Object.keys(diff) }).catch(console.error);
  return ok(res, { applied: sets.length > 0 }, "Change request approved and applied.");
});

/** POST /vehicles/change-requests/:id/reject — discard the requested changes. */
router.post("/change-requests/:id/reject", requireAuth, requireRole(ADMIN_ROLES), async (req: AuthRequest, res) => {
  const reqRow: any = await pgGet("SELECT * FROM vehicle_change_requests WHERE id = ?", [req.params.id]);
  if (!reqRow) return errorResponse(res, 404, "NOT_FOUND", "Change request not found.");
  if (reqRow.status !== "Pending") return errorResponse(res, 409, "ALREADY_REVIEWED", `This request was already ${String(reqRow.status).toLowerCase()}.`);
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE vehicle_change_requests SET status='Rejected', reviewed_by_user_id=?, reviewed_by_email=?, reviewed_at=?, review_notes=?, updated_at=? WHERE id=?`,
    [req.user!.id, req.user!.email || null, now, req.body?.notes || null, now, reqRow.id],
  );
  auditLog(req, "VEHICLE_CHANGE_REJECTED", `vehicle:${reqRow.vehicle_id}`, "Warning", { requestId: reqRow.id }).catch(console.error);
  return ok(res, null, "Change request rejected.");
});

export default router;
