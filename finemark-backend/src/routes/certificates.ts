import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { auditLog } from "../services/auditService.js";
import { created, errorResponse, ok } from "../utils/responses.js";
import { createCertificateSchema, listCertificatesQuerySchema, emailCertificateSchema, updateCertificateSchema, certBankConfigSchema, updateCertBankConfigSchema } from "../utils/validators.js";
import { sendMail } from "../utils/mailer.js";
import { buildCertificateEmail } from "../utils/emailTemplates.js";
import { cacheDeleteByPrefix, cacheGetOrSet } from "../utils/cache.js";

const router = Router();
const CERT_LIST_TTL_MS = 30_000;
const CERT_DASHBOARD_TTL_MS = 30_000;
const CERT_CHECK_TTL_MS = 60_000;

function invalidateCertificateCaches() {
  cacheDeleteByPrefix("certificates:list:");
  cacheDeleteByPrefix("certificates:dashboard:");
  cacheDeleteByPrefix("certificates:check:");
}

// ── Dashboard: pipeline + stats + all certs ─────────────────────────────────
router.get("/dashboard", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const in60 = new Date(Date.now() + 60 * 86400 * 1000).toISOString().slice(0, 10);

  const cacheKey = `certificates:dashboard:${today}:${in60}`;
  const payload = await cacheGetOrSet(cacheKey, CERT_DASHBOARD_TTL_MS, async () => {
    const [statsRow, pipeline, allCerts] = await Promise.all([
      pgGet(
        `SELECT
          (SELECT COUNT(*) FROM certificates WHERE end_date >= ?) AS active,
          (SELECT COUNT(*) FROM certificates WHERE end_date >= ? AND end_date <= ?) AS nearing_expiry,
          (SELECT COUNT(*) FROM certificates WHERE end_date < ?) AS expired,
          (SELECT COUNT(*) FROM vi_installations vi
             JOIN crm_customer_vehicles v ON v.id = vi.vehicle_id
             LEFT JOIN certificates c ON UPPER(c.car_registration) = UPPER(v.registration)
             WHERE vi.completed_at IS NOT NULL AND c.id IS NULL) AS awaiting_generation`,
        [today, today, in60, today]
      ).catch(() => ({ active: 0, nearing_expiry: 0, expired: 0, awaiting_generation: 0 })),
      pgAll(
        `SELECT vi.id, vi.completed_at, v.registration, v.make, v.model,
                it.id AS ticket_id, it.ticket_no, it.customer_name
         FROM vi_installations vi
         JOIN crm_customer_vehicles v ON v.id = vi.vehicle_id
         LEFT JOIN installation_tickets it ON it.vi_installation_id = vi.id
         LEFT JOIN certificates c ON UPPER(c.car_registration) = UPPER(v.registration)
         WHERE vi.completed_at IS NOT NULL AND c.id IS NULL
         ORDER BY vi.completed_at DESC
         LIMIT 100`,
        []
      ).catch(() => [] as any[]),
      pgAll(
        `SELECT id, serial_no, template, system_type, car_registration, model, name, phone,
                start_date, end_date, created_at
         FROM certificates
         ORDER BY created_at DESC
         LIMIT 500`,
        []
      ).catch(() => [] as any[]),
    ]);

    const certStatus = (endDate: string) => {
      if (!endDate) return "Unknown";
      if (endDate < today) return "Expired";
      if (endDate <= in60) return "NearingExpiry";
      return "Active";
    };

    return {
      stats: {
        active: Number((statsRow as any)?.active || 0),
        nearingExpiry: Number((statsRow as any)?.nearing_expiry || 0),
        expired: Number((statsRow as any)?.expired || 0),
        awaitingGeneration: Number((statsRow as any)?.awaiting_generation || 0),
      },
      pipeline: pipeline.map((r: any) => ({
        viId: r.id,
        ticketId: r.ticket_id || null,
        completedAt: r.completed_at,
        registration: r.registration,
        makeModel: [r.make, r.model].filter(Boolean).join(" "),
        ticketNo: r.ticket_no || null,
        customerName: r.customer_name || null,
      })),
      certificates: allCerts.map((r: any) => ({
        id: r.id,
        serialNo: r.serial_no,
        template: r.template || "finemark",
        systemType: r.system_type,
        carRegistration: r.car_registration,
        model: r.model,
        name: r.name,
        phone: r.phone,
        startDate: r.start_date,
        endDate: r.end_date,
        createdAt: r.created_at,
        status: certStatus(r.end_date),
      })),
    };
  });

  return ok(res, payload);
});

