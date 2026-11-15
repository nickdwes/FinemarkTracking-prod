import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS, ROLES } from "../middleware/rbac.js";
import { auditLog } from "../services/auditService.js";
import { created, errorResponse, ok } from "../utils/responses.js";
import { nextDatedBatchNumber } from "../utils/batchNumber.js";
import { cacheDeleteByPrefix } from "../utils/cache.js";
import { createNotification } from "./notifications.js";

const router = Router();

// ── Access ───────────────────────────────────────────────────────────────────
// Raising a request: the same set that can raise installation tickets (sales +
// management) plus the certificate team. Reviewing / approving / generating:
// certificate team only.
const REQUESTER_ROLES = Array.from(new Set<string>([...ROLE_GROUPS.CAN_RAISE_TICKETS, ROLES.CERT_ADMIN]));
const REVIEWER_ROLES = ROLE_GROUPS.CERT_ACCESS;

function isReviewer(req: AuthRequest): boolean {
  const r = req.user?.role;
  const e = req.user?.effectiveRole;
  return (!!r && (REVIEWER_ROLES as readonly string[]).includes(r)) ||
         (!!e && (REVIEWER_ROLES as readonly string[]).includes(e));
}

function invalidateCertificateCaches() {
  cacheDeleteByPrefix("certificates:list:");
  cacheDeleteByPrefix("certificates:dashboard:");
  cacheDeleteByPrefix("certificates:check:");
}

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Add whole months to an ISO date (YYYY-MM-DD), clamping day to the target month's length. */
function addMonths(iso: string, months: number): string {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  let ny = y;
  let nm = (m - 1) + months;
  ny += Math.floor(nm / 12);
  nm = ((nm % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, daysInMonth);
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/**
 * Derive an extension certificate's serial by inserting `extensionNo` "X"s
 * directly after the leading letter prefix of the ROOT serial, keeping the
 * dated/random tail identical. SG20260307-6053 + 1 → SGX20260307-6053;
 * + 2 → SGXX20260307-6053; UT483920 + 1 → UTX483920.
 */
function deriveExtensionSerial(rootSerial: string, extensionNo: number): string {
  const m = /^([A-Za-z]+)(.*)$/.exec(String(rootSerial || ""));
  if (!m) return rootSerial;
  return m[1] + "X".repeat(Math.max(0, extensionNo)) + m[2];
}

const norm = (v: any) => String(v || "").replace(/\s+/g, "").toUpperCase();
const isValidDate = (v: any) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10));

