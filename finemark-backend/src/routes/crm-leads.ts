import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, hasCrmFullVisibility, ROLE_GROUPS } from "../middleware/rbac.js";
import { sendEmailViaGraph, createCalendarEvent, isGraphConfigured, MAILBOXES } from "../services/graphMailService.js";
import { sendSms, isSmsConfigured } from "../services/smsService.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { encryptField } from "../services/cryptoService.js";
import { IdGenerator } from "../utils/idGenerator.js";
import { findDuplicateCustomers } from "../services/customerDedupeService.js";
import { invalidateCustomerCaches } from "../services/customerCacheService.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();

// Stage One "Customer Tier" — deliberately distinct from the `segment` column,
// which stays hardcoded "Corporate" (Retail-vs-Corporate lead type) regardless.
const CUSTOMER_SEGMENTS = ["SME", "Mid-Market", "Enterprise", "Government/Parastatal"];

// ── File upload setup ─────────────────────────────────────────────────────────
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads/lead-attachments");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg","image/png","image/gif","image/webp","application/pdf",
      "application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "audio/mpeg","audio/mp4","audio/ogg","audio/webm","audio/wav","audio/x-m4a",
      "video/mp4","text/plain",
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type ${file.mimetype} not allowed`));
  },
});

// ── Table bootstrap ───────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_leads (
    id TEXT PRIMARY KEY,
    lead_no TEXT UNIQUE NOT NULL,
    lead_source TEXT NOT NULL,
    customer_type TEXT NOT NULL DEFAULT 'new_customer',
    service_requested TEXT NOT NULL DEFAULT '[]',
    sales_rep_id TEXT NOT NULL,
    sales_rep_email TEXT,
    lead_date TEXT NOT NULL,
    lead_notes TEXT,
    status TEXT NOT NULL DEFAULT 'New',
    customer_id TEXT,
    customer_name TEXT,
    email TEXT,
    phone TEXT,
    id_number TEXT,
    company_name TEXT,
    address TEXT,
    account_manager_id TEXT,
    converted_at TEXT,
    converted_to_quote_id TEXT,
    disqualified_reason TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[crm_leads] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_leads_customer ON crm_leads(customer_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_leads_status ON crm_leads(status)`, []).catch(() => {});

// ── Migrate: product category + interested products columns ─────────────────
setTimeout(async () => {
  for (const col of [
    "product_category_id TEXT",
    "product_category_name TEXT",
    "products_interested TEXT NOT NULL DEFAULT '[]'",
    "partner_id TEXT",
    "partner_name TEXT",
    "assigned_to_id TEXT",
    "assigned_to_email TEXT",
    "lead_owner_role TEXT",
    "fleet_size INTEGER",
    "segment TEXT NOT NULL DEFAULT 'Corporate'",
    "installation_financer TEXT",
    "location_name TEXT",
    "installation_county TEXT",
    "installation_contact_name TEXT",
    "installation_contact_phone TEXT",
    "location_description TEXT",
    "location_notes TEXT",
    // Corporate Lead Redesign — Phase 1 (Stage One capture)
    "product_category_id_secondary TEXT",
    "product_category_name_secondary TEXT",
    "customer_segment TEXT",
    "expected_close_date TEXT",
  ]) {
    await pgRun(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS ${col}`, []).catch(() => {});
  }
}, 1500);

// ── Corporate lead vehicles (multiple per lead) ───────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_lead_vehicles (
    id                 TEXT PRIMARY KEY,
    lead_id            TEXT NOT NULL,
    registration_known BOOLEAN NOT NULL DEFAULT FALSE,
    registration       TEXT,
    chassis_no         TEXT,
    make               TEXT,
    model              TEXT,
    year               TEXT,
    color              TEXT,
    engine_no          TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_lead_vehicles] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_lead_vehicles_lead ON crm_lead_vehicles(lead_id)`, []).catch(() => {});

// ── Corporate lead supporting documents ───────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_lead_documents (
    id          TEXT PRIMARY KEY,
    lead_id     TEXT NOT NULL,
    label       TEXT NOT NULL,
    notes       TEXT,
    file_name   TEXT,
    file_path   TEXT,
    file_size   INTEGER,
    mime_type   TEXT,
    uploaded_by TEXT,
    created_at  TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_lead_documents] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_lead_documents_lead ON crm_lead_documents(lead_id)`, []).catch(() => {});

pgRun(`
  CREATE TABLE IF NOT EXISTS crm_lead_conversations (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    notes TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'Phone call',
    interaction_date TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    created_by_name TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_lead_conversations] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_convs_lead ON crm_lead_conversations(lead_id)`, []).catch(() => {});

// ── Lead follow-up tasks table ────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_lead_followups (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    title TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT 'Call',
    scheduled_at TEXT NOT NULL,
    reminder_minutes INTEGER NOT NULL DEFAULT 60,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    completed_at TEXT,
    created_by_user_id TEXT NOT NULL,
    created_by_name TEXT,
    assigned_to_id TEXT,
    assigned_to_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_lead_followups] init:", e));
// Phase 3 — 3-party invite: picked per follow-up (never a stored lead-level default)
pgRun(`ALTER TABLE crm_lead_followups ADD COLUMN IF NOT EXISTS manager_user_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE crm_lead_followups ADD COLUMN IF NOT EXISTS manager_email TEXT`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_followups_lead ON crm_lead_followups(lead_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_followups_scheduled ON crm_lead_followups(scheduled_at)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_followups_status ON crm_lead_followups(status)`, []).catch(() => {});

// ── Warning-cron dedupe table (Phase 2) — mirrors invoice_reminders' role for
// the invoice reminder cron: same lead+warning shouldn't re-notify within 24h.
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_lead_warning_notifications (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    warning_type TEXT NOT NULL,
    recipient TEXT NOT NULL,
    channel TEXT NOT NULL,
    sent_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_lead_warning_notifications] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_warn_lead ON crm_lead_warning_notifications(lead_id, warning_type)`, []).catch(() => {});

// ── Follow-up reminder dedupe table (Phase 3) — each of the 3 tiers (3 days /
// 24 hours / 2 hours before) fires exactly once per recipient per follow-up,
// a one-time existence check rather than the warning cron's 24h rolling window.
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_lead_followup_reminders (
    id TEXT PRIMARY KEY,
    followup_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    recipient TEXT NOT NULL,
    channel TEXT NOT NULL,
    sent_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_lead_followup_reminders] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_lead_fu_reminders ON crm_lead_followup_reminders(followup_id, tier)`, []).catch(() => {});

// ── Helpers ──────────────────────────────────────────────────────────────────
function nextLeadNo(): string {
  return IdGenerator.generateId("lead");
}