// ── Check for duplicate: same registration + system type ─────────────────────
router.get("/check", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (req, res) => {
  const { registration, systemType } = req.query as { registration?: string; systemType?: string };
  if (!registration || !systemType) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "registration and systemType are required.");
  }
  const normReg = registration.trim().replace(/\s+/g, '').toUpperCase();
  const normSystemType = systemType.trim();
  const cacheKey = `certificates:check:${normReg}:${normSystemType.toUpperCase()}`;
  const row = await cacheGetOrSet(cacheKey, CERT_CHECK_TTL_MS, async () => pgGet(
    `SELECT id, serial_no, template, system_type, car_registration, model, date, name, color, phone,
            start_date, end_date, loan_duration_years, imei_1, imei_2, tracker_no_1, tracker_no_2,
            additional_devices_json, chassis_number, engine_number, partner_bank, created_at
     FROM certificates
     WHERE REPLACE(UPPER(car_registration),' ','') = UPPER(?) AND UPPER(system_type) = UPPER(?)
     ORDER BY created_at DESC LIMIT 1`,
    [normReg, normSystemType]
  ));
  if (!row) return ok(res, { exists: false });
  return ok(res, {
    exists: true,
    certificate: {
      id: row.id,
      serialNo: row.serial_no,
      template: row.template || "finemark",
      systemType: row.system_type,
      carRegistration: row.car_registration,
      model: row.model,
      date: row.date,
      name: row.name,
      color: row.color,
      phone: row.phone,
      startDate: row.start_date,
      endDate: row.end_date,
      loanDurationYears: row.loan_duration_years,
      imei1: row.imei_1,
      imei2: row.imei_2,
      trackerNo1: row.tracker_no_1,
      trackerNo2: row.tracker_no_2,
      additionalDevices: (() => { try { return row.additional_devices_json ? JSON.parse(row.additional_devices_json) : []; } catch { return []; } })(),
      chassisNumber: row.chassis_number,
      engineNumber: row.engine_number,
      partnerBank: row.partner_bank,
      createdAt: row.created_at,
    },
  });
});
router.post("/", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (req: AuthRequest, res) => {
  const parsed = createCertificateSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const {
    serialNo, template, systemType, carRegistration, model, date, name, color, phone, startDate, endDate,
    loanDurationYears, imei1, imei2, trackerNo1, trackerNo2, additionalDevices,
    chassisNumber, engineNumber, partnerBank,
    printedByUserId, printedByName, printedBySignatureUrl,
    authorizedByName, authorizedByRole, authorizedBySignatureUrl,
    pdfBase64,
  } = parsed.data;
  const normCarReg = carRegistration.replace(/\s+/g, '').toUpperCase();
  const now = new Date().toISOString();
  const id = uuidv4();
  try {
    await pgRun(
      `INSERT INTO certificates (id, serial_no, template, system_type, car_registration, model, date, name, color, phone, start_date, end_date, loan_duration_years, imei_1, imei_2, tracker_no_1, tracker_no_2, additional_devices_json, chassis_number, engine_number, partner_bank, printed_by_user_id, printed_by_name, printed_by_signature_url, authorized_by_name, authorized_by_role, authorized_by_signature_url, pdf_base64, created_by_user_id, created_by_email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, serialNo, template, systemType || null, normCarReg, model || null, date || null, name || null, color || null, phone || null,
       startDate || null, endDate || null, loanDurationYears ?? null, imei1 || null, imei2 || null, trackerNo1 || null, trackerNo2 || null,
       additionalDevices?.length ? JSON.stringify(additionalDevices) : null,
       chassisNumber || null, engineNumber || null, partnerBank || null,
       printedByUserId || null, printedByName || null, printedBySignatureUrl || null,
       authorizedByName || null, authorizedByRole || null, authorizedBySignatureUrl || null,
       pdfBase64, req.user?.id, req.user?.email, now, now]
    );
  } catch (error: any) {
    if (error?.code === "23505") return errorResponse(res, 409, "CONFLICT", "Certificate serial number already exists.");
    return errorResponse(res, 500, "INTERNAL", "Failed to save certificate.");
  }
  invalidateCertificateCaches();
  auditLog(req, "CERTIFICATE_CREATED", `certificate:${id}`, "Info", { serialNo, carRegistration: normCarReg }).catch(console.error);
  return created(res, { id, serialNo, carRegistration: normCarReg, model, name, phone, createdAt: now }, "Certificate saved");
});

router.get("/", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (req, res) => {
  const parsed = listCertificatesQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());
  const { search, from, to } = parsed.data;
  const page = Number(parsed.data.page || 1);
  const pageSize = Number(parsed.data.pageSize || 20);
  const offset = (page - 1) * pageSize;
  const where: string[] = [];
  const params: any[] = [];
  if (search) {
    where.push(`(serial_no ILIKE ? OR REPLACE(car_registration,' ','') ILIKE ? OR name ILIKE ? OR phone ILIKE ? OR imei_1 ILIKE ? OR imei_2 ILIKE ?)`);
    const like = `%${search}%`;
    const regLike = `%${search.replace(/\s+/g, '')}%`;
    params.push(like, regLike, like, like, like, like);
  }
  if (from) { where.push("created_at >= ?"); params.push(from); }
  // created_at is a full ISO timestamp; a plain date string (e.g. "2026-07-09")
  // sorts BEFORE any timestamp on that same day in a string comparison, so a
  // naive `<= to` silently excluded every certificate created that day. Extend
  // to the end of the day so "To" is inclusive of the date the user picked.
  if (to) { where.push("created_at <= ?"); params.push(`${to}T23:59:59.999Z`); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const cacheKey = `certificates:list:${JSON.stringify({ search: search || "", from: from || "", to: to || "", page, pageSize })}`;
  const payload = await cacheGetOrSet(cacheKey, CERT_LIST_TTL_MS, async () => {
    const rows = await pgAll(`SELECT id, serial_no, template, car_registration, model, name, phone, start_date, end_date, created_at FROM certificates ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    const totalRow = await pgGet(`SELECT COUNT(*) as total FROM certificates ${whereSql}`, params);
    const data = rows.map((row) => ({ id: row.id, serialNo: row.serial_no, template: row.template || "finemark", carRegistration: row.car_registration, model: row.model, name: row.name, phone: row.phone, startDate: row.start_date, endDate: row.end_date, createdAt: row.created_at }));
    return { data, meta: { total: Number(totalRow?.total || 0) } };
  });
  return ok(res, payload);
});