// ── Bootstrap tables ─────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS cert_extension_requests (
    id TEXT PRIMARY KEY,
    request_no TEXT UNIQUE,
    customer_id TEXT,
    customer_name TEXT,
    crm_vehicle_id TEXT,
    registration TEXT,
    chassis_number TEXT,
    original_certificate_id TEXT NOT NULL,
    original_serial_no TEXT,
    current_end_date TEXT,
    extension_method TEXT,
    extension_months INTEGER,
    requested_new_end_date TEXT NOT NULL,
    justification TEXT NOT NULL,
    supporting_notes TEXT,
    attachments_json TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    requested_by_user_id TEXT,
    requested_by_email TEXT,
    requested_by_name TEXT,
    requested_at TEXT NOT NULL,
    reviewed_by_user_id TEXT,
    reviewed_by_email TEXT,
    reviewed_by_name TEXT,
    reviewed_at TEXT,
    review_notes TEXT,
    return_reason TEXT,
    generated_certificate_id TEXT,
    generated_serial_no TEXT,
    generated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch((e) => console.error("[cert_extension_requests] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_cert_ext_req_status ON cert_extension_requests(status)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_cert_ext_req_original ON cert_extension_requests(original_certificate_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_cert_ext_req_customer ON cert_extension_requests(customer_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_cert_ext_req_vehicle ON cert_extension_requests(crm_vehicle_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_cert_ext_req_no ON cert_extension_requests(request_no)`, []).catch(() => {});

pgRun(`
  CREATE TABLE IF NOT EXISTS cert_extension_events (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    performed_by_user_id TEXT,
    performed_by_email TEXT,
    performed_by_name TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  )
`, []).catch((e) => console.error("[cert_extension_events] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_cert_ext_events_req ON cert_extension_events(request_id)`, []).catch(() => {});

async function logExtensionEvent(
  req: AuthRequest,
  requestId: string,
  action: string,
  fromStatus: string | null,
  toStatus: string | null,
  notes?: string | null,
) {
  await pgRun(
    `INSERT INTO cert_extension_events
       (id, request_id, action, from_status, to_status, performed_by_user_id, performed_by_email, performed_by_name, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), requestId, action, fromStatus, toStatus,
     req.user?.id || null, req.user?.email || null, req.user?.email || null, notes || null, new Date().toISOString()],
  ).catch((e) => console.error("[cert_extension_events] insert:", e));
}

// Map a request row → API DTO (camelCase).
function mapRequest(r: any) {
  return {
    id: r.id,
    requestNo: r.request_no,
    customerId: r.customer_id,
    customerName: r.customer_name,
    crmVehicleId: r.crm_vehicle_id,
    registration: r.registration,
    chassisNumber: r.chassis_number,
    originalCertificateId: r.original_certificate_id,
    originalSerialNo: r.original_serial_no,
    currentEndDate: r.current_end_date,
    extensionMethod: r.extension_method,
    extensionMonths: r.extension_months != null ? Number(r.extension_months) : null,
    requestedNewEndDate: r.requested_new_end_date,
    justification: r.justification,
    supportingNotes: r.supporting_notes,
    attachments: (() => { try { return r.attachments_json ? JSON.parse(r.attachments_json) : []; } catch { return []; } })(),
    status: r.status,
    requestedBy: r.requested_by_name || r.requested_by_email,
    requestedByEmail: r.requested_by_email,
    requestedByUserId: r.requested_by_user_id,
    requestedAt: r.requested_at,
    reviewedBy: r.reviewed_by_name || r.reviewed_by_email,
    reviewedAt: r.reviewed_at,
    reviewNotes: r.review_notes,
    returnReason: r.return_reason,
    generatedCertificateId: r.generated_certificate_id,
    generatedSerialNo: r.generated_serial_no,
    generatedAt: r.generated_at,
    // Extension depth of the certificate that would be produced (tip depth + 1).
    nextExtensionNo: r.original_extension_no != null ? Number(r.original_extension_no) + 1 : 1,
    originalStartDate: r.original_start_date ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Resolve the current "tip" certificate a request would extend, with the fields
// needed for validation + generation. `leaf` = no live child extension exists.
async function loadTip(certId: string) {
  const cert: any = await pgGet(
    `SELECT c.*,
            (SELECT rc.serial_no FROM certificates rc WHERE rc.id = COALESCE(c.root_cert_id, c.id)) AS root_serial_no,
            (SELECT rc.start_date FROM certificates rc WHERE rc.id = COALESCE(c.root_cert_id, c.id)) AS root_start_date,
            NOT EXISTS (SELECT 1 FROM certificates ch WHERE ch.extended_from_cert_id = c.id AND ch.deleted_at IS NULL) AS is_leaf
     FROM certificates c
     WHERE c.id = ? AND c.deleted_at IS NULL`,
    [certId],
  );
  return cert;
}

async function hasOpenRequest(certId: string, excludeId?: string): Promise<boolean> {
  const row = await pgGet(
    `SELECT 1 FROM cert_extension_requests
     WHERE original_certificate_id = ? AND status IN ('Pending','Approved') ${excludeId ? "AND id <> ?" : ""}
     LIMIT 1`,
    excludeId ? [certId, excludeId] : [certId],
  );
  return !!row;
}

// ── GET /candidates?vehicleId= — extendable (tip) certificates for a vehicle ──
router.get("/candidates", requireAuth, requireRole(REQUESTER_ROLES), async (req: AuthRequest, res) => {
  const vehicleId = (req.query.vehicleId as string) || "";
  if (!vehicleId) return errorResponse(res, 400, "VALIDATION_ERROR", "vehicleId is required.");
  const vehicle: any = await pgGet(
    "SELECT id, registration, chassis_number, customer_id FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL",
    [vehicleId],
  );
  if (!vehicle) return errorResponse(res, 404, "NOT_FOUND", "Vehicle not found.");

  // Match by the certificate's own vehicle FK, or (for older certs) by
  // normalized registration / chassis of this vehicle.
  const rows = await pgAll(
    `SELECT c.id, c.serial_no, c.system_type, c.model, c.car_registration, c.chassis_number,
            c.start_date, c.end_date, c.extension_no, c.root_cert_id, c.is_extension,
            (SELECT rc.serial_no FROM certificates rc WHERE rc.id = COALESCE(c.root_cert_id, c.id)) AS root_serial_no
     FROM certificates c
     WHERE c.deleted_at IS NULL
       AND ( c.crm_vehicle_id = ?
          OR ( ? <> '' AND NULLIF(REPLACE(UPPER(TRIM(c.car_registration)),' ',''),'') = ? )
          OR ( ? <> '' AND NULLIF(REPLACE(UPPER(TRIM(c.chassis_number)),' ',''),'')   = ? ) )
       AND NOT EXISTS (SELECT 1 FROM certificates ch WHERE ch.extended_from_cert_id = c.id AND ch.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM cert_extension_requests r WHERE r.original_certificate_id = c.id AND r.status IN ('Pending','Approved'))
     ORDER BY c.created_at DESC`,
    [vehicleId,
     norm(vehicle.registration), norm(vehicle.registration),
     norm(vehicle.chassis_number), norm(vehicle.chassis_number)],
  );

  return ok(res, {
    data: rows.map((c: any) => ({
      id: c.id,
      serialNo: c.serial_no,
      rootSerialNo: c.root_serial_no || c.serial_no,
      systemType: c.system_type,
      model: c.model,
      carRegistration: c.car_registration,
      chassisNumber: c.chassis_number,
      startDate: c.start_date,
      endDate: c.end_date,
      extensionNo: Number(c.extension_no || 0),
      isExtension: !!c.is_extension,
    })),
  });
});

// ── GET /resolve-vehicle?registration= — find a registered vehicle + its customer ──
// Lets a requester start the flow from a car registration instead of the customer.
// Declared before "/:id" so the literal path isn't captured as an :id param.
router.get("/resolve-vehicle", requireAuth, requireRole(REQUESTER_ROLES), async (req: AuthRequest, res) => {
  const rawReg = String(req.query.registration || "").trim();
  if (!rawReg) return errorResponse(res, 400, "VALIDATION_ERROR", "registration is required.");
  const normReg = rawReg.toUpperCase().replace(/[\s-]/g, "");
  const row: any = await pgGet(
    `SELECT v.id AS vehicle_id, v.registration, v.make, v.model, v.chassis_number,
            c.id AS customer_id,
            COALESCE(ind.full_name, corp.company_name) AS customer_name
     FROM crm_customer_vehicles v
     JOIN crm_customers c ON c.id = v.customer_id AND c.deleted_at IS NULL
     LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
     LEFT JOIN crm_corporate_profiles  corp ON corp.customer_id = c.id
     WHERE UPPER(REPLACE(REPLACE(v.registration,' ',''),'-','')) = ? AND v.deleted_at IS NULL
     ORDER BY v.created_at DESC LIMIT 1`,
    [normReg],
  );
  if (!row) return ok(res, { found: false });
  return ok(res, {
    found: true,
    vehicle: { id: row.vehicle_id, registration: row.registration, make: row.make, model: row.model, chassisNumber: row.chassis_number },
    customer: { id: row.customer_id, name: row.customer_name || "—" },
  });
});

// ── POST / — raise an extension request ──────────────────────────────────────
router.post("/", requireAuth, requireRole(REQUESTER_ROLES), async (req: AuthRequest, res) => {
  const b = req.body || {};
  const customerId = String(b.customerId || "").trim();
  const vehicleId = String(b.vehicleId || "").trim();
  const certificateId = String(b.certificateId || "").trim();
  const method = b.extensionMethod === "months" ? "months" : "date";
  const justification = String(b.justification || "").trim();
  const supportingNotes = b.supportingNotes ? String(b.supportingNotes).trim() : null;
  const attachments = Array.isArray(b.attachments) ? b.attachments : [];

  if (!customerId || !vehicleId || !certificateId) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "customerId, vehicleId and certificateId are required.");
  }
  if (!justification) return errorResponse(res, 400, "VALIDATION_ERROR", "A justification / reason is required.");

  // 1. Customer exists.
  const customer: any = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [customerId]);
  if (!customer) return errorResponse(res, 404, "NOT_FOUND", "Customer not found.");

  // 2. Vehicle belongs to that customer.
  const vehicle: any = await pgGet(
    "SELECT id, registration, chassis_number, customer_id FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL",
    [vehicleId],
  );
  if (!vehicle) return errorResponse(res, 404, "NOT_FOUND", "Vehicle not found.");
  if (String(vehicle.customer_id) !== customerId) {
    return errorResponse(res, 422, "VEHICLE_CUSTOMER_MISMATCH", "That vehicle does not belong to the selected customer.");
  }

  // 3. Certificate exists, live, and belongs to that vehicle.
  const tip = await loadTip(certificateId);
  if (!tip) return errorResponse(res, 404, "NOT_FOUND", "Certificate not found.");
  const belongs = String(tip.crm_vehicle_id || "") === vehicleId ||
    (norm(tip.car_registration) && norm(tip.car_registration) === norm(vehicle.registration)) ||
    (norm(tip.chassis_number) && norm(tip.chassis_number) === norm(vehicle.chassis_number));
  if (!belongs) return errorResponse(res, 422, "CERT_VEHICLE_MISMATCH", "That certificate was not issued for the selected vehicle.");

  // 4. Eligible = current tip (no live child extension) — keeps the chain linear.
  if (!tip.is_leaf) {
    return errorResponse(res, 422, "NOT_TIP_CERTIFICATE", "This certificate has already been extended. Extend its latest extension instead.");
  }

  // 5. No open (Pending/Approved) request for this certificate.
  if (await hasOpenRequest(certificateId)) {
    return errorResponse(res, 409, "REQUEST_EXISTS", "An extension request for this certificate is already in progress.");
  }

  // 6. Compute + validate the new end date (strictly after the current end).
  const currentEnd = tip.end_date;
  if (!isValidDate(currentEnd)) {
    return errorResponse(res, 422, "NO_END_DATE", "This certificate has no end date to extend from.");
  }
  let requestedNewEnd: string;
  let months: number | null = null;
  if (method === "months") {
    months = Number(b.extensionMonths);
    if (!Number.isFinite(months) || months <= 0 || months > 120) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "Enter a number of months between 1 and 120.");
    }
    requestedNewEnd = addMonths(currentEnd, months);
  } else {
    requestedNewEnd = String(b.newEndDate || "").slice(0, 10);
    if (!isValidDate(requestedNewEnd)) return errorResponse(res, 400, "VALIDATION_ERROR", "Enter a valid new end date (YYYY-MM-DD).");
  }
  if (!(requestedNewEnd > currentEnd)) {
    return errorResponse(res, 422, "INVALID_PERIOD", "The new end date must be after the current certificate end date.");
  }

  const now = new Date().toISOString();
  const id = uuidv4();
  const custName = String(b.customerName || "").trim() || null;

  // request_no is a per-day sequence (EXT-YYYYMMDD-NNN) computed via COUNT+1, which
  // is not atomic — under concurrent submissions two requests can compute the same
  // number and collide on the UNIQUE(request_no) constraint. Regenerate + retry on
  // exactly that collision (23505) so concurrent submissions still succeed.
  let requestNo = "";
  let insertErr: any = null;
  // COUNT+1 lets ~one concurrent writer through per round, so allow enough
  // attempts to clear a realistic burst before giving up.
  for (let attempt = 0; attempt < 25; attempt++) {
    requestNo = await nextDatedBatchNumber("EXT", [{ table: "cert_extension_requests", column: "request_no" }]);
    try {
      await pgRun(
        `INSERT INTO cert_extension_requests
           (id, request_no, customer_id, customer_name, crm_vehicle_id, registration, chassis_number,
            original_certificate_id, original_serial_no, current_end_date,
            extension_method, extension_months, requested_new_end_date,
            justification, supporting_notes, attachments_json, status,
            requested_by_user_id, requested_by_email, requested_by_name, requested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?, ?)`,
        [id, requestNo, customerId, custName, vehicleId, vehicle.registration || null, vehicle.chassis_number || tip.chassis_number || null,
         certificateId, tip.serial_no, currentEnd,
         method, months, requestedNewEnd,
         justification, supportingNotes, attachments.length ? JSON.stringify(attachments) : null,
         req.user?.id || null, req.user?.email || null, req.user?.email || null, now, now, now],
      );
      insertErr = null;
      break;
    } catch (e: any) {
      insertErr = e;
      if (e?.code === "23505") continue; // request_no collided — regenerate and retry
      break;
    }
  }
  if (insertErr) {
    console.error("[cert-extension create] insert:", insertErr);
    return errorResponse(res, 500, "INTERNAL", "Could not submit the extension request — please try again.");
  }

  await logExtensionEvent(req, id, "REQUESTED", null, "Pending", justification);
  auditLog(req, "EXT_REQUESTED", `cert_extension:${id}`, "Info", {
    requestNo, originalSerialNo: tip.serial_no, originalEndDate: currentEnd, requestedNewEndDate: requestedNewEnd,
  }).catch(console.error);
  createNotification({
    targetRole: ROLES.CERT_ADMIN,
    type: "approval",
    title: `Certificate extension requested — ${requestNo}`,
    body: `${tip.serial_no} · ${vehicle.registration || "vehicle"} · extend to ${requestedNewEnd}`,
    link: "/cert-extension-requests.html",
  }).catch(console.error);

  return created(res, { id, requestNo, status: "Pending", requestedNewEndDate: requestedNewEnd }, "Extension request submitted");
});

// ── GET / — queue / list (reviewers see all; requesters see their own) ────────
router.get("/", requireAuth, requireRole(REQUESTER_ROLES), async (req: AuthRequest, res) => {
  const status = (req.query.status as string) || "";
  const search = (req.query.search as string) || "";
  const from = (req.query.from as string) || "";
  const to = (req.query.to as string) || "";
  const reviewer = isReviewer(req);

  const where: string[] = [];
  const params: any[] = [];
  if (!reviewer) { where.push("requested_by_user_id = ?"); params.push(req.user?.id || ""); }
  if (status) { where.push("status = ?"); params.push(status); }
  if (search) {
    where.push(`(request_no ILIKE ? OR original_serial_no ILIKE ? OR customer_name ILIKE ? OR REPLACE(registration,' ','') ILIKE ? OR chassis_number ILIKE ? OR generated_serial_no ILIKE ?)`);
    const like = `%${search}%`;
    const regLike = `%${search.replace(/\s+/g, "")}%`;
    params.push(like, like, like, regLike, like, like);
  }
  if (from) { where.push("requested_at >= ?"); params.push(from); }
  if (to) { where.push("requested_at <= ?"); params.push(`${to}T23:59:59.999Z`); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await pgAll(
    `SELECT r.*,
            oc.start_date AS original_start_date, oc.extension_no AS original_extension_no
     FROM cert_extension_requests r
     LEFT JOIN certificates oc ON oc.id = r.original_certificate_id
     ${whereSql}
     ORDER BY r.requested_at DESC
     LIMIT 500`,
    params,
  );
  return ok(res, { data: rows.map(mapRequest) });
});

// ── GET /stats — dashboard "Extension Certificates" section ───────────────────
router.get("/stats", requireAuth, requireRole(REVIEWER_ROLES), async (_req, res) => {
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const row: any = await pgGet(
    `SELECT
       (SELECT COUNT(*) FROM cert_extension_requests) AS total,
       (SELECT COUNT(*) FROM cert_extension_requests WHERE status = 'Pending') AS pending,
       (SELECT COUNT(*) FROM cert_extension_requests WHERE status = 'Approved') AS approved,
       (SELECT COUNT(*) FROM cert_extension_requests WHERE status = 'Rejected') AS rejected,
       (SELECT COUNT(*) FROM cert_extension_requests WHERE status = 'Returned') AS returned,
       (SELECT COUNT(*) FROM cert_extension_requests WHERE status = 'Generated') AS generated,
       (SELECT COUNT(*) FROM certificates WHERE is_extension = true AND deleted_at IS NULL AND extended_at >= ?) AS recently_extended`,
    [cutoff],
  ).catch(() => null);
  return ok(res, {
    total: Number(row?.total || 0),
    pending: Number(row?.pending || 0),
    approved: Number(row?.approved || 0),
    rejected: Number(row?.rejected || 0),
    returned: Number(row?.returned || 0),
    generated: Number(row?.generated || 0),
    recentlyExtended: Number(row?.recently_extended || 0),
  });
});

// ── GET /:id — full request + original cert snapshot + event history ──────────
router.get("/:id", requireAuth, requireRole(REQUESTER_ROLES), async (req: AuthRequest, res) => {
  const r: any = await pgGet(
    `SELECT r.*, oc.start_date AS original_start_date, oc.extension_no AS original_extension_no
     FROM cert_extension_requests r
     LEFT JOIN certificates oc ON oc.id = r.original_certificate_id
     WHERE r.id = ?`,
    [req.params.id],
  );
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Extension request not found.");
  if (!isReviewer(req) && String(r.requested_by_user_id || "") !== String(req.user?.id || "")) {
    return errorResponse(res, 404, "NOT_FOUND", "Extension request not found.");
  }

  // Original / tip certificate snapshot (retained identity for generation).
  const cert = await loadTip(r.original_certificate_id);
  const events = await pgAll(
    `SELECT action, from_status, to_status, performed_by_email, performed_by_name, notes, created_at
     FROM cert_extension_events WHERE request_id = ? ORDER BY created_at ASC`,
    [req.params.id],
  );

  return ok(res, {
    request: mapRequest(r),
    originalCertificate: cert ? {
      id: cert.id,
      serialNo: cert.serial_no,
      rootSerialNo: cert.root_serial_no || cert.serial_no,
      rootStartDate: cert.root_start_date || cert.start_date,
      template: cert.template || "finemark",
      systemType: cert.system_type,
      carRegistration: cert.car_registration,
      model: cert.model,
      name: cert.name,
      color: cert.color,
      phone: cert.phone,
      startDate: cert.start_date,
      endDate: cert.end_date,
      loanDurationYears: cert.loan_duration_years,
      imei1: cert.imei_1, imei2: cert.imei_2,
      trackerNo1: cert.tracker_no_1, trackerNo2: cert.tracker_no_2,
      additionalDevices: (() => { try { return cert.additional_devices_json ? JSON.parse(cert.additional_devices_json) : []; } catch { return []; } })(),
      chassisNumber: cert.chassis_number,
      engineNumber: cert.engine_number,
      partnerBank: cert.partner_bank,
      printedByUserId: cert.printed_by_user_id,
      printedByName: cert.printed_by_name,
      printedBySignatureUrl: cert.printed_by_signature_url,
      authorizedByName: cert.authorized_by_name,
      authorizedByRole: cert.authorized_by_role,
      authorizedBySignatureUrl: cert.authorized_by_signature_url,
      extensionNo: Number(cert.extension_no || 0),
      isLeaf: !!cert.is_leaf,
    } : null,
    events: events.map((e: any) => ({
      action: e.action, fromStatus: e.from_status, toStatus: e.to_status,
      by: e.performed_by_name || e.performed_by_email, notes: e.notes, createdAt: e.created_at,
    })),
  });
});

// ── Review transitions ───────────────────────────────────────────────────────
async function getPendingReviewable(id: string) {
  return pgGet("SELECT * FROM cert_extension_requests WHERE id = ?", [id]);
}

router.post("/:id/approve", requireAuth, requireRole(REVIEWER_ROLES), async (req: AuthRequest, res) => {
  const r: any = await getPendingReviewable(req.params.id);
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Extension request not found.");
  if (r.status !== "Pending") return errorResponse(res, 409, "ALREADY_REVIEWED", `This request was already ${String(r.status).toLowerCase()}.`);
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE cert_extension_requests
     SET status='Approved', reviewed_by_user_id=?, reviewed_by_email=?, reviewed_by_name=?, reviewed_at=?, review_notes=?, return_reason=NULL, updated_at=?
     WHERE id=?`,
    [req.user?.id || null, req.user?.email || null, req.user?.email || null, now, req.body?.notes || null, now, r.id],
  );
  await logExtensionEvent(req, r.id, "APPROVED", "Pending", "Approved", req.body?.notes || null);
  auditLog(req, "EXT_APPROVED", `cert_extension:${r.id}`, "Info", { requestNo: r.request_no }).catch(console.error);
  if (r.requested_by_user_id) {
    createNotification({
      targetUserId: r.requested_by_user_id, type: "success",
      title: `Extension approved — ${r.request_no}`,
      body: `${r.original_serial_no} approved for extension to ${r.requested_new_end_date}. Awaiting certificate generation.`,
      link: "/cert-extension.html",
    }).catch(console.error);
  }
  return ok(res, { id: r.id, status: "Approved" }, "Extension request approved.");
});

router.post("/:id/reject", requireAuth, requireRole(REVIEWER_ROLES), async (req: AuthRequest, res) => {
  const reason = String(req.body?.reason || req.body?.notes || "").trim();
  const r: any = await getPendingReviewable(req.params.id);
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Extension request not found.");
  if (r.status !== "Pending") return errorResponse(res, 409, "ALREADY_REVIEWED", `This request was already ${String(r.status).toLowerCase()}.`);
  if (!reason) return errorResponse(res, 400, "VALIDATION_ERROR", "A rejection reason is required.");
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE cert_extension_requests
     SET status='Rejected', reviewed_by_user_id=?, reviewed_by_email=?, reviewed_by_name=?, reviewed_at=?, review_notes=?, updated_at=?
     WHERE id=?`,
    [req.user?.id || null, req.user?.email || null, req.user?.email || null, now, reason, now, r.id],
  );
  await logExtensionEvent(req, r.id, "REJECTED", "Pending", "Rejected", reason);
  auditLog(req, "EXT_REJECTED", `cert_extension:${r.id}`, "Warning", { requestNo: r.request_no, reason }).catch(console.error);
  if (r.requested_by_user_id) {
    createNotification({
      targetUserId: r.requested_by_user_id, type: "error",
      title: `Extension rejected — ${r.request_no}`,
      body: reason, link: "/cert-extension.html",
    }).catch(console.error);
  }
  return ok(res, { id: r.id, status: "Rejected" }, "Extension request rejected.");
});

router.post("/:id/return", requireAuth, requireRole(REVIEWER_ROLES), async (req: AuthRequest, res) => {
  const reason = String(req.body?.reason || req.body?.notes || "").trim();
  const r: any = await getPendingReviewable(req.params.id);
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Extension request not found.");
  if (r.status !== "Pending") return errorResponse(res, 409, "ALREADY_REVIEWED", `This request was already ${String(r.status).toLowerCase()}.`);
  if (!reason) return errorResponse(res, 400, "VALIDATION_ERROR", "A reason for returning is required.");
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE cert_extension_requests
     SET status='Returned', reviewed_by_user_id=?, reviewed_by_email=?, reviewed_by_name=?, reviewed_at=?, return_reason=?, updated_at=?
     WHERE id=?`,
    [req.user?.id || null, req.user?.email || null, req.user?.email || null, now, reason, now, r.id],
  );
  await logExtensionEvent(req, r.id, "RETURNED", "Pending", "Returned", reason);
  auditLog(req, "EXT_RETURNED", `cert_extension:${r.id}`, "Warning", { requestNo: r.request_no, reason }).catch(console.error);
  if (r.requested_by_user_id) {
    createNotification({
      targetUserId: r.requested_by_user_id, type: "warning",
      title: `Extension returned for correction — ${r.request_no}`,
      body: reason, link: "/cert-extension.html",
    }).catch(console.error);
  }
  return ok(res, { id: r.id, status: "Returned" }, "Extension request returned for correction.");
});

// ── POST /:id/resubmit — requester fixes a Returned request ───────────────────
router.post("/:id/resubmit", requireAuth, requireRole(REQUESTER_ROLES), async (req: AuthRequest, res) => {
  const r: any = await pgGet("SELECT * FROM cert_extension_requests WHERE id = ?", [req.params.id]);
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Extension request not found.");
  if (!isReviewer(req) && String(r.requested_by_user_id || "") !== String(req.user?.id || "")) {
    return errorResponse(res, 403, "FORBIDDEN", "You can only resubmit your own requests.");
  }
  if (r.status !== "Returned") return errorResponse(res, 409, "INVALID_STATE", "Only returned requests can be resubmitted.");

  const b = req.body || {};
  const justification = b.justification !== undefined ? String(b.justification).trim() : r.justification;
  const supportingNotes = b.supportingNotes !== undefined ? (String(b.supportingNotes).trim() || null) : r.supporting_notes;
  if (!justification) return errorResponse(res, 400, "VALIDATION_ERROR", "A justification / reason is required.");

  // Re-validate the period + that the tip is still extendable.
  const tip = await loadTip(r.original_certificate_id);
  if (!tip) return errorResponse(res, 404, "NOT_FOUND", "The original certificate no longer exists.");
  if (!tip.is_leaf) return errorResponse(res, 422, "NOT_TIP_CERTIFICATE", "This certificate has since been extended elsewhere.");
  if (await hasOpenRequest(r.original_certificate_id, r.id)) {
    return errorResponse(res, 409, "REQUEST_EXISTS", "Another extension request for this certificate is already in progress.");
  }

  let requestedNewEnd = r.requested_new_end_date;
  let months = r.extension_months;
  let method = r.extension_method;
  if (b.extensionMethod || b.newEndDate || b.extensionMonths !== undefined) {
    method = b.extensionMethod === "months" ? "months" : "date";
    if (method === "months") {
      months = Number(b.extensionMonths);
      if (!Number.isFinite(months) || months <= 0 || months > 120) return errorResponse(res, 400, "VALIDATION_ERROR", "Enter a number of months between 1 and 120.");
      requestedNewEnd = addMonths(tip.end_date, months);
    } else {
      requestedNewEnd = String(b.newEndDate || "").slice(0, 10);
      months = null;
      if (!isValidDate(requestedNewEnd)) return errorResponse(res, 400, "VALIDATION_ERROR", "Enter a valid new end date (YYYY-MM-DD).");
    }
  }
  if (!(requestedNewEnd > tip.end_date)) return errorResponse(res, 422, "INVALID_PERIOD", "The new end date must be after the current certificate end date.");

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE cert_extension_requests
     SET status='Pending', justification=?, supporting_notes=?, extension_method=?, extension_months=?,
         requested_new_end_date=?, current_end_date=?, return_reason=NULL, updated_at=?
     WHERE id=?`,
    [justification, supportingNotes, method, months, requestedNewEnd, tip.end_date, now, r.id],
  );
  await logExtensionEvent(req, r.id, "RESUBMITTED", "Returned", "Pending", justification);
  auditLog(req, "EXT_RESUBMITTED", `cert_extension:${r.id}`, "Info", { requestNo: r.request_no }).catch(console.error);
  createNotification({
    targetRole: ROLES.CERT_ADMIN, type: "approval",
    title: `Extension resubmitted — ${r.request_no}`,
    body: `${r.original_serial_no} · extend to ${requestedNewEnd}`,
    link: "/cert-extension-requests.html",
  }).catch(console.error);
  return ok(res, { id: r.id, status: "Pending", requestedNewEndDate: requestedNewEnd }, "Extension request resubmitted.");
});

// ── POST /:id/generate — produce the extension certificate (after approval) ───
router.post("/:id/generate", requireAuth, requireRole(REVIEWER_ROLES), async (req: AuthRequest, res) => {
  const r: any = await pgGet("SELECT * FROM cert_extension_requests WHERE id = ?", [req.params.id]);
  if (!r) return errorResponse(res, 404, "NOT_FOUND", "Extension request not found.");
  if (r.status === "Generated") return errorResponse(res, 409, "ALREADY_GENERATED", "This extension certificate has already been generated.");
  if (r.status !== "Approved") return errorResponse(res, 422, "NOT_APPROVED", "This request must be approved before a certificate can be generated.");

  const tip = await loadTip(r.original_certificate_id);
  if (!tip) return errorResponse(res, 404, "NOT_FOUND", "The original certificate no longer exists.");
  if (!tip.is_leaf) return errorResponse(res, 422, "NOT_TIP_CERTIFICATE", "The original certificate has already been extended.");

  const b = req.body || {};
  const pdfBase64 = b.pdfBase64;
  if (!pdfBase64) return errorResponse(res, 400, "VALIDATION_ERROR", "pdfBase64 is required.");

  const extensionNo = Number(tip.extension_no || 0) + 1;
  const rootCertId = tip.root_cert_id || tip.id;
  const rootSerial = tip.root_serial_no || tip.serial_no;
  const rootStart = tip.root_start_date || tip.start_date;
  const expectedSerial = deriveExtensionSerial(rootSerial, extensionNo);
  const serialNo = String(b.serialNo || "").trim();
  if (serialNo && serialNo !== expectedSerial) {
    return errorResponse(res, 409, "SERIAL_MISMATCH", `Serial should be ${expectedSerial}. Please refresh and regenerate.`);
  }
  const finalSerial = serialNo || expectedSerial;

  // Full-coverage validity: start = root original's start, end = the approved new end.
  const startDate = String(b.startDate || rootStart || tip.start_date || "").slice(0, 10) || null;
  const endDate = String(b.endDate || r.requested_new_end_date || "").slice(0, 10) || null;

  const now = new Date().toISOString();
  const newId = uuidv4();
  // Retain original identity from the tip; content/devices from the payload fall
  // back to the tip's values so a minimal payload still produces a faithful cert.
  const pick = (k: string, col: string) => (b[k] !== undefined && b[k] !== null && b[k] !== "" ? b[k] : tip[col]);
  try {
    await pgRun(
      `INSERT INTO certificates
         (id, serial_no, template, system_type, car_registration, model, date, name, color, phone,
          start_date, end_date, loan_duration_years, imei_1, imei_2, tracker_no_1, tracker_no_2,
          additional_devices_json, chassis_number, engine_number, partner_bank,
          customer_id, crm_vehicle_id,
          printed_by_user_id, printed_by_name, printed_by_signature_url,
          authorized_by_name, authorized_by_role, authorized_by_signature_url,
          pdf_base64, created_by_user_id, created_by_email, created_at, updated_at,
          is_extension, extension_no, extended_from_cert_id, root_cert_id, extension_request_id,
          prior_start_date, prior_end_date, extended_at, extension_approved_by_user_id, extension_approved_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               true, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, finalSerial, tip.template || "finemark", pick("systemType", "system_type"), tip.car_registration,
       pick("model", "model"), (b.date || now.slice(0, 10)), pick("name", "name"), pick("color", "color"), pick("phone", "phone"),
       startDate, endDate,
       (b.loanDurationYears !== undefined ? b.loanDurationYears : tip.loan_duration_years),
       pick("imei1", "imei_1"), pick("imei2", "imei_2"), pick("trackerNo1", "tracker_no_1"), pick("trackerNo2", "tracker_no_2"),
       (Array.isArray(b.additionalDevices) && b.additionalDevices.length ? JSON.stringify(b.additionalDevices) : tip.additional_devices_json),
       pick("chassisNumber", "chassis_number"), pick("engineNumber", "engine_number"), pick("partnerBank", "partner_bank"),
       tip.customer_id, tip.crm_vehicle_id,
       (b.printedByUserId ?? req.user?.id ?? null), (b.printedByName ?? tip.printed_by_name ?? null), (b.printedBySignatureUrl ?? tip.printed_by_signature_url ?? null),
       pick("authorizedByName", "authorized_by_name"), pick("authorizedByRole", "authorized_by_role"), pick("authorizedBySignatureUrl", "authorized_by_signature_url"),
       pdfBase64, req.user?.id || null, req.user?.email || null, now, now,
       extensionNo, tip.id, rootCertId, r.id,
       tip.start_date, tip.end_date, now, (r.reviewed_by_user_id || req.user?.id || null), (r.reviewed_by_name || req.user?.email || null)],
    );
  } catch (error: any) {
    if (error?.code === "23505") return errorResponse(res, 409, "CONFLICT", "This extension certificate serial already exists — it may already have been generated.");
    console.error("[cert-extension generate] insert:", error);
    return errorResponse(res, 500, "INTERNAL", "Failed to generate extension certificate.");
  }

  await pgRun(
    `UPDATE cert_extension_requests SET status='Generated', generated_certificate_id=?, generated_serial_no=?, generated_at=?, updated_at=? WHERE id=?`,
    [newId, finalSerial, now, now, r.id],
  );
  invalidateCertificateCaches();
  await logExtensionEvent(req, r.id, "GENERATED", "Approved", "Generated", `Serial ${finalSerial}`);
  auditLog(req, "CERT_EXTENSION_GENERATED", `certificate:${newId}`, "Info", {
    requestNo: r.request_no, originalSerialNo: tip.serial_no, extensionSerialNo: finalSerial,
    extensionNo, originalEndDate: tip.end_date, newEndDate: endDate,
  }).catch(console.error);
  if (r.requested_by_user_id) {
    createNotification({
      targetUserId: r.requested_by_user_id, type: "success",
      title: `Extension certificate generated — ${finalSerial}`,
      body: `${r.request_no}: ${tip.serial_no} extended to ${endDate}.`,
      link: "/cert-extension.html",
    }).catch(console.error);
  }

  return created(res, {
    id: newId, serialNo: finalSerial, extensionNo, rootCertId,
    carRegistration: tip.car_registration, startDate, endDate,
  }, "Extension certificate generated");
});

export default router;