function mapLead(row: any) {
  return {
    id: row.id,
    leadNo: row.lead_no,
    leadSource: row.lead_source,
    customerType: row.customer_type,
    serviceRequested: (() => { try { return JSON.parse(row.service_requested || "[]"); } catch { return []; } })(),
    salesRepId: row.sales_rep_id,
    salesRepName: row.sales_rep_name || null,
    salesRepEmail: row.sales_rep_email,
    leadDate: row.lead_date,
    leadNotes: row.lead_notes,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    email: row.email,
    phone: row.phone,
    idNumber: row.id_number,
    companyName: row.company_name,
    address: row.address,
    accountManagerId: row.account_manager_id,
    convertedAt: row.converted_at,
    convertedToQuoteId: row.converted_to_quote_id,
    disqualifiedReason: row.disqualified_reason,
    createdByUserId: row.created_by_user_id,
    productCategoryId: row.product_category_id,
    productCategoryName: row.product_category_name,
    productCategoryIdSecondary: row.product_category_id_secondary || null,
    productCategoryNameSecondary: row.product_category_name_secondary || null,
    customerSegment: row.customer_segment || null,
    expectedCloseDate: row.expected_close_date || null,
    productsInterested: (() => { try { return JSON.parse(row.products_interested || "[]"); } catch { return []; } })(),
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    assignedToId: row.assigned_to_id,
    assignedToEmail: row.assigned_to_email,
    leadOwnerRole: row.lead_owner_role,
    fleetSize: row.fleet_size ?? null,
    segment: row.segment || "Corporate",
    installationFinancer: row.installation_financer || null,
    locationName: row.location_name || null,
    installationCounty: row.installation_county || null,
    installationContactName: row.installation_contact_name || null,
    installationContactPhone: row.installation_contact_phone || null,
    locationDescription: row.location_description || null,
    locationNotes: row.location_notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLeadVehicle(row: any) {
  return {
    id: row.id,
    leadId: row.lead_id,
    registrationKnown: !!row.registration_known,
    registration: row.registration || null,
    chassisNo: row.chassis_no || null,
    make: row.make || null,
    model: row.model || null,
    year: row.year || null,
    color: row.color || null,
    engineNo: row.engine_no || null,
    createdAt: row.created_at,
  };
}

function mapLeadDocument(row: any) {
  return {
    id: row.id,
    leadId: row.lead_id,
    label: row.label,
    notes: row.notes || null,
    fileName: row.file_name || null,
    fileUrl: row.file_path ? `/uploads/lead-attachments/${row.file_path}` : null,
    fileSize: row.file_size ?? null,
    mimeType: row.mime_type || null,
    uploadedBy: row.uploaded_by || null,
    createdAt: row.created_at,
  };
}

function mapFollowup(row: any) {
  return {
    id: row.id,
    leadId: row.lead_id,
    title: row.title,
    taskType: row.task_type,
    scheduledAt: row.scheduled_at,
    reminderMinutes: row.reminder_minutes,
    notes: row.notes,
    status: row.status,
    completedAt: row.completed_at,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    assignedToId: row.assigned_to_id,
    assignedToName: row.assigned_to_name,
    managerUserId: row.manager_user_id || null,
    managerEmail: row.manager_email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Team-scope helper ─────────────────────────────────────────────────────────
// Corporate team: CorporateSales role (single BDMCorporate manager today, so a
// role-based check is still an accurate proxy for "my team").
const CORP_LEAD_ROLES    = ["CorporateSales", "BDMCorporate"];

// Retail is now split across multiple regional BDMs (e.g. Janet Muthui /
// Nancy Ngethe), each with their own distinct set of direct-report Sales
// officers — a role-based "any BDM sees every retail rep" check would leak
// one manager's team into the other's view. Resolved live from
// hr_employees.manager_id instead of a fixed role list, so HR is the single
// source of truth for who's on which manager's team.
const RETAIL_TEAM_SUBQUERY = `
  SELECT e.user_account_id FROM hr_employees e
  JOIN hr_employees mgr ON mgr.id = e.manager_id
  WHERE mgr.user_account_id = ? AND e.user_account_id IS NOT NULL AND e.status = 'Active'
`;

/** Returns the SQL clause + params needed to scope a lead list to a BDM's team. */
function teamLeadScope(role: string, userId: string): { clause: string | null; params: any[] } {
  if (["Admin", "Executive"].includes(role)) return { clause: null, params: [] };
  if (role === "BDM") {
    return { clause: `(l.sales_rep_id IN (${RETAIL_TEAM_SUBQUERY}) OR l.sales_rep_id = ?)`, params: [userId, userId] };
  }
  if (role === "BDMCorporate") {
    const placeholders = CORP_LEAD_ROLES.map(() => "?").join(",");
    return { clause: `(l.lead_owner_role IN (${placeholders}) OR l.sales_rep_id = ?)`, params: [...CORP_LEAD_ROLES, userId] };
  }
  // Individual reps: own or assigned
  return { clause: "(l.sales_rep_id = ? OR COALESCE(l.assigned_to_id,'') = ?)", params: [userId, userId] };
}

/** Returns true when a BDM role can manage (qualify/disqualify/convert) the given lead. */
async function bdmCanManageLead(role: string, userId: string, lead: any): Promise<boolean> {
  if (["Admin", "Executive"].includes(role)) return true;
  if (lead.sales_rep_id === userId) return true;
  if (role === "BDM") {
    const row = await pgGet(
      `SELECT 1 FROM hr_employees e JOIN hr_employees mgr ON mgr.id = e.manager_id
       WHERE mgr.user_account_id = ? AND e.user_account_id = ? AND e.status = 'Active'`,
      [userId, lead.sales_rep_id]
    );
    return !!row;
  }
  if (role === "BDMCorporate") return CORP_LEAD_ROLES.includes(lead.lead_owner_role);
  return false;
}

// ── GET / ─ list all leads ───────────────────────────────────────────────────
router.get(
  "/",
  requireAuth,
  async (req: AuthRequest, res) => {
    const { page = "1", pageSize = "50", search = "", status, salesRepId, customerId } = req.query as any;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
    const offset = (pageNum - 1) * sizeNum;

    const filters: string[] = ["l.deleted_at IS NULL"];
    const params: any[] = [];

    // Scope visibility: Admin/Executive see all; BDM sees retail team; BDMCorporate sees corporate team; reps see own/assigned
    const { clause: teamClause, params: teamParams } = teamLeadScope(req.user!.role, req.user!.id);
    if (teamClause) { filters.push(teamClause); params.push(...teamParams); }

    if (search) {
      filters.push("(l.lead_no ILIKE ? OR l.customer_name ILIKE ? OR l.email ILIKE ? OR l.phone ILIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status)     { filters.push("l.status = ?");         params.push(status); }
    if (salesRepId) { filters.push("l.sales_rep_id = ?");   params.push(salesRepId); }
    if (customerId) { filters.push("l.customer_id = ?");    params.push(customerId); }

    // Phase 2 warnings — computed as boolean flags in SQL (correlated EXISTS
    // checks against conversations/followups) rather than N+1 app-level
    // queries per row; converted to message strings below.
    const nowIso = new Date().toISOString();
    const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString();
    const cutoff7dActivity = new Date(Date.now() - 7 * 86400000).toISOString();
    const in7dCloseDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const todayDate = nowIso.slice(0, 10);
    const warningParams = [in7dCloseDate, todayDate, cutoff7dActivity, cutoff7dActivity, cutoff48h];

    const where = `WHERE ${filters.join(" AND ")}`;
    const rows = await pgAll(
      `SELECT l.*, u.name AS sales_rep_name,
        (l.status = 'Qualified' AND l.expected_close_date IS NOT NULL
          AND l.expected_close_date <= ? AND l.expected_close_date >= ?
          AND NOT EXISTS (SELECT 1 FROM crm_lead_conversations c WHERE c.lead_id = l.id AND c.created_at >= ?)
          AND NOT EXISTS (SELECT 1 FROM crm_lead_followups f WHERE f.lead_id = l.id AND f.created_at >= ?)
        ) AS warn_nearing_close_no_activity,
        (l.status = 'New' AND l.created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM crm_lead_conversations c WHERE c.lead_id = l.id)
          AND NOT EXISTS (SELECT 1 FROM crm_lead_followups f WHERE f.lead_id = l.id)
        ) AS warn_new_no_followup
       FROM crm_leads l LEFT JOIN users u ON u.id = l.sales_rep_id
       ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
      [...warningParams, ...params, sizeNum, offset]
    );
    const totalRow = await pgGet(`SELECT COUNT(*) as total FROM crm_leads l ${where}`, params);

    auditLog(req, "LEADS_LISTED", "crm_leads", "Info", { status, salesRepId }).catch(console.error);
    const data = rows.map((r: any) => {
      const warnings: string[] = [];
      if (r.warn_nearing_close_no_activity) warnings.push("Nearing expected close date with no activity in the last 7 days.");
      if (r.warn_new_no_followup) warnings.push("New lead with no follow-up logged in over 48 hours.");
      return { ...mapLead(r), warnings };
    });
    return ok(res, { data, meta: { total: Number(totalRow?.total ?? 0) } });
  }
);

// ── GET /warnings/summary — counts for the leads-page stat tile ──────────────
// Must be registered before "/:id" so "warnings" doesn't get captured as an id.
router.get(
  "/warnings/summary",
  requireAuth,
  async (req: AuthRequest, res) => {
    const { clause: teamClause, params: teamParams } = teamLeadScope(req.user!.role, req.user!.id);
    const filters: string[] = ["l.deleted_at IS NULL"];
    const params: any[] = [];
    if (teamClause) { filters.push(teamClause); params.push(...teamParams); }
    const where = `WHERE ${filters.join(" AND ")}`;

    const nowIso = new Date().toISOString();
    const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString();
    const cutoff7dActivity = new Date(Date.now() - 7 * 86400000).toISOString();
    const in7dCloseDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const todayDate = nowIso.slice(0, 10);

    const row = await pgGet(
      `SELECT
        COUNT(*) FILTER (WHERE l.status = 'Qualified' AND l.expected_close_date IS NOT NULL
          AND l.expected_close_date <= ? AND l.expected_close_date >= ?
          AND NOT EXISTS (SELECT 1 FROM crm_lead_conversations c WHERE c.lead_id = l.id AND c.created_at >= ?)
          AND NOT EXISTS (SELECT 1 FROM crm_lead_followups f WHERE f.lead_id = l.id AND f.created_at >= ?)
        ) AS nearing_close_no_activity,
        COUNT(*) FILTER (WHERE l.status = 'New' AND l.created_at <= ?
          AND NOT EXISTS (SELECT 1 FROM crm_lead_conversations c WHERE c.lead_id = l.id)
          AND NOT EXISTS (SELECT 1 FROM crm_lead_followups f WHERE f.lead_id = l.id)
        ) AS new_no_followup
       FROM crm_leads l ${where}`,
      [in7dCloseDate, todayDate, cutoff7dActivity, cutoff7dActivity, cutoff48h, ...params]
    );
    const nearingCloseNoActivity = Number(row?.nearing_close_no_activity ?? 0);
    const newNoFollowup = Number(row?.new_no_followup ?? 0);
    return ok(res, { data: {
      nearingCloseNoActivity, newNoFollowup, total: nearingCloseNoActivity + newNoFollowup,
    } });
  }
);

// Follow-up "manager" pool — Admin/Executive/BDM/BDMCorporate/CorporateSales.
// Purpose-built rather than reusing GET /users?role=, which hard-restricts
// non-Admin/BDM callers to role=Sales only via its own BD_ROLES allowlist.
const FOLLOWUP_MANAGER_ROLES = ["Admin", "Executive", "BDM", "BDMCorporate", "CorporateSales"];

// ── GET /managers — pool for the follow-up "Manager responsible" picker ──────
// Must be registered before "/:id" so "managers" doesn't get captured as an id.
router.get(
  "/managers",
  requireAuth,
  async (req: AuthRequest, res) => {
    const placeholders = FOLLOWUP_MANAGER_ROLES.map(() => "?").join(",");
    const managers = await pgAll(
      `SELECT id, name, email, role FROM users WHERE role IN (${placeholders}) AND status != 'Disabled' ORDER BY name`,
      FOLLOWUP_MANAGER_ROLES
    );

    // Default: the caller's real HR-recorded manager, when that manager also
    // holds a qualifying role today — otherwise null (degrades to a blank pick,
    // never a silently-wrong default). Covers the case where the caller has no
    // HR record at all (e.g. a test/dummy account) just as gracefully.
    let defaultManagerId: string | null = null;
    const hrLink = await pgGet(
      `SELECT m.user_account_id AS manager_user_id
       FROM hr_employees e JOIN hr_employees m ON m.id = e.manager_id
       WHERE e.user_account_id = ?`,
      [req.user!.id]
    ).catch(() => null);
    if (hrLink?.manager_user_id && managers.some((m: any) => m.id === hrLink.manager_user_id)) {
      defaultManagerId = hrLink.manager_user_id;
    }

    return ok(res, { data: {
      managers: managers.map((m: any) => ({ id: m.id, name: m.name, email: m.email, role: m.role })),
      defaultManagerId,
    } });
  }
);

// ── POST / ─ create lead ─────────────────────────────────────────────────────
// Any authenticated staff member can create a lead; sales_rep_id is always set
// to the creator for attribution — only Admin may delegate credit via salesRepId.
router.post(
  "/",
  requireAuth,
  async (req: AuthRequest, res) => {
    const {
      leadSource, customerType = "new_customer", serviceRequested = [],
      salesRepId, salesRepEmail, leadDate, leadNotes,
      customerId, customerName, email, phone, idNumber,
      companyName, address, accountManagerId,
      productCategoryId, productCategoryIdSecondary, productsInterested = [],
      partnerId, fleetSize, installationFinancer,
      locationName, installationCounty, installationContactName, installationContactPhone,
      locationDescription, locationNotes, vehicles = [],
      customerSegment, expectedCloseDate,
    } = req.body;

    if (!leadSource)   return errorResponse(res, 400, "MISSING_FIELD", "leadSource is required.");
    if (!leadDate)     return errorResponse(res, 400, "MISSING_FIELD", "leadDate is required.");
    // Stage One capture: location/installation-contact fields moved to Stage Two
    // (vehicle-register.html) — no longer required at lead capture.
    if (!expectedCloseDate)
      return errorResponse(res, 400, "MISSING_FIELD", "expectedCloseDate is required.");
    if (customerSegment && !CUSTOMER_SEGMENTS.includes(customerSegment))
      return errorResponse(res, 400, "INVALID_FIELD", `customerSegment must be one of: ${CUSTOMER_SEGMENTS.join(", ")}.`);
    // Only applies to new_customer — an existing_customer lead's contact info
    // already lives on the linked customer record, not re-collected here.
    if (customerType === "new_customer" && !email?.trim() && !phone?.trim())
      return errorResponse(res, 400, "MISSING_FIELD", "At least one of phone or email is required.");

    // A not-yet-registered vehicle still needs a VIN/chassis number — enforced
    // regardless of what the client sends. Registration itself is optional.
    const vehicleList = Array.isArray(vehicles) ? vehicles : [];
    for (const v of vehicleList) {
      const isRegistered = v?.registrationKnown !== false;
      if (!isRegistered && !String(v?.chassisNo || "").trim())
        return errorResponse(res, 400, "MISSING_FIELD", "Vehicle VIN/chassis number is required for a not-yet-registered vehicle.");
    }

    // If new_customer, name is required
    if (customerType === "new_customer" && !customerName)
      return errorResponse(res, 400, "MISSING_FIELD", "customerName is required for new customers.");

    // If existing_customer, customerId must be supplied
    if (customerType === "existing_customer" && !customerId)
      return errorResponse(res, 400, "MISSING_FIELD", "customerId is required for existing customers.");

    // Resolve customer name from existing customer if needed
    let resolvedCustomerName = customerName;
    if (customerType === "existing_customer" && customerId) {
      const cust = await pgGet(
        `SELECT c.id,
                COALESCE(i.full_name, corp.company_name) as display_name
         FROM crm_customers c
         LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
         LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
         WHERE c.id = ? AND c.deleted_at IS NULL`,
        [customerId]
      );
      if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Customer not found.");
      resolvedCustomerName = cust.display_name;
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    const leadNo = nextLeadNo();

    // Resolve product category name
    let productCategoryName: string | null = null;
    if (productCategoryId) {
      const cat = await pgGet("SELECT name FROM inv_product_categories WHERE id = ?", [productCategoryId]);
      productCategoryName = cat?.name ?? null;
    }
    let productCategoryNameSecondary: string | null = null;
    if (productCategoryIdSecondary) {
      const cat2 = await pgGet("SELECT name FROM inv_product_categories WHERE id = ?", [productCategoryIdSecondary]);
      productCategoryNameSecondary = cat2?.name ?? null;
    }

    // Resolve partner name
    let resolvedPartnerName: string | null = null;
    if (partnerId) {
      const p = await pgGet("SELECT name FROM partners WHERE id = ? AND deleted_at IS NULL", [partnerId]);
      resolvedPartnerName = p?.name ?? null;
    }

    // Attribution: Admin may delegate credit via salesRepId body param;
    // all other roles are always attributed to themselves (the creator).
    const effectiveSalesRepId    = req.user!.role === "Admin" ? (salesRepId || req.user!.id) : req.user!.id;
    const effectiveSalesRepEmail = req.user!.role === "Admin" ? (salesRepEmail || req.user!.email) : req.user!.email;

    const fleetSizeVal = fleetSize != null ? parseInt(String(fleetSize), 10) || null : null;

    await pgRun(
      `INSERT INTO crm_leads
         (id, lead_no, lead_source, customer_type, service_requested, sales_rep_id, sales_rep_email,
          lead_date, lead_notes, status, customer_id, customer_name, email, phone, id_number,
          company_name, address, account_manager_id, product_category_id, product_category_name,
          products_interested, partner_id, partner_name, created_by_user_id, lead_owner_role, fleet_size,
          segment, installation_financer, location_name, installation_county,
          installation_contact_name, installation_contact_phone, location_description, location_notes,
          product_category_id_secondary, product_category_name_secondary, customer_segment, expected_close_date,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, leadNo, leadSource, customerType,
        JSON.stringify(Array.isArray(serviceRequested) ? serviceRequested : [serviceRequested]),
        effectiveSalesRepId, effectiveSalesRepEmail,
        leadDate, leadNotes || null, "New",
        customerId || null, resolvedCustomerName || null, email || null, phone || null,
        idNumber || null, companyName || null, address || null, accountManagerId || null,
        productCategoryId || null, productCategoryName,
        JSON.stringify(Array.isArray(productsInterested) ? productsInterested : []),
        partnerId || null, resolvedPartnerName,
        req.user!.id, req.user!.role, fleetSizeVal,
        // Segment is always "Corporate" for leads raised through this route —
        // hard-enforced server-side regardless of what the client sends.
        "Corporate",
        // Location/installation-contact fields are now optional at capture time
        // (moved to Stage Two) — guard the .trim() calls accordingly.
        installationFinancer || null, locationName?.trim() || null, installationCounty || null,
        installationContactName?.trim() || null, installationContactPhone || null,
        locationDescription || null, locationNotes || null,
        productCategoryIdSecondary || null, productCategoryNameSecondary,
        customerSegment || null, expectedCloseDate,
        now, now,
      ]
    );

    // Propagate fleet size to the linked customer record (existing customers)
    if (fleetSizeVal && customerId) {
      pgRun(`UPDATE crm_customers SET fleet_size = ?, updated_at = ? WHERE id = ? AND (fleet_size IS NULL OR fleet_size = 0)`,
        [fleetSizeVal, now, customerId]).catch(() => {});
    }

    // Persist vehicles (0 or more per lead)
    for (const v of vehicleList) {
      const isRegistered = v?.registrationKnown !== false;
      await pgRun(
        `INSERT INTO crm_lead_vehicles
           (id, lead_id, registration_known, registration, chassis_no, make, model, year, color, engine_no, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          uuidv4(), id, isRegistered,
          isRegistered ? String(v.registration).trim().toUpperCase() : null,
          v?.chassisNo ? String(v.chassisNo).trim().toUpperCase() : null,
          v?.make || null, v?.model || null, v?.year ? String(v.year) : null,
          v?.color || null, v?.engineNo || null, now, now,
        ]
      );
    }

    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ?", [id]);
    auditLog(req, "LEAD_CREATED", "crm_leads", "Info", { leadNo, customerId, leadSource, vehicleCount: vehicleList.length }).catch(console.error);
    return created(res, mapLead(lead), "Lead created.");
  }
);

// ── GET /:id ─ get lead detail ───────────────────────────────────────────────
router.get(
  "/:id",
  requireAuth,
  async (req: AuthRequest, res) => {
    const lead = await pgGet(
      `SELECT l.*, u.name AS sales_rep_name FROM crm_leads l LEFT JOIN users u ON u.id = l.sales_rep_id WHERE l.id = ? AND l.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");

    // Scope: Admin/Executive see any; BDM sees retail team; BDMCorporate sees corporate team; reps see own/assigned
    const { clause: teamClause, params: teamParams } = teamLeadScope(req.user!.role, req.user!.id);
    if (teamClause) {
      // Check lead matches team scope
      const ownOrAssigned = lead.sales_rep_id === req.user!.id || lead.assigned_to_id === req.user!.id;
      const inTeam = ["BDM","BDMCorporate"].includes(req.user!.role)
        ? await bdmCanManageLead(req.user!.role, req.user!.id, lead)
        : ownOrAssigned;
      if (!inTeam) return errorResponse(res, 403, "FORBIDDEN", "Access denied.");
    }

    const [vehicles, documents] = await Promise.all([
      pgAll("SELECT * FROM crm_lead_vehicles WHERE lead_id = ? ORDER BY created_at", [lead.id]),
      pgAll("SELECT * FROM crm_lead_documents WHERE lead_id = ? ORDER BY created_at", [lead.id]),
    ]);

    return ok(res, { data: { ...mapLead(lead), vehicles: vehicles.map(mapLeadVehicle), documents: documents.map(mapLeadDocument) } });
  }
);

// ── PATCH /:id ─ update lead ─────────────────────────────────────────────────
router.patch(
  "/:id",
  requireAuth,
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    // Non-admin/BDM can only edit leads they created or are assigned to
    const canEdit = req.user!.role === "Admin"
      || await bdmCanManageLead(req.user!.role, req.user!.id, lead)
      || lead.sales_rep_id === req.user!.id
      || lead.assigned_to_id === req.user!.id;
    if (!canEdit) return errorResponse(res, 403, "FORBIDDEN", "Cannot edit this lead.");

    const allowed = [
      "lead_source","customer_type","service_requested","lead_date","lead_notes",
      "customer_name","email","phone","id_number","company_name","address","account_manager_id",
      "partner_id","partner_name",
      // Stage One (capture) fields, editable post-creation
      "product_category_id_secondary","product_category_name_secondary","customer_segment","expected_close_date",
      // Stage Two (vehicle registration & installation) fields — moved off the New Lead
      // form onto vehicle-register.html, persisted back onto the lead via this route
      "location_name","installation_county","installation_contact_name","installation_contact_phone",
      "location_description","location_notes","fleet_size",
    ];
    // Admin and BDM roles can reassign the working rep via PATCH
    if (["Admin", "BDM", "BDMCorporate"].includes(req.user!.role)) allowed.push("assigned_to_id", "assigned_to_email");
    const updates: string[] = [];
    const vals: any[] = [];

    // Auto-resolve partner_name when only partnerId is provided
    if (req.body.partnerId && !req.body.partnerName) {
      const p = await pgGet("SELECT name FROM partners WHERE id = ? AND deleted_at IS NULL", [req.body.partnerId]);
      req.body.partnerName = p?.name ?? "";
    }
    // Auto-resolve the secondary product category name when only the ID is provided
    if (req.body.productCategoryIdSecondary && !req.body.productCategoryNameSecondary) {
      const c = await pgGet("SELECT name FROM inv_product_categories WHERE id = ?", [req.body.productCategoryIdSecondary]);
      req.body.productCategoryNameSecondary = c?.name ?? "";
    }

    for (const key of allowed) {
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (req.body[camel] !== undefined) {
        updates.push(`${key} = ?`);
        vals.push(key === "service_requested" ? JSON.stringify(req.body[camel]) : req.body[camel]);
      }
    }
    if (!updates.length) return errorResponse(res, 400, "NO_CHANGES", "No updatable fields supplied.");
    updates.push("updated_at = ?");
    vals.push(new Date().toISOString(), req.params.id);

    await pgRun(`UPDATE crm_leads SET ${updates.join(", ")} WHERE id = ?`, vals);
    const updated = await pgGet("SELECT * FROM crm_leads WHERE id = ?", [req.params.id]);
    auditLog(req, "LEAD_UPDATED", "crm_leads", "Info", { leadId: req.params.id }).catch(console.error);
    return ok(res, { data: mapLead(updated!) });
  }
);

// ── POST /:id/qualify ─────────────────────────────────────────────────────────
router.post(
  "/:id/qualify",
  requireAuth,
  requireRole(["Admin", "BDM", "BDMCorporate", "CorporateSales", "Sales", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    // BDM roles can qualify their team's leads; reps only their own
    const canAct = await bdmCanManageLead(req.user!.role, req.user!.id, lead)
      || lead.sales_rep_id === req.user!.id
      || lead.assigned_to_id === req.user!.id;
    if (!canAct) return errorResponse(res, 403, "FORBIDDEN", "Not your lead.");
    if (lead.status !== "New") return errorResponse(res, 409, "INVALID_STATE", "Only New leads can be qualified.");

    await pgRun(`UPDATE crm_leads SET status = 'Qualified', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), req.params.id]);
    auditLog(req, "LEAD_QUALIFIED", "crm_leads", "Info", { leadId: req.params.id }).catch(console.error);
    return ok(res, { message: "Lead qualified." });
  }
);

// ── POST /:id/disqualify ──────────────────────────────────────────────────────
router.post(
  "/:id/disqualify",
  requireAuth,
  requireRole(["Admin", "BDM", "BDMCorporate", "CorporateSales", "Sales", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    // BDM roles can disqualify their team's leads; reps only their own
    const canAct = await bdmCanManageLead(req.user!.role, req.user!.id, lead)
      || lead.sales_rep_id === req.user!.id
      || lead.assigned_to_id === req.user!.id;
    if (!canAct) return errorResponse(res, 403, "FORBIDDEN", "Not your lead.");
    if (lead.status === "Converted") return errorResponse(res, 409, "INVALID_STATE", "Converted leads cannot be disqualified.");

    const { reason } = req.body;
    await pgRun(`UPDATE crm_leads SET status = 'Disqualified', disqualified_reason = ?, updated_at = ? WHERE id = ?`,
      [reason || null, new Date().toISOString(), req.params.id]);
    auditLog(req, "LEAD_DISQUALIFIED", "crm_leads", "Info", { leadId: req.params.id, reason }).catch(console.error);
    return ok(res, { message: "Lead disqualified." });
  }
);

// ── POST /:id/convert ─ convert to customer + quote ───────────────────────────
router.post(
  "/:id/convert",
  requireAuth,
  requireRole(["Admin", "BDM", "BDMCorporate", "CorporateSales", "Sales", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    // BDM roles can convert their team's leads; reps only their own
    const canAct = await bdmCanManageLead(req.user!.role, req.user!.id, lead)
      || lead.sales_rep_id === req.user!.id
      || lead.assigned_to_id === req.user!.id;
    if (!canAct) return errorResponse(res, 403, "FORBIDDEN", "Not your lead.");
    if (lead.status === "Converted") return errorResponse(res, 409, "ALREADY_CONVERTED", "Lead already converted.");

    const now = new Date().toISOString();
    let targetCustomerId = lead.customer_id;
    const { customerId: providedCustomerId } = req.body as { customerId?: string };

    // Sales rep registered the customer via the registration form — just link it
    if (providedCustomerId) {
      const cust = await pgGet(`SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL`, [providedCustomerId]);
      if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Provided customer not found.");
      targetCustomerId = providedCustomerId;
      await pgRun(`UPDATE crm_leads SET customer_id = ?, updated_at = ? WHERE id = ?`, [providedCustomerId, now, lead.id]);
    } else if (lead.customer_type === "new_customer" && !lead.customer_id) {
      // Unattended auto-create, same as retail-leads.ts's /submit — a
      // name+phone or name+email match silently links to the EXISTING
      // customer instead of inserting a duplicate. The interactive "Add
      // Customer" form (crm-customers.ts POST /register) is the one place
      // that blocks and asks a human to confirm/override instead.
      const dupMatches = await findDuplicateCustomers({
        name: lead.company_name || lead.customer_name, phone: lead.phone, email: lead.email,
      });

      if (dupMatches.length) {
        targetCustomerId = dupMatches[0].customerId;
        await pgRun(`UPDATE crm_leads SET customer_id = ?, updated_at = ? WHERE id = ?`, [targetCustomerId, now, lead.id]);
        await auditLog(req, "LEAD_CUSTOMER_AUTOLINKED", `crm_leads:${lead.id}`, "Info", {
          customerId: targetCustomerId, matchedOn: dupMatches[0].matchedOn,
        }).catch(console.error);
      } else {
        const custId   = uuidv4();
        const custType = lead.company_name ? "corporate" : "individual";

        // Generate non-sequential customer account number
        const accountNo = IdGenerator.generateId("customer");

        await pgRun(
          `INSERT INTO crm_customers (id, account_no, type, status, source, created_by_user_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [custId, accountNo, custType, "Active", lead.lead_source, req.user!.id, now, now]
        );

        if (lead.company_name) {
          // Corporate profile
          await pgRun(
            `INSERT INTO crm_corporate_profiles (id, customer_id, company_name, physical_address, created_at, updated_at)
             VALUES (?,?,?,?,?,?)`,
            [uuidv4(), custId, lead.company_name, lead.address || null, now, now]
          );
          // Primary contact person carrying the lead contact details
          await pgRun(
            `INSERT INTO crm_contact_persons (id, customer_id, name, phone_enc, email_enc, is_primary, is_billing, is_operations, created_at, updated_at)
             VALUES (?,?,?,?,?,1,0,0,?,?)`,
            [uuidv4(), custId, lead.customer_name || "Contact", encryptField(lead.phone), encryptField(lead.email), now, now]
          );
        } else {
          // Individual profile — sensitive fields stored encrypted
          await pgRun(
            `INSERT INTO crm_individual_profiles
               (id, customer_id, full_name, full_name_enc, national_id_enc, phone_enc, email_enc, address_enc, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              uuidv4(), custId,
              lead.customer_name || "",
              encryptField(lead.customer_name),
              encryptField(lead.id_number),
              encryptField(lead.phone),
              encryptField(lead.email),
              encryptField(lead.address),
              now, now,
            ]
          );
        }

        targetCustomerId = custId;
        await pgRun(`UPDATE crm_leads SET customer_id = ?, updated_at = ? WHERE id = ?`,
          [custId, now, lead.id]);
        invalidateCustomerCaches();
      }
    }

    // guard: if still no customer to link, bail out cleanly
    if (!targetCustomerId) {
      return errorResponse(res, 422, "NO_CUSTOMER", "No customer linked. Please register or select a customer first.");
    }

    // Carry the lead's captured fleet size onto the customer — previously dropped
    // silently on conversion. Only fills a blank/zero customer fleet_size so it
    // never overwrites a value someone has since corrected on the customer record.
    if (lead.fleet_size) {
      await pgRun(
        `UPDATE crm_customers SET fleet_size = ?, updated_at = ? WHERE id = ? AND (fleet_size IS NULL OR fleet_size = 0)`,
        [lead.fleet_size, now, targetCustomerId]
      ).catch(() => {});
    }

    await pgRun(
      `UPDATE crm_leads SET status = 'Converted', converted_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, req.params.id]
    );

    auditLog(req, "LEAD_CONVERTED", "crm_leads", "Info", { leadId: req.params.id, targetCustomerId }).catch(console.error);
    return ok(res, { data: { customerId: targetCustomerId }, message: "Lead converted to customer." });
  }
);

// ── GET /:id/conversations ────────────────────────────────────────────────────
function mapConversation(row: any) {
  return {
    id: row.id,
    leadId: row.lead_id,
    notes: row.notes,
    channel: row.channel,
    interactionDate: row.interaction_date,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    attachments: (() => { try { return JSON.parse(row.attachments || "[]"); } catch { return []; } })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get(
  "/:id/conversations",
  requireAuth,
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id, sales_rep_id, assigned_to_id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    const isGlobalViewer = hasCrmFullVisibility(req.user!.role);
    if (!isGlobalViewer && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Access denied.");
    const rows = await pgAll(
      "SELECT * FROM crm_lead_conversations WHERE lead_id = ? ORDER BY interaction_date DESC, created_at DESC",
      [req.params.id]
    );
    return ok(res, { data: rows.map(mapConversation) });
  }
);

// ── POST /:id/conversations ───────────────────────────────────────────────────
router.post(
  "/:id/conversations",
  requireAuth,
  upload.array("attachments", 10) as any,
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id, phone, customer_id, customer_name, sales_rep_id, assigned_to_id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    if (req.user!.role !== "Admin" && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Access denied.");
    const { notes, channel = "Phone call", interactionDate } = req.body;
    if (!notes?.trim()) return errorResponse(res, 400, "MISSING_FIELD", "notes is required.");

    // Logging an SMS interaction actually sends the SMS via Telkosh — the log
    // is meant to reflect a real outbound message, not just a note-to-self.
    let sendWarning: string | null = null;
    if (channel === "SMS") {
      if (!lead.phone) {
        sendWarning = "Logged, but this lead has no phone number on file — SMS was not sent.";
      } else if (!isSmsConfigured()) {
        sendWarning = "Logged, but SMS is not configured.";
      } else {
        try {
          const results = await sendSms([lead.phone], notes.trim());
          if (!results.some(r => r.status === "Success")) sendWarning = "Logged, but the SMS failed to send.";
        } catch (err: any) {
          sendWarning = "Logged, but the SMS failed to send.";
          console.error("[lead-conversation] SMS error:", err.message);
        }
      }
    }

    const files = (req.files as Express.Multer.File[]) || [];
    const attachments = files.map(f => ({
      filename: f.filename,
      originalName: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
      url: `/uploads/lead-attachments/${f.filename}`,
    }));
    const now = new Date().toISOString();
    const id = uuidv4();
    await pgRun(
      `INSERT INTO crm_lead_conversations
         (id, lead_id, notes, channel, interaction_date, created_by_user_id, created_by_name, attachments, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        id, req.params.id, notes.trim(), channel,
        interactionDate || now.slice(0, 10),
        req.user!.id, req.user!.email,
        JSON.stringify(attachments), now, now,
      ]
    );
    auditLog(req, "LEAD_CONVERSATION_ADDED", "crm_lead_conversations", "Info", { leadId: req.params.id }).catch(console.error);

    // Mirror onto the linked customer's Communication Timeline (Customer 360)
    // so a conversation logged from the lead drawer is also visible there —
    // leads can be linked to a customer before conversion (existing_customer
    // leads) or after (converted_at), either way lead.customer_id is set.
    if (lead.customer_id) {
      await pgRun(
        `INSERT INTO crm_communication_logs
           (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email, contact_name, contacted_at, linked_ticket_id, created_at)
         VALUES (?, ?, ?, 'Outbound', ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          uuidv4(), lead.customer_id, channel,
          notes.trim().substring(0, 200), encryptField(notes.trim()),
          req.user!.id, req.user!.email,
          lead.customer_name || null,
          interactionDate || now, now,
        ]
      ).catch(err => console.error("[lead-conversation] mirror to crm_communication_logs failed:", err.message));
    }

    const row = await pgGet("SELECT * FROM crm_lead_conversations WHERE id = ?", [id]);
    return created(res, { data: mapConversation(row) }, sendWarning || (channel === "SMS" ? "SMS sent and logged." : "Conversation logged."));
  }
);

// ── POST /:id/documents ── attach a supporting document to a lead ────────────
// Secure: requires auth + ownership (creator, assignee, or Admin); file stored
// under the same protected uploads/lead-attachments directory as conversations.
router.post(
  "/:id/documents",
  requireAuth,
  upload.single("file") as any,
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id, sales_rep_id, assigned_to_id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    if (req.user!.role !== "Admin" && lead.sales_rep_id !== req.user!.id && lead.assigned_to_id !== req.user!.id)
      return errorResponse(res, 403, "FORBIDDEN", "Access denied.");

    const { label, notes } = req.body;
    if (!label?.trim()) return errorResponse(res, 400, "MISSING_FIELD", "label is required.");
    const file = req.file as Express.Multer.File | undefined;

    const now = new Date().toISOString();
    const id = uuidv4();
    await pgRun(
      `INSERT INTO crm_lead_documents
         (id, lead_id, label, notes, file_name, file_path, file_size, mime_type, uploaded_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        id, req.params.id, label.trim(), notes?.trim() || null,
        file?.originalname || null, file?.filename || null, file?.size ?? null, file?.mimetype || null,
        req.user!.id, now,
      ]
    );
    auditLog(req, "LEAD_DOCUMENT_ADDED", "crm_lead_documents", "Info", { leadId: req.params.id, label: label.trim() }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_lead_documents WHERE id = ?", [id]);
    return created(res, mapLeadDocument(row), "Document attached.");
  }
);

// ── POST /:id/assign ── assign lead to a Sales team member ──────────────────
// Admin, BDM (retail), BDMCorporate (corporate) can assign leads to their team members.
// The original lead creator (sales_rep_id) is preserved for attribution/credit.
router.post(
  "/:id/assign",
  requireAuth,
  requireRole(["Admin", "BDM", "BDMCorporate", "Sales", "TeamLead"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");

    // BDMs can only assign within their team scope
    if (!(await bdmCanManageLead(req.user!.role, req.user!.id, lead)) && !["Admin", "Sales", "TeamLead"].includes(req.user!.role))
      return errorResponse(res, 403, "FORBIDDEN", "You cannot assign this lead.");

    const { assignedToId } = req.body;
    if (!assignedToId) return errorResponse(res, 400, "MISSING_FIELD", "assignedToId is required.");

    const assignee = await pgGet("SELECT id, email, role FROM users WHERE id = ?", [assignedToId]);
    if (!assignee) return errorResponse(res, 404, "NOT_FOUND", "Assignee user not found.");
    const assignableRoles = ["Telesales", "FieldSales", "Sales", "CorporateSales", "Admin"];
    if (!assignableRoles.includes(assignee.role))
      return errorResponse(res, 422, "INVALID_ROLE", "Leads can only be assigned to sales team members.");

    const now = new Date().toISOString();
    await pgRun(
      `UPDATE crm_leads SET assigned_to_id = ?, assigned_to_email = ?, updated_at = ? WHERE id = ?`,
      [assignedToId, assignee.email, now, req.params.id]
    );
    auditLog(req, "LEAD_ASSIGNED", `crm_leads:${req.params.id}`, "Info",
      { assignedToId, assigneeEmail: assignee.email, assignedBy: req.user!.email }).catch(console.error);

    const updated = await pgGet("SELECT * FROM crm_leads WHERE id = ?", [req.params.id]);
    return ok(res, { data: mapLead(updated) }, `Lead assigned to ${assignee.email}.`);
  }
);

// ── GET /:id/followups ─────────────────────────────────────────────────────
router.get(
  "/:id/followups",
  requireAuth,
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    const rows = await pgAll(
      `SELECT * FROM crm_lead_followups WHERE lead_id = ? ORDER BY scheduled_at ASC`,
      [req.params.id]
    );
    return ok(res, { data: rows.map(mapFollowup) });
  }
);

// ── POST /:id/followups ────────────────────────────────────────────────────
router.post(
  "/:id/followups",
  requireAuth,
  requireRole(["Admin", "BDM", "BDMCorporate", "CorporateSales", "Sales", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");

    const { title, taskType, scheduledAt, reminderMinutes, notes, assignedToId, assignedToName, ccEmails, managerId } = req.body;
    if (!title?.trim()) return errorResponse(res, 400, "VALIDATION", "Title is required.");
    if (!scheduledAt) return errorResponse(res, 400, "VALIDATION", "Scheduled date/time is required.");

    // Validate ccEmails — must be an array of strings
    const ccList: string[] = Array.isArray(ccEmails)
      ? ccEmails.filter((e: any) => typeof e === "string" && e.includes("@")).slice(0, 20)
      : [];

    // Manager is picked per follow-up (see GET /managers' defaultManagerId for
    // the pre-fill) — resolve their email here so it's persisted, not re-looked-up.
    let managerEmail: string | null = null;
    if (managerId) {
      const mgr = await pgGet("SELECT email FROM users WHERE id = ?", [managerId]);
      managerEmail = mgr?.email ?? null;
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const user = req.user!;
    const createdByName = user.email;

    await pgRun(
      `INSERT INTO crm_lead_followups
        (id, lead_id, title, task_type, scheduled_at, reminder_minutes, notes, status,
         created_by_user_id, created_by_name, assigned_to_id, assigned_to_name,
         manager_user_id, manager_email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, title.trim(), taskType || "Call", scheduledAt,
       reminderMinutes ?? 60, notes || null, user.id, createdByName,
       assignedToId || null, assignedToName || null,
       managerId || null, managerEmail, now, now]
    );
    auditLog(req, "LEAD_FOLLOWUP_CREATED", "crm_lead_followups", "Info", { leadId: req.params.id, title }).catch(console.error);
    const row = await pgGet("SELECT * FROM crm_lead_followups WHERE id = ?", [id]);

    // ── Notify sales rep via email + O365 calendar ────────────────────────
    if (isGraphConfigured()) {
      const lead = await pgGet(
        "SELECT lead_no, customer_name, email, sales_rep_email, assigned_to_email FROM crm_leads WHERE id = ?",
        [req.params.id]
      );
      const recipientEmail = assignedToId
        ? (await pgGet("SELECT email FROM users WHERE id = ?", [assignedToId]))?.email
        : lead?.sales_rep_email;

      if (recipientEmail) {
        const dt = new Date(scheduledAt);
        const dtLabel = dt.toLocaleString("en-KE", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
          hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi",
        });
        const endDt = new Date(dt.getTime() + 60 * 60 * 1000).toISOString().slice(0, 19); // +1 hr

        // Email
        sendEmailViaGraph({
          fromMailbox: MAILBOXES.notification,
          to: recipientEmail,
          cc: ccList.length ? ccList : undefined,
          subject: `Follow-Up Reminder: ${title} — ${lead?.customer_name ?? ""}`,
          htmlBody: `<p>Hi,</p>
<p>A follow-up task has been booked for lead <strong>${lead?.lead_no ?? ""}</strong> — <strong>${lead?.customer_name ?? ""}</strong>.</p>
<table style="border-collapse:collapse;font-size:14px">
  <tr><td style="padding:4px 12px 4px 0;color:#555">Task</td><td><strong>${title}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555">Type</td><td>${taskType || "Call"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555">Scheduled</td><td>${dtLabel}</td></tr>
  ${notes ? `<tr><td style="padding:4px 12px 4px 0;color:#555">Notes</td><td>${notes}</td></tr>` : ""}
</table>
<p>Please ensure you are prepared for this follow-up.</p>
<p style="color:#888;font-size:12px">Finemark Tracking — CRM</p>`,
        }).catch(e => console.error("[followup] email error:", e.message));

        // Calendar event — invites the sales lead (customer), the manager
        // picked for this follow-up, and any free-typed CC addresses.
        createCalendarEvent({
          userEmail: recipientEmail,
          subject: `Follow-Up: ${title} — ${lead?.customer_name ?? ""}`,
          body: `<p>Lead: ${lead?.lead_no ?? ""} — ${lead?.customer_name ?? ""}</p><p>Type: ${taskType || "Call"}</p>${notes ? `<p>Notes: ${notes}</p>` : ""}`,
          startDateTime: scheduledAt.slice(0, 19),
          endDateTime: endDt,
          timeZone: "Africa/Nairobi",
          reminderMinutes: reminderMinutes ?? 60,
          attendees: [lead?.email, managerEmail, ...ccList].filter(Boolean) as string[],
        }).catch(e => console.error("[followup] calendar error:", e.message));
      }
    }

    return created(res, { data: mapFollowup(row) }, "Follow-up task created.");
  }
);

// ── PATCH /:id/followups/:fid ──────────────────────────────────────────────
router.patch(
  "/:id/followups/:fid",
  requireAuth,
  requireRole(["Admin", "BDM", "BDMCorporate", "CorporateSales", "Sales", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const row = await pgGet(
      "SELECT * FROM crm_lead_followups WHERE id = ? AND lead_id = ?",
      [req.params.fid, req.params.id]
    );
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Follow-up not found.");

    const { title, taskType, scheduledAt, reminderMinutes, notes, status, assignedToId, assignedToName } = req.body;
    const now = new Date().toISOString();
    const completedAt = status === "Completed" && row.status !== "Completed" ? now : row.completed_at;

    await pgRun(
      `UPDATE crm_lead_followups SET
        title = ?, task_type = ?, scheduled_at = ?, reminder_minutes = ?,
        notes = ?, status = ?, assigned_to_id = ?, assigned_to_name = ?,
        completed_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        title ?? row.title, taskType ?? row.task_type,
        scheduledAt ?? row.scheduled_at, reminderMinutes ?? row.reminder_minutes,
        notes ?? row.notes, status ?? row.status,
        assignedToId ?? row.assigned_to_id, assignedToName ?? row.assigned_to_name,
        completedAt, now, req.params.fid
      ]
    );
    auditLog(req, "LEAD_FOLLOWUP_UPDATED", "crm_lead_followups", "Info", { fid: req.params.fid, status }).catch(console.error);
    const updated = await pgGet("SELECT * FROM crm_lead_followups WHERE id = ?", [req.params.fid]);
    return ok(res, { data: mapFollowup(updated) });
  }
);

// ── DELETE /:id/followups/:fid ─────────────────────────────────────────────
router.delete(
  "/:id/followups/:fid",
  requireAuth,
  requireRole(["Admin", "BDM", "BDMCorporate", "CorporateSales", "Sales", "Telesales", "FieldSales"]),
  async (req: AuthRequest, res) => {
    const row = await pgGet(
      "SELECT id FROM crm_lead_followups WHERE id = ? AND lead_id = ?",
      [req.params.fid, req.params.id]
    );
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Follow-up not found.");
    await pgRun("DELETE FROM crm_lead_followups WHERE id = ?", [req.params.fid]);
    auditLog(req, "LEAD_FOLLOWUP_DELETED", "crm_lead_followups", "Info", { fid: req.params.fid }).catch(console.error);
    return ok(res, { message: "Follow-up deleted." });
  }
);

// ── GET /followups/upcoming (all upcoming follow-ups for current user) ──────
router.get(
  "/all/followups/upcoming",
  requireAuth,
  async (req: AuthRequest, res) => {
    const user = req.user!;
    const now = new Date().toISOString();
    const isAdmin = hasCrmFullVisibility(user.role);
    const whereUser = isAdmin ? "" : "AND (f.created_by_user_id = ? OR f.assigned_to_id = ?)";
    const params: any[] = isAdmin ? [now] : [now, user.id, user.id];
    const rows = await pgAll(
      `SELECT f.*, l.lead_no, l.customer_name
       FROM crm_lead_followups f
       JOIN crm_leads l ON l.id = f.lead_id
       WHERE f.scheduled_at >= ? AND f.status = 'Pending'
       ${whereUser}
       ORDER BY f.scheduled_at ASC
       LIMIT 50`,
      params
    );
    return ok(res, { data: rows.map(r => ({ ...mapFollowup(r), leadNo: r.lead_no, customerName: r.customer_name })) });
  }
);

// ── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const lead = await pgGet("SELECT id FROM crm_leads WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!lead) return errorResponse(res, 404, "NOT_FOUND", "Lead not found.");
    await pgRun(`UPDATE crm_leads SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), new Date().toISOString(), req.params.id]);
    auditLog(req, "LEAD_DELETED", "crm_leads", "Info", { leadId: req.params.id }).catch(console.error);
    return ok(res, { message: "Lead deleted." });
  }
);

export default router;