// ── Public certificate verification (no auth required) ─────────────────────
// Returns only validation status and non-PII summary fields.
// CORS is opened for this route only so any QR scanner (mobile browser, etc.) can reach it.
router.get("/verify/:serialNo", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
}, async (req, res) => {
  const { serialNo } = req.params;
  if (!serialNo || serialNo.length < 3) {
    return res.status(400).json({ valid: false, error: "Invalid serial number." });
  }
  const row = await pgGet(
    "SELECT id, serial_no, car_registration, model, system_type, date, start_date, end_date, created_at FROM certificates WHERE serial_no = ?",
    [serialNo.toUpperCase()]
  );
  if (!row) {
    return res.status(200).json({ valid: false });
  }
  return res.status(200).json({
    valid: true,
    serialNo: row.serial_no,
    carRegistration: row.car_registration,
    model: row.model,
    systemType: row.system_type,
    issuedDate: row.date,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
  });
});

// ── Designated signatories (COO/CEO) for the certificate "Authorised By" block ──
// Maintained by System Administrator only; Certificate Managers can read but
// not modify. Exactly one row across both roles is is_active at a time — that
// is the signatory automatically pulled onto newly generated certificates.
const mapSignatory = (r: any) => ({
  id: r.id, roleTitle: r.role_title, fullName: r.full_name,
  signatureUrl: r.signature_url, isActive: !!r.is_active, updatedAt: r.updated_at,
});

router.get("/signatories", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (_req, res) => {
  const rows = await pgAll("SELECT * FROM cert_signatories ORDER BY role_title");
  return ok(res, { data: rows.map(mapSignatory) });
});

router.get("/signatories/active", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (_req, res) => {
  const row = await pgGet("SELECT * FROM cert_signatories WHERE is_active = true LIMIT 1");
  return ok(res, { data: row ? mapSignatory(row) : null });
});

router.put("/signatories/:roleTitle", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const roleTitle = req.params.roleTitle;
  if (!["COO", "CEO"].includes(roleTitle)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "roleTitle must be COO or CEO.");
  }
  const { fullName, signatureBase64, isActive } = req.body || {};
  if (!fullName?.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "fullName is required.");

  let signatureUrl: string | undefined;
  if (signatureBase64) {
    const match = /^data:image\/png;base64,(.+)$/.exec(signatureBase64);
    if (!match) return errorResponse(res, 400, "VALIDATION_ERROR", "signatureBase64 must be a PNG data URL.");
    const buffer = Buffer.from(match[1], "base64");
    if (buffer.length > 2 * 1024 * 1024) return errorResponse(res, 400, "VALIDATION_ERROR", "Signature image must be under 2MB.");
    const dir = path.join(process.cwd(), "public", "signatures");
    fs.mkdirSync(dir, { recursive: true });
    const filename = `signatory-${roleTitle.toLowerCase()}-${Date.now()}.png`;
    fs.writeFileSync(path.join(dir, filename), buffer);
    signatureUrl = `/public/signatures/${filename}`;
  }

  const now = new Date().toISOString();
  const existing = await pgGet("SELECT * FROM cert_signatories WHERE role_title = ?", [roleTitle]);
  const { count } = (await pgGet("SELECT COUNT(*) as count FROM cert_signatories")) || { count: 0 };
  const isFirstEver = !existing && Number(count) === 0;
  const resolvedActive = isActive !== undefined ? !!isActive : (existing ? undefined : isFirstEver);

  if (existing) {
    const sets = ["full_name = ?", "updated_by_user_id = ?", "updated_at = ?"];
    const vals: any[] = [fullName.trim(), req.user!.id, now];
    if (signatureUrl) { sets.push("signature_url = ?"); vals.push(signatureUrl); }
    if (resolvedActive !== undefined) { sets.push("is_active = ?"); vals.push(resolvedActive); }
    vals.push(existing.id);
    await pgRun(`UPDATE cert_signatories SET ${sets.join(", ")} WHERE id = ?`, vals);
  } else {
    await pgRun(
      `INSERT INTO cert_signatories (id, role_title, full_name, signature_url, is_active, updated_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uuidv4(), roleTitle, fullName.trim(), signatureUrl || null, !!resolvedActive, req.user!.id, now, now]
    );
  }

  // Only one signatory may be active at a time across both roles.
  if (resolvedActive === true) {
    await pgRun("UPDATE cert_signatories SET is_active = false WHERE role_title != ?", [roleTitle]);
  }

  auditLog(req, "CERT_SIGNATORY_UPDATED", `cert_signatory:${roleTitle}`, "Info", { roleTitle, fullName: fullName.trim() }).catch(console.error);
  const row = await pgGet("SELECT * FROM cert_signatories WHERE role_title = ?", [roleTitle]);
  return ok(res, mapSignatory(row), "Signatory updated.");
});

// ── Per-bank certificate policy — which template + fields a bank's paper ────
// gets. Read by CERT_ACCESS roles (needed by create-certificate.html to drive
// its category auto-detect); written by Admin only, same split as signatories.
const mapBankConfig = (r: any) => ({
  id: r.id,
  bankName: r.bank_name,
  fullName: r.full_name,
  template: r.template,
  showChassis: !!r.show_chassis,
  showEngine: !!r.show_engine,
  showImei: !!r.show_imei,
  showTracker: !!r.show_tracker,
  maxImei: Number(r.max_imei),
  maxTracker: Number(r.max_tracker),
  sortOrder: Number(r.sort_order),
  isDefault: !!r.is_default,
  updatedAt: r.updated_at,
});

router.get("/bank-configs", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (_req, res) => {
  const rows = await pgAll("SELECT * FROM cert_bank_configs ORDER BY sort_order, bank_name");
  return ok(res, { data: rows.map(mapBankConfig) });
});

router.post("/bank-configs", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (req: AuthRequest, res) => {
  const parsed = certBankConfigSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  const id = uuidv4();
  const maxSort = await pgGet("SELECT COALESCE(MAX(sort_order), 0) as m FROM cert_bank_configs");
  try {
    await pgRun(
      `INSERT INTO cert_bank_configs (id, bank_name, full_name, template, show_chassis, show_engine, show_imei, show_tracker, max_imei, max_tracker, sort_order, is_default, updated_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?, ?)`,
      [id, d.bankName.trim(), d.fullName.trim(), d.template, d.showChassis, d.showEngine, d.showImei, d.showTracker,
       d.maxImei, d.maxTracker, d.sortOrder ?? (Number((maxSort as any)?.m || 0) + 10), req.user?.id, now, now]
    );
  } catch (error: any) {
    if (error?.code === "23505") return errorResponse(res, 409, "CONFLICT", "A bank with this name already exists.");
    return errorResponse(res, 500, "INTERNAL", "Failed to save bank configuration.");
  }
  invalidateCertificateCaches();
  auditLog(req, "CERT_BANK_CONFIG_CREATED", `cert_bank_config:${id}`, "Info", { bankName: d.bankName }).catch(console.error);
  const row = await pgGet("SELECT * FROM cert_bank_configs WHERE id = ?", [id]);
  return created(res, mapBankConfig(row), "Bank configuration added.");
});

router.patch("/bank-configs/:id", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (req: AuthRequest, res) => {
  const existing = await pgGet("SELECT * FROM cert_bank_configs WHERE id = ?", [req.params.id]);
  if (!existing) return errorResponse(res, 404, "NOT_FOUND", "Bank configuration not found.");
  const parsed = updateCertBankConfigSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  const setClauses: string[] = [];
  const params: any[] = [];
  const maybeSet = (col: string, val: any) => { if (val !== undefined) { setClauses.push(`${col} = ?`); params.push(val); } };
  maybeSet("bank_name", d.bankName?.trim());
  maybeSet("full_name", d.fullName?.trim());
  maybeSet("template", d.template);
  maybeSet("show_chassis", d.showChassis);
  maybeSet("show_engine", d.showEngine);
  maybeSet("show_imei", d.showImei);
  maybeSet("show_tracker", d.showTracker);
  maybeSet("max_imei", d.maxImei);
  maybeSet("max_tracker", d.maxTracker);
  maybeSet("sort_order", d.sortOrder);
  if (!setClauses.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No fields to update.");
  setClauses.push("updated_by_user_id = ?", "updated_at = ?");
  params.push(req.user?.id, now, req.params.id);
  try {
    await pgRun(`UPDATE cert_bank_configs SET ${setClauses.join(", ")} WHERE id = ?`, params);
  } catch (error: any) {
    if (error?.code === "23505") return errorResponse(res, 409, "CONFLICT", "A bank with this name already exists.");
    return errorResponse(res, 500, "INTERNAL", "Failed to update bank configuration.");
  }
  invalidateCertificateCaches();
  auditLog(req, "CERT_BANK_CONFIG_UPDATED", `cert_bank_config:${req.params.id}`, "Info", d).catch(console.error);
  const row = await pgGet("SELECT * FROM cert_bank_configs WHERE id = ?", [req.params.id]);
  return ok(res, mapBankConfig(row), "Bank configuration updated.");
});

router.delete("/bank-configs/:id", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (req: AuthRequest, res) => {
  const existing = await pgGet("SELECT * FROM cert_bank_configs WHERE id = ?", [req.params.id]);
  if (!existing) return errorResponse(res, 404, "NOT_FOUND", "Bank configuration not found.");
  if (existing.is_default) return errorResponse(res, 400, "VALIDATION_ERROR", "The default \"Others\" row can't be deleted, only edited.");
  await pgRun("DELETE FROM cert_bank_configs WHERE id = ?", [req.params.id]);
  invalidateCertificateCaches();
  auditLog(req, "CERT_BANK_CONFIG_DELETED", `cert_bank_config:${req.params.id}`, "Info", { bankName: existing.bank_name }).catch(console.error);
  return ok(res, { id: req.params.id }, "Bank configuration removed.");
});

// ── Get single certificate by ID (all editable fields + linked ticketId) ─────
router.get("/:id", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (req, res) => {
  const row = await pgGet(
    `SELECT id, serial_no, template, system_type, car_registration, model, date, name, color, phone,
            start_date, end_date, loan_duration_years, imei_1, imei_2, tracker_no_1, tracker_no_2,
            additional_devices_json, chassis_number, engine_number, partner_bank,
            printed_by_user_id, printed_by_name, printed_by_signature_url,
            authorized_by_name, authorized_by_role, authorized_by_signature_url,
            created_at, updated_at
     FROM certificates WHERE id = ?`,
    [req.params.id]
  );
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Certificate not found.");

  // Find the most recent installation ticket for this vehicle registration
  const ticketRow = await pgGet(
    `SELECT it.id AS ticket_id
     FROM installation_tickets it
     JOIN vi_installations vi ON vi.id = it.vi_installation_id
     WHERE UPPER(REPLACE(it.vehicle_registration, ' ', '')) = UPPER(REPLACE(?, ' ', ''))
       AND vi.completed_at IS NOT NULL
     ORDER BY vi.completed_at DESC LIMIT 1`,
    [row.car_registration]
  ).catch(() => null);

  return ok(res, {
    id: row.id,
    serialNo: row.serial_no,
    template: row.template || "finemark",
    systemType: row.system_type,
    carRegistration: row.car_registration,
    model: row.model,
    date: row.date,
    name: row.name,
    color: row.color,
    phone: row.phone,
    startDate: row.start_date,
    endDate: row.end_date,
    loanDurationYears: row.loan_duration_years,
    imei1: row.imei_1,
    imei2: row.imei_2,
    trackerNo1: row.tracker_no_1,
    trackerNo2: row.tracker_no_2,
    additionalDevices: (() => { try { return row.additional_devices_json ? JSON.parse(row.additional_devices_json) : []; } catch { return []; } })(),
    chassisNumber: row.chassis_number,
    engineNumber: row.engine_number,
    partnerBank: row.partner_bank,
    printedByUserId: row.printed_by_user_id,
    printedByName: row.printed_by_name,
    printedBySignatureUrl: row.printed_by_signature_url,
    authorizedByName: row.authorized_by_name,
    authorizedByRole: row.authorized_by_role,
    authorizedBySignatureUrl: row.authorized_by_signature_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ticketId: ticketRow?.ticket_id || null,
  });
});

router.get("/:id/pdf", requireAuth, requireRole(["Admin", "CertAdmin", "Executive", "Finance", "Sales", "BDM", "BDMCorporate", "KAM", "CorporateSales", "Telesales", "Technical", "Technician", "InventoryManager", "HR"]), async (req, res) => {
  const row = await pgGet("SELECT car_registration, pdf_base64 FROM certificates WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Certificate not found.");
  const buffer = Buffer.from(row.pdf_base64, "base64");
  const filename = `Certificate_${row.car_registration || "vehicle"}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  return res.send(buffer);
});

router.post("/:id/email", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (req: AuthRequest, res) => {
  const parsed = emailCertificateSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const row = await pgGet("SELECT serial_no, car_registration, pdf_base64 FROM certificates WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Certificate not found.");
  const filename = `Certificate_${row.car_registration || "vehicle"}.pdf`;
  const subject = parsed.data.subject || `Certificate Of Installation - ${row.car_registration || row.serial_no}`;
  const message = parsed.data.message || `Please find attached the Certificate Of Installation for ${row.car_registration || row.serial_no}.`;
  const emailHtml = buildCertificateEmail({ vehicleReg: row.car_registration, serialNo: row.serial_no, message: parsed.data.message || undefined });
  try {
    await sendMail({ to: parsed.data.toEmail, subject, text: message, html: emailHtml, attachments: [{ filename, content: Buffer.from(row.pdf_base64, "base64"), contentType: "application/pdf" }] });
  } catch (error: any) {
    return errorResponse(res, 500, "EMAIL_FAILED", error?.message || "Failed to send email.");
  }
  auditLog(req, "CERTIFICATE_EMAILED", `certificate:${req.params.id}`, "Info", { serialNo: row.serial_no, toEmail: parsed.data.toEmail.replace(/(.{2}).+(@.+)/, "$1***$2") }).catch(console.error);
  return ok(res, { message: "Email sent" });
});

// ── Regenerate / update PDF only (Admin, Technical, Sales) ───────────────────
router.patch("/:id/pdf", requireAuth, requireRole(["Admin", "CertAdmin", "Technical", "Sales"]), async (req: AuthRequest, res) => {
  const { pdfBase64 } = req.body;
  if (!pdfBase64) return errorResponse(res, 400, "VALIDATION_ERROR", "pdfBase64 is required.");
  const cert = await pgGet("SELECT id, serial_no, car_registration FROM certificates WHERE id = ?", [req.params.id]);
  if (!cert) return errorResponse(res, 404, "NOT_FOUND", "Certificate not found.");
  const now = new Date().toISOString();
  await pgRun("UPDATE certificates SET pdf_base64 = ?, updated_at = ? WHERE id = ?", [pdfBase64, now, cert.id]);
  invalidateCertificateCaches();
  auditLog(req, "CERTIFICATE_PDF_REGENERATED", `certificate:${cert.id}`, "Info", { serialNo: cert.serial_no, carRegistration: cert.car_registration }).catch(console.error);
  return ok(res, { id: cert.id, updatedAt: now }, "Certificate PDF updated.");
});

// ── Update an existing certificate (all fields + regenerated PDF) ─────────────
router.patch("/:id", requireAuth, requireRole(ROLE_GROUPS.CERT_ACCESS), async (req: AuthRequest, res) => {
  const existing = await pgGet("SELECT id FROM certificates WHERE id = ?", [req.params.id]);
  if (!existing) return errorResponse(res, 404, "NOT_FOUND", "Certificate not found.");
  const parsed = updateCertificateSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  const setClauses: string[] = [];
  const params: any[] = [];
  const maybeSet = (col: string, val: any) => { if (val !== undefined) { setClauses.push(`${col} = ?`); params.push(val); } };
  maybeSet("system_type", d.systemType);
  maybeSet("car_registration", d.carRegistration ? d.carRegistration.replace(/\s+/g, '').toUpperCase() : undefined);
  maybeSet("model", d.model);
  maybeSet("date", d.date);
  maybeSet("name", d.name);
  maybeSet("color", d.color ?? null);
  maybeSet("phone", d.phone);
  maybeSet("start_date", d.startDate);
  maybeSet("end_date", d.endDate);
  maybeSet("loan_duration_years", d.loanDurationYears);
  maybeSet("imei_1", d.imei1);
  maybeSet("imei_2", d.imei2 ?? null);
  maybeSet("tracker_no_1", d.trackerNo1);
  maybeSet("tracker_no_2", d.trackerNo2 ?? null);
  maybeSet("additional_devices_json", d.additionalDevices !== undefined ? (d.additionalDevices?.length ? JSON.stringify(d.additionalDevices) : null) : undefined);
  maybeSet("chassis_number", d.chassisNumber ?? null);
  maybeSet("engine_number", d.engineNumber ?? null);
  maybeSet("partner_bank", d.partnerBank ?? null);
  maybeSet("printed_by_user_id", d.printedByUserId ?? null);
  maybeSet("printed_by_name", d.printedByName ?? null);
  maybeSet("printed_by_signature_url", d.printedBySignatureUrl ?? null);
  maybeSet("authorized_by_name", d.authorizedByName ?? null);
  maybeSet("authorized_by_role", d.authorizedByRole ?? null);
  maybeSet("authorized_by_signature_url", d.authorizedBySignatureUrl ?? null);
  maybeSet("pdf_base64", d.pdfBase64);
  if (!setClauses.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No fields to update.");
  setClauses.push("updated_at = ?");
  params.push(now, req.params.id);
  await pgRun(`UPDATE certificates SET ${setClauses.join(", ")} WHERE id = ?`, params);
  invalidateCertificateCaches();
  auditLog(req, "CERTIFICATE_UPDATED", `certificate:${req.params.id}`, "Info", { carRegistration: d.carRegistration }).catch(console.error);
  return ok(res, { id: req.params.id, updatedAt: now }, "Certificate updated");
});

export default router;
