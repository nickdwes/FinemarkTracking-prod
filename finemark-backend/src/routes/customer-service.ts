import { Router } from "express";
import { z } from "zod";
import { pgAll, pgGet, pgRun } from "../db.js";
import { archiveAll } from "../archiveDb.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { ok, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { encryptField, decryptField } from "../services/cryptoService.js";
import { sendSms, isSmsConfigured } from "../services/smsService.js";
import { resolveSalesScope } from "../services/salesScopeService.js";
import { runReport, idClause, scopeLabel } from "./sales-intelligence.js";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// Customer-service reporting is read-mostly and spans the whole post-sale
// journey (lead → vehicle → installation → tracking logins), so the audience
// is wider than sales: support and the technical/installation side need it to
// answer "what happened with this customer's vehicle". Row-level visibility is
// still narrowed per-user by resolveSalesScope below.
const CS_REPORT_ROLES = [
  "Admin", "Executive", "HR",
  "Support", "Operations",
  "Technical", "technical_manager", "InstallOffice", "CertAdmin",
  "Finance",
  "BDM", "BDMCorporate", "CorporateSales", "KAM", "Sales", "Telesales", "FieldSales",
];

// Service-side roles support every customer, so they see the whole book.
// Sales roles keep the existing sales ABAC (resolveSalesScope): a rep sees
// their own leads, a BDM their team's. Without this split a Finance/Support/
// CertAdmin user falls into resolveSalesScope's individual-contributor branch
// and the report comes back empty, because they never own a retail lead.
const CS_FULL_VISIBILITY_ROLES = [
  "Admin", "Executive", "HR", "Finance",
  "Support", "Operations", "Technical", "technical_manager", "InstallOffice", "CertAdmin",
];

router.use(requireAuth, requireRole(CS_REPORT_ROLES));

async function csScope(role: string, userId: string) {
  if (CS_FULL_VISIBILITY_ROLES.includes(role)) {
    return { scope: { userIds: null, emails: null }, label: "all" };
  }
  const scope = await resolveSalesScope(role, userId);
  return { scope, label: scopeLabel(role, scope) };
}

// Registrations are written inconsistently across the two databases (the live
// side was space-stripped in Aug 2026, the legacy archive was not), so every
// cross-database match normalises to upper-case, no-spaces.
const normReg = (s: unknown) => String(s ?? "").toUpperCase().replace(/\s+/g, "").trim();

/** Enough to recognise a login, not enough to use it. "honda4499" → "ho•••99". */
function maskSecret(s: string | null): string | null {
  if (!s) return null;
  if (s.length <= 4) return "•".repeat(s.length);
  return `${s.slice(0, 2)}•••${s.slice(-2)}`;
}

/**
 * Parses the username (and platform, when present) out of a credentials SMS
 * body. The messages are free text composed on the job card, so this is
 * deliberately conservative: it only matches an explicit "Username: x" label
 * and returns null otherwise, rather than guessing. A generic "download the
 * app and enter your account" message correctly yields nothing.
 */
function parseCredentialMessage(body: string): { username: string; platform: string | null } | null {
  const user = body.match(/user\s*name\s*[:=]\s*(\S+)/i);
  if (!user) return null;
  const username = user[1].replace(/[.,;]+$/, "").trim();
  if (!username) return null;
  const plat = body.match(/platform\s*[:=]\s*(\S+)/i);
  return { username, platform: plat ? plat[1].replace(/[.,;]+$/, "").trim() : null };
}

/**
 * Fills in the Logins columns from the two places a tracking-platform login
 * can be found. Neither can be SQL-joined to the report, so both run as one
 * batched lookup per response page, keyed on the normalised vehicle
 * registration (the live side was space-stripped in Aug 2026, the archive and
 * the ticket table were not).
 *
 *   1. `finemark_archive.archive_installations` — the legacy record, ~26k
 *      rows, in a physically separate database. Authoritative but covers only
 *      pre-migration vehicles.
 *   2. `crm_communication_logs` where metadata kind = 'platform_credentials' —
 *      the credentials SMS actually sent from the job card, matched to a
 *      vehicle through `linked_ticket_id`. This is the only trace modern
 *      installs leave, since the login is never persisted on the install
 *      record itself. Body is encrypted, so it is decrypted and parsed here.
 *      Matched on registration, falling back to the installation ticket for
 *      vehicles that have no registration yet (chassis-only records — 29 of
 *      129 sends). Never matched on customer alone: that would mis-assign a
 *      login when a customer has several vehicles.
 *
 * The archive wins where both exist (it is a stored field rather than text
 * parsed out of a message). `loginSource` records which one answered.
 *
 * Passwords are never read from either source — the archive stores them in
 * plaintext and its own API suppresses them (routes/archive.ts); the SMS body
 * contains one but only the username is surfaced or re-sent.
 */
interface CredentialHit { username: string; platform: string | null; sentAt: string; messageId: string; customerId: string | null }
interface ResolvedLogins {
  sms: Map<string, CredentialHit>;
  /** Same credential sends, keyed by installation ticket — the only way to
   *  reach a login for a vehicle with no registration (29 of 129 sends). */
  smsByTicket: Map<string, CredentialHit>;
  archive: Map<string, any>;
}

/**
 * Batched two-source login lookup for a set of normalised registrations.
 * Shared by the report's enrichment and the share-by-SMS action, so the two
 * can never disagree about whether a vehicle has a login on file.
 */
async function resolveLogins(regs: string[], ticketIds: string[] = []): Promise<ResolvedLogins> {
  const byRegSms: ResolvedLogins["sms"] = new Map();
  const byTicketSms: ResolvedLogins["smsByTicket"] = new Map();
  const byReg = new Map<string, any>();
  if (!regs.length && !ticketIds.length) return { sms: byRegSms, smsByTicket: byTicketSms, archive: byReg };

  // ── Source 2 (live DB, always available).
  try {
    const credRows = await pgAll<any>(
      `SELECT c.id, c.customer_id, c.body_enc, c.contacted_at, c.linked_ticket_id, it.vehicle_registration
         FROM crm_communication_logs c
         JOIN installation_tickets it ON it.id = c.linked_ticket_id
        WHERE c.metadata_json::jsonb->>'kind' = 'platform_credentials'
          AND c.body_enc IS NOT NULL
          AND (
                (it.vehicle_registration IS NOT NULL
                 AND UPPER(REPLACE(it.vehicle_registration, ' ', '')) = ANY(?::text[]))
             OR c.linked_ticket_id = ANY(?::text[])
          )
        ORDER BY c.contacted_at DESC`,
      [regs, ticketIds]
    );
    for (const c of credRows) {
      let body: string | null = null;
      try { body = decryptField(c.body_enc); } catch { /* undecryptable row — skip */ }
      if (!body) continue;
      const parsed = parseCredentialMessage(body);
      if (!parsed) continue;
      const hit: CredentialHit = { ...parsed, sentAt: c.contacted_at, messageId: c.id, customerId: c.customer_id ?? null };
      const k = normReg(c.vehicle_registration);   // ordered DESC — most recent send wins
      if (k && !byRegSms.has(k)) byRegSms.set(k, hit);
      if (c.linked_ticket_id && !byTicketSms.has(c.linked_ticket_id)) byTicketSms.set(c.linked_ticket_id, hit);
    }
  } catch (e: any) {
    console.error("[customer-service] credentials-SMS login lookup failed:", e?.message || e);
  }

  // ── Source 1: the legacy archive (separate database, may be unreachable).
  try {
    const hits = await archiveAll<any>(
      `SELECT vehicle_reg, username, logins_confirm, tracksolid
         FROM archive_installations
        WHERE UPPER(REPLACE(vehicle_reg, ' ', '')) = ANY(?::text[])
          AND username IS NOT NULL AND username <> ''`,
      [regs]
    );
    for (const h of hits) {
      const k = normReg(h.vehicle_reg);
      if (!byReg.has(k)) byReg.set(k, h); // first hit wins; duplicates are legacy re-installs
    }
  } catch (e: any) {
    // The archive database is optional infrastructure — the report must still
    // render (falling back to the SMS record) if it is down or unreachable.
    console.error("[customer-service] archive login lookup failed:", e?.message || e);
  }
  return { sms: byRegSms, smsByTicket: byTicketSms, archive: byReg };
}

async function attachLogins(rows: Record<string, any>[]) {
  const regs = [...new Set(rows.map((r) => normReg(r.vehicleReg)).filter(Boolean))];
  // A vehicle with no registration (chassis only) can still have had its login
  // texted from the job card — match those through the installation ticket.
  const ticketIds = [...new Set(rows.map((r) => r.ticketId).filter(Boolean))];
  if (!regs.length && !ticketIds.length) return;
  const { sms: byRegSms, smsByTicket, archive: byReg } = await resolveLogins(regs, ticketIds);

  for (const r of rows) {
    const k = normReg(r.vehicleReg);
    const sms = byRegSms.get(k) || (r.ticketId ? smsByTicket.get(r.ticketId) : undefined);
    const h = byReg.get(k);

    // The credential itself is deliberately NOT returned to the browser. This
    // report is wide, exportable to CSV and visible to a broad set of roles —
    // printing usernames across it would scatter them into spreadsheets. The
    // column instead links to where the credential can be viewed deliberately
    // (the sent message, or the legacy archive record), which is also the
    // access path that gets logged. The share-by-SMS action still resolves the
    // real username server-side, so it never has to reach the client at all.
    if (sms) {
      r.loginSource = "SMS record";
      r.loginsShared = "Yes";
      r.loginsSharedAt = sms.sentAt;
      r.loginMessageId = sms.messageId;
      r.loginCustomerId = sms.customerId || r.customerId || null;
      r.trackingPlatform = sms.platform || "—";
    }
    if (h) {
      r.loginSource = sms ? "Archive + SMS" : "Archive";
      r.trackingPlatform = h.tracksolid || r.trackingPlatform;
      r.hasArchiveLogin = true;
      // Don't let the archive's mostly-blank logins_confirm downgrade a "Yes"
      // that an actual credentials SMS on file already established.
      if (!sms) {
        const confirmed = String(h.logins_confirm || "").trim().toLowerCase();
        r.loginsShared = confirmed.startsWith("y") ? "Yes" : confirmed ? confirmed : "No";
      }
    }
    // Label only — the frontend turns this into a link via loginMessageId /
    // hasArchiveLogin. Kept human-readable so the CSV still says something
    // meaningful without leaking the credential.
    r.logins = sms ? "View message" : h ? "Archive record" : "—";
  }
}

// The Partner column: the vehicle's registry partner wins, then the bank on the
// lead, then the lead's free-text partner. The filter and the dropdown options
// use this same expression — filtering on l.bank_partner_name alone missed rows
// whose displayed partner came from the vehicle.
const PARTNER_EXPR = `COALESCE(NULLIF(TRIM(pvv.name),''), NULLIF(TRIM(pvf.name),''), NULLIF(TRIM(l.bank_partner_name),''), NULLIF(TRIM(l.partner_name),''))`;

// Shared SELECT/JOIN for both reports on this router. One row per retail lead;
// retail_lead_vehicles.lead_id is UNIQUE so the vehicle join never fans out.
const CS_SELECT = `
      SELECT l.id AS lead_id, l.customer_id, l.installation_ticket_id AS ticket_id,
             ${PARTNER_EXPR} AS partner_display,
             l.lead_no, l.customer_name, l.customer_type, l.customer_entity_type,
             l.customer_phone, l.customer_email,
             l.installation_county, l.status,
             l.partner_name, l.bank_partner_name,
             l.product_name, l.product_category_name,
             l.customer_location, l.location_description,
             l.sales_rep_name,
             u.name AS rep_name, u.email AS rep_email,
             v.loan_term_months, v.chassis_no AS snapshot_chassis,
             -- Central registry (crm_customer_vehicles) wins over the lead's own
             -- snapshot so corrections made in Customer 360 show live here.
             COALESCE(NULLIF(TRIM(cvv.registration),''), NULLIF(TRIM(cvf.registration),''), v.registration) AS vehicle_registration,
             COALESCE(NULLIF(TRIM(cvv.make),''),  NULLIF(TRIM(cvf.make),''),  v.make)  AS vehicle_make,
             COALESCE(NULLIF(TRIM(cvv.model),''), NULLIF(TRIM(cvf.model),''), v.model) AS vehicle_model,
             COALESCE(cvv.chassis_number, cvf.chassis_number) AS registry_chassis,
             COALESCE(cvv.loan_tenure_months, cvf.loan_tenure_months) AS cv_loan_tenure,
             COALESCE(v.vehicle_id, cvf.id) AS vehicle_id,
             COALESCE(pvv.name, pvf.name) AS vehicle_partner_name,
             it.status AS ticket_status, it.installation_location,
             COALESCE(it.engineer_signed_off_at, it.technician_signed_off_at) AS installation_date,
             COALESCE(te.full_name, tu.name, it.assigned_to_email) AS technician_name,
             COALESCE(ise.full_name, isu.name, it.iso_name) AS iso_resolved_name
      FROM retail_leads l
      LEFT JOIN users u ON u.id = l.sales_rep_id
      LEFT JOIN retail_lead_vehicles v ON v.lead_id = l.id
      LEFT JOIN crm_customer_vehicles cvv ON cvv.id = v.vehicle_id AND cvv.deleted_at IS NULL
      LEFT JOIN partners pvv ON pvv.id::text = cvv.partner_id::text
      LEFT JOIN LATERAL (
        SELECT cvf0.*
        FROM crm_customer_vehicles cvf0
        WHERE cvf0.deleted_at IS NULL
          AND v.vehicle_id IS NULL
          AND cvf0.customer_id = l.customer_id
          AND NULLIF(REPLACE(UPPER(TRIM(cvf0.registration)), ' ', ''), '')
            = NULLIF(REPLACE(UPPER(TRIM(v.registration)), ' ', ''), '')
        ORDER BY cvf0.created_at DESC
        LIMIT 1
      ) cvf ON true
      LEFT JOIN partners pvf ON pvf.id::text = cvf.partner_id::text
      LEFT JOIN installation_tickets it ON it.id = l.installation_ticket_id AND it.deleted_at IS NULL
      LEFT JOIN users        tu  ON tu.id  = it.assigned_to_user_id
      LEFT JOIN hr_employees te  ON te.user_account_id = it.assigned_to_user_id
      LEFT JOIN users        isu ON isu.id = it.iso_user_id
      LEFT JOIN hr_employees ise ON ise.user_account_id = it.iso_user_id`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /customer-service/report  (+ .csv)
// One row per retail lead, carrying the customer, their vehicle, the
// installation outcome and the tracking login — the full customer-service view.
// ─────────────────────────────────────────────────────────────────────────────
async function customerServiceHandler(req: AuthRequest, res: any) {
  const { scope, label } = await csScope(req.user!.role, req.user!.id);
  const sc = idClause(["l.sales_rep_id", "l.bdm_id"], scope);
  return runReport(req, res, {
    table: "retail_leads l",
    scopeLabelStr: label,
    dateCol: "l.created_at",
    scopeSql: `AND l.deleted_at IS NULL ${sc.sql}`,
    scopeParams: sc.params,
    searchCols: [
      "l.customer_name", "l.lead_no", "l.customer_phone", "l.customer_email",
      "v.registration", "cvv.registration", "l.installation_ticket_no",
    ],
    auditAction: { view: "CUSTOMER_SERVICE_REPORT_VIEWED", export: "CUSTOMER_SERVICE_REPORT_EXPORTED" },
    // Filter keys match the column keys, so the page derives its filter bar
    // from whichever columns are currently visible.
    filterCols: {
      leadNo: { col: "l.lead_no" },
      customerName: { col: "l.customer_name" },
      customerType: { col: "l.customer_type", exact: true },
      entityType: { col: "l.customer_entity_type", exact: true },
      phone: { col: "l.customer_phone" },
      email: { col: "l.customer_email" },
      region: { col: "l.installation_county" },
      status: { col: "l.status" },
      partner: { col: PARTNER_EXPR, ci: true },
      product: { col: "l.product_name" },
      location: { col: "l.customer_location" },
      vehicleReg: { col: "v.registration" },
      chassis: { col: "v.chassis_no" },
      make: { col: "v.make" },
      model: { col: "v.model" },
      installationStatus: { col: "it.status", exact: true },
      technician: { col: "it.assigned_to_email" },
      iso: { col: "it.iso_email" },
      salesRep: { col: "u.name" },
    },
    selectSql: CS_SELECT,
    mapRow: (r: any) => ({
      leadNo: r.lead_no || "—",
      customerName: r.customer_name || "—",
      // customer_type is new-vs-existing; customer_entity_type is individual-vs-corporate.
      customerType: r.customer_type || "—",
      entityType: r.customer_entity_type || "—",
      phone: r.customer_phone || "—",
      email: r.customer_email || "—",
      // retail_leads has no `region` column — the install county is the closest thing.
      region: r.installation_county || "—",
      status: r.status || "—",
      partner: r.partner_display || "—",
      product: r.product_name || r.product_category_name || "—",
      location: r.customer_location || r.installation_location || r.location_description || "—",
      loanTermMonths: r.loan_term_months ?? r.cv_loan_tenure ?? null,
      vehicleReg: r.vehicle_registration || "—",
      chassis: r.registry_chassis || r.snapshot_chassis || "—",
      make: r.vehicle_make || "—",
      model: r.vehicle_model || "—",
      installationStatus: r.ticket_status || "—",
      installationDate: r.installation_date || null,
      technician: r.technician_name || "—",
      iso: r.iso_resolved_name || "—",
      salesRep: r.rep_name || r.rep_email || r.sales_rep_name || "—",
      // Filled in by attachLogins() — legacy archive DB and/or the credentials
      // SMS on file. Defaults stand when neither source has anything.
      logins: "—",
      trackingPlatform: "—",
      loginSource: "—",
      loginsShared: "No",
      loginsSharedAt: null,
      // Link targets for the Logins column (never the credential itself).
      loginMessageId: null,
      loginCustomerId: null,
      hasArchiveLogin: false,
      // Raw ids power the row hyperlinks and the SMS action; not shown as columns.
      leadId: r.lead_id || null,
      customerId: r.customer_id || null,
      vehicleId: r.vehicle_id || null,
      ticketId: r.ticket_id || null,
    }),
    enrich: attachLogins,
    orderBy: "l.created_at DESC",
    csv: {
      filename: "customer-service-report.csv",
      headers: [
        "leadNo", "customerName", "customerType", "entityType", "phone", "email",
        "region", "status", "partner", "product", "location", "loanTermMonths",
        "vehicleReg", "chassis", "make", "model",
        "installationStatus", "installationDate", "technician", "iso", "salesRep",
        "logins", "trackingPlatform", "loginSource", "loginsShared", "loginsSharedAt",
      ],
    },
  });
}
// ── GET /partners ─ options for both reports' Partner dropdown ───────────────
// Built from the same PARTNER_EXPR the column shows, within the caller's
// scope, so every option is a value the filter can actually match.
router.get("/partners", async (req: AuthRequest, res) => {
  const { scope } = await csScope(req.user!.role, req.user!.id);
  // `source=corporate` (the Customer Vehicle Report) also offers partners that
  // appear only on corporate jobs; the service report stays retail-only so it
  // never lists an option that matches none of its rows.
  const withCorporate = String((req.query as any).source || "").toLowerCase() === "corporate";
  const sc = idClause(["l.sales_rep_id", "l.bdm_id"], scope);
  const sql = withCorporate
    ? `SELECT DISTINCT partner_display AS name FROM (${CV_SELECT} WHERE l.rn = 1 ${sc.sql}) x
        WHERE partner_display IS NOT NULL ORDER BY 1`
    : `SELECT DISTINCT partner_display AS name FROM (${CS_SELECT} WHERE l.deleted_at IS NULL ${sc.sql}) x
        WHERE partner_display IS NOT NULL ORDER BY 1`;
  const rows = await pgAll<{ name: string }>(sql, sc.params);
  return ok(res, { partners: rows.map((r) => r.name) });
});

router.get("/report", customerServiceHandler);
router.get("/report.csv", customerServiceHandler);

// ─────────────────────────────────────────────────────────────────────────────
// GET /customer-service/vehicle-report  (+ .csv)  — "Customer Vehicle Report"
// The same customer → vehicle → installation view, but grained one row per
// customer-vehicle rather than per lead, and with no tracking-login data at
// all (not merely hidden: the enrichment never runs, so credentials-adjacent
// data never enters the response for this audience).
//
// Deduplication: a customer re-quoted for the same plate produces several
// retail leads. Without a Lead No column those rows are indistinguishable, so
// only the most recent lead per (customer, plate) is kept — ~52 of 1,985 rows
// on current data. Leads with no registration can't be de-duplicated on a
// plate and are all kept. The anti-join lives in scopeSql so the COUNT query
// applies it too and pagination totals stay honest.
// ─────────────────────────────────────────────────────────────────────────────
// Retail and corporate work are recorded in two different places: retail jobs
// start as a retail_lead, corporate ones exist only as a CRPT-/IT- installation
// ticket (364 of them, 246 carrying a vehicle). This report used to read retail
// alone, so corporate vehicles were missing entirely. Both branches are
// normalised to the same column names and unioned, so every filter, the search,
// the scope clause and the COUNT all keep working against one derived table `l`.
//
// Deduplication (both branches): a customer re-quoted for the same plate
// produces several leads/tickets, and with no Lead No column those rows are
// indistinguishable — keep only the most recent per (customer, plate). Rows with
// no registration can't be de-duplicated on a plate, so they are all kept.
const RETAIL_BRANCH = `
    SELECT
      l.id, l.customer_id, l.installation_ticket_id AS ticket_id,
      'Retail' AS source, l.lead_no AS reference_no,
      l.customer_name, l.customer_type, l.customer_entity_type,
      l.customer_phone, l.customer_email,
      l.installation_county AS region, l.status,
      COALESCE(NULLIF(TRIM(pvv.name),''), NULLIF(TRIM(pvf.name),''),
               NULLIF(TRIM(l.bank_partner_name),''), NULLIF(TRIM(l.partner_name),'')) AS partner_display,
      COALESCE(l.product_name, l.product_category_name) AS product_name,
      COALESCE(l.customer_location, it.installation_location, l.location_description) AS location,
      COALESCE(v.loan_term_months, cvv.loan_tenure_months, cvf.loan_tenure_months) AS loan_term_months,
      COALESCE(NULLIF(TRIM(cvv.registration),''), NULLIF(TRIM(cvf.registration),''), v.registration) AS vehicle_registration,
      COALESCE(cvv.chassis_number, cvf.chassis_number, v.chassis_no) AS chassis,
      COALESCE(NULLIF(TRIM(cvv.make),''),  NULLIF(TRIM(cvf.make),''),  v.make)  AS make,
      COALESCE(NULLIF(TRIM(cvv.model),''), NULLIF(TRIM(cvf.model),''), v.model) AS model,
      it.status AS ticket_status,
      COALESCE(it.engineer_signed_off_at, it.technician_signed_off_at) AS installation_date,
      COALESCE(te.full_name, tu.name, it.assigned_to_email) AS technician_name,
      COALESCE(ise.full_name, isu.name, it.iso_name) AS iso_resolved_name,
      it.assigned_to_email AS technician_email, it.iso_email,
      COALESCE(u.name, u.email, l.sales_rep_name) AS rep_name,
      l.sales_rep_id, l.bdm_id,
      COALESCE(v.vehicle_id, cvf.id) AS vehicle_id,
      l.created_at
    FROM retail_leads l
    LEFT JOIN users u ON u.id = l.sales_rep_id
    LEFT JOIN retail_lead_vehicles v ON v.lead_id = l.id
    LEFT JOIN crm_customer_vehicles cvv ON cvv.id = v.vehicle_id AND cvv.deleted_at IS NULL
    LEFT JOIN partners pvv ON pvv.id::text = cvv.partner_id::text
    LEFT JOIN LATERAL (
      SELECT cvf0.*
      FROM crm_customer_vehicles cvf0
      WHERE cvf0.deleted_at IS NULL
        AND v.vehicle_id IS NULL
        AND cvf0.customer_id = l.customer_id
        AND NULLIF(REPLACE(UPPER(TRIM(cvf0.registration)), ' ', ''), '')
          = NULLIF(REPLACE(UPPER(TRIM(v.registration)), ' ', ''), '')
      ORDER BY cvf0.created_at DESC
      LIMIT 1
    ) cvf ON true
    LEFT JOIN partners pvf ON pvf.id::text = cvf.partner_id::text
    LEFT JOIN installation_tickets it ON it.id = l.installation_ticket_id AND it.deleted_at IS NULL
    LEFT JOIN users        tu  ON tu.id  = it.assigned_to_user_id
    LEFT JOIN hr_employees te  ON te.user_account_id = it.assigned_to_user_id
    LEFT JOIN users        isu ON isu.id = it.iso_user_id
    LEFT JOIN hr_employees ise ON ise.user_account_id = it.iso_user_id
    WHERE l.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM retail_leads l2
        LEFT JOIN retail_lead_vehicles v2 ON v2.lead_id = l2.id
        WHERE l2.deleted_at IS NULL
          AND l2.customer_id IS NOT NULL AND l2.customer_id = l.customer_id
          AND NULLIF(UPPER(REPLACE(COALESCE(v2.registration, ''), ' ', '')), '') IS NOT NULL
          AND NULLIF(UPPER(REPLACE(COALESCE(v2.registration, ''), ' ', '')), '')
            = NULLIF(UPPER(REPLACE(COALESCE(v.registration, ''), ' ', '')), '')
          AND (l2.created_at > l.created_at OR (l2.created_at = l.created_at AND l2.id > l.id))
      )`;

// Corporate / internal jobs: no lead row exists, so the installation ticket IS
// the record. Phone falls back to the job's site contact — the customer's own
// number is encrypted on the CRM record and can't be read in SQL.
const CORPORATE_BRANCH = `
    SELECT
      it.id, it.customer_id, it.id AS ticket_id,
      'Corporate' AS source, it.ticket_no AS reference_no,
      COALESCE(NULLIF(TRIM(it.customer_name),''), ip.full_name, corp.company_name) AS customer_name,
      NULL AS customer_type,
      CASE WHEN corp.customer_id IS NOT NULL THEN 'corporate'
           WHEN ip.customer_id  IS NOT NULL THEN 'individual' END AS customer_entity_type,
      it.installation_contact_phone AS customer_phone,
      NULL AS customer_email,
      it.installation_location AS region,
      it.status,
      COALESCE(NULLIF(TRIM(pv.name),''), NULLIF(TRIM(c.affiliate_partner_name),''),
               NULLIF(TRIM(c.secondary_partner_name),'')) AS partner_display,
      it.product_category AS product_name,
      it.installation_location AS location,
      cv.loan_tenure_months AS loan_term_months,
      COALESCE(NULLIF(TRIM(cv.registration),''), it.vehicle_registration) AS vehicle_registration,
      cv.chassis_number AS chassis, cv.make, cv.model,
      it.status AS ticket_status,
      COALESCE(it.engineer_signed_off_at, it.technician_signed_off_at) AS installation_date,
      COALESCE(te.full_name, tu.name, it.assigned_to_email) AS technician_name,
      COALESCE(ise.full_name, isu.name, it.iso_name) AS iso_resolved_name,
      it.assigned_to_email AS technician_email, it.iso_email,
      COALESCE(cu.name, cu.email) AS rep_name,
      it.created_by_user_id AS sales_rep_id, NULL AS bdm_id,
      cv.id AS vehicle_id,
      it.created_at
    FROM installation_tickets it
    LEFT JOIN crm_customer_vehicles cv ON cv.id = it.vehicle_id AND cv.deleted_at IS NULL
    LEFT JOIN partners pv ON pv.id::text = cv.partner_id::text
    LEFT JOIN crm_customers c ON c.id = it.customer_id
    LEFT JOIN crm_individual_profiles ip ON ip.customer_id = it.customer_id
    LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = it.customer_id
    LEFT JOIN users        cu  ON cu.id  = it.created_by_user_id
    LEFT JOIN users        tu  ON tu.id  = it.assigned_to_user_id
    LEFT JOIN hr_employees te  ON te.user_account_id = it.assigned_to_user_id
    LEFT JOIN users        isu ON isu.id = it.iso_user_id
    LEFT JOIN hr_employees ise ON ise.user_account_id = it.iso_user_id
    WHERE it.deleted_at IS NULL
      AND it.ticket_no NOT LIKE 'RTL-%'
      -- Service jobs fit no gadget: no tracking login, no certificate. Keep
      -- them out, and stop a later service visit hiding the original install.
      AND COALESCE(it.service_only, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM installation_tickets it2
        WHERE it2.deleted_at IS NULL
          AND it2.ticket_no NOT LIKE 'RTL-%'
          AND COALESCE(it2.service_only, false) = false
          AND it2.customer_id IS NOT NULL AND it2.customer_id = it.customer_id
          AND NULLIF(UPPER(REPLACE(COALESCE(it2.vehicle_registration, ''), ' ', '')), '') IS NOT NULL
          AND NULLIF(UPPER(REPLACE(COALESCE(it2.vehicle_registration, ''), ' ', '')), '')
            = NULLIF(UPPER(REPLACE(COALESCE(it.vehicle_registration, ''), ' ', '')), '')
          AND (it2.created_at > it.created_at OR (it2.created_at = it.created_at AND it2.id > it.id))
      )`;

// Each branch de-duplicates within itself; this also settles the 21 vehicles
// that appear on BOTH sides (a retail lead and a later corporate/IT job) —
// newest record wins, so the row reflects the most recent work on that plate.
// Rows with no plate or no customer can't be matched up and are always kept.
// The `rn = 1` filter is applied in scopeSql so the COUNT query honours it too.
const CV_SELECT = `
  SELECT l.* FROM (
    SELECT z.*,
           CASE WHEN z.customer_id IS NOT NULL
                 AND NULLIF(UPPER(REPLACE(COALESCE(z.vehicle_registration, ''), ' ', '')), '') IS NOT NULL
                THEN ROW_NUMBER() OVER (
                       PARTITION BY z.customer_id, UPPER(REPLACE(z.vehicle_registration, ' ', ''))
                       ORDER BY z.created_at DESC, z.id DESC)
                ELSE 1 END AS rn
      FROM (${RETAIL_BRANCH} UNION ALL ${CORPORATE_BRANCH}) z
  ) l`;

async function customerVehicleHandler(req: AuthRequest, res: any) {
  const { scope, label } = await csScope(req.user!.role, req.user!.id);
  const sc = idClause(["l.sales_rep_id", "l.bdm_id"], scope);
  return runReport(req, res, {
    table: "retail_leads l",
    scopeLabelStr: label,
    dateCol: "l.created_at",
    // Both branches already filter their own deleted rows and de-duplicate;
    // what is left here is the caller's visibility scope.
    scopeSql: `AND l.rn = 1 ${sc.sql}`,
    scopeParams: sc.params,
    searchCols: [
      "l.customer_name", "l.customer_phone", "l.customer_email",
      "l.vehicle_registration", "l.chassis", "l.reference_no",
    ],
    auditAction: { view: "CUSTOMER_VEHICLE_REPORT_VIEWED", export: "CUSTOMER_VEHICLE_REPORT_EXPORTED" },
    filterCols: {
      source: { col: "l.source", exact: true },
      customerName: { col: "l.customer_name" },
      customerType: { col: "l.customer_type", exact: true },
      entityType: { col: "l.customer_entity_type", exact: true },
      phone: { col: "l.customer_phone" },
      email: { col: "l.customer_email" },
      region: { col: "l.region" },
      status: { col: "l.status" },
      partner: { col: "l.partner_display", ci: true },
      product: { col: "l.product_name" },
      location: { col: "l.location" },
      vehicleReg: { col: "l.vehicle_registration" },
      chassis: { col: "l.chassis" },
      make: { col: "l.make" },
      model: { col: "l.model" },
      installationStatus: { col: "l.ticket_status", exact: true },
      technician: { col: "l.technician_email" },
      iso: { col: "l.iso_email" },
      salesRep: { col: "l.rep_name" },
    },
    selectSql: CV_SELECT,
    mapRow: (r: any) => ({
      source: r.source || "—",
      customerName: r.customer_name || "—",
      customerType: r.customer_type || "—",
      entityType: r.customer_entity_type || "—",
      phone: r.customer_phone || "—",
      email: r.customer_email || "—",
      region: r.region || "—",
      status: r.status || "—",
      partner: r.partner_display || "—",
      product: r.product_name || "—",
      location: r.location || "—",
      loanTermMonths: r.loan_term_months ?? null,
      vehicleReg: r.vehicle_registration || "—",
      chassis: r.chassis || "—",
      make: r.make || "—",
      model: r.model || "—",
      installationStatus: r.ticket_status || "—",
      installationDate: r.installation_date || null,
      technician: r.technician_name || "—",
      iso: r.iso_resolved_name || "—",
      salesRep: r.rep_name || "—",
      // Row hyperlinks only — not columns.
      customerId: r.customer_id || null,
      ticketId: r.ticket_id || null,
      vehicleId: r.vehicle_id || null,
    }),
    orderBy: "l.created_at DESC",
    csv: {
      filename: "customer-vehicle-report.csv",
      headers: [
        "source", "customerName", "customerType", "entityType", "phone", "email",
        "region", "status", "partner", "product", "location", "loanTermMonths",
        "vehicleReg", "chassis", "make", "model",
        "installationStatus", "installationDate", "technician", "iso", "salesRep",
      ],
    },
  });
}
router.get("/vehicle-report", customerVehicleHandler);
router.get("/vehicle-report.csv", customerVehicleHandler);

// ─────────────────────────────────────────────────────────────────────────────
// POST /customer-service/share-logins
// Sends each selected customer their tracking-platform login by SMS.
// Outward-facing and irreversible, so it is gated harder than the report:
// only Admin/Support/Technical/InstallOffice, and it refuses to send unless
// the caller explicitly passes confirm:true. dryRun:true previews recipients.
// ─────────────────────────────────────────────────────────────────────────────
const SHARE_ROLES = ["Admin", "Support", "Operations", "Technical", "technical_manager", "InstallOffice", "CertAdmin"];

const shareSchema = z.object({
  leadIds: z.array(z.string()).min(1, "Select at least one row").max(200, "Select at most 200 rows at a time"),
  dryRun: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

router.post("/share-logins", requireRole(SHARE_ROLES), async (req: AuthRequest, res) => {
  const parsed = shareSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const { leadIds, dryRun, confirm } = parsed.data;

  if (!isSmsConfigured()) {
    return errorResponse(res, 503, "NOT_CONFIGURED", "The SMS gateway is not configured.");
  }

  // Resolve each lead's customer, phone and vehicle registration.
  const leads = await pgAll<any>(
    `SELECT l.id, l.lead_no, l.customer_id, l.customer_name, l.customer_phone,
            COALESCE(NULLIF(TRIM(cvv.registration),''), v.registration) AS vehicle_reg
       FROM retail_leads l
       LEFT JOIN retail_lead_vehicles v ON v.lead_id = l.id
       LEFT JOIN crm_customer_vehicles cvv ON cvv.id = v.vehicle_id AND cvv.deleted_at IS NULL
      WHERE l.id = ANY(?::text[]) AND l.deleted_at IS NULL`,
    [leadIds]
  );

  // Same two-source lookup the report uses, so the action can always send a
  // login the report displayed (including one only recorded in a past SMS).
  const regs = [...new Set(leads.map((l) => normReg(l.vehicle_reg)).filter(Boolean))];
  const { sms: byRegSms, archive: byReg } = await resolveLogins(regs);

  const plan = leads.map((l) => {
    const k = normReg(l.vehicle_reg);
    const arch = byReg.get(k);
    const prev = byRegSms.get(k);
    const username = arch?.username || prev?.username || null;
    const platform = arch?.tracksolid || prev?.platform || null;
    const phone = String(l.customer_phone || "").trim();
    let skipReason: string | null = null;
    if (!phone) skipReason = "no phone number on the lead";
    else if (!username) skipReason = "no tracking login on file";
    return {
      leadId: l.id, leadNo: l.lead_no, customerId: l.customer_id,
      customer: l.customer_name, phone, vehicleReg: l.vehicle_reg,
      username, platform,
      source: arch ? "archive" : prev ? "previous SMS" : null,
      willSend: !skipReason, skipReason,
    };
  });
  const sendable = plan.filter((p) => p.willSend);

  if (dryRun || !confirm) {
    return ok(res, {
      dryRun: true,
      total: plan.length,
      sendable: sendable.length,
      skipped: plan.filter((p) => !p.willSend),
      // Masked: the operator needs to confirm WHO is being messaged, not read
      // the credential — so it never reaches the browser here either.
      recipients: sendable.map((p) => ({
        customer: p.customer, phone: p.phone, vehicleReg: p.vehicleReg,
        username: maskSecret(p.username), source: p.source,
      })),
    }, dryRun ? "Preview only — nothing was sent." : "Confirmation required — nothing was sent.");
  }

  const now = new Date().toISOString();
  const results: any[] = [];
  for (const p of sendable) {
    const msg = `Finemark Tracking: your vehicle ${p.vehicleReg} tracking login is ${p.username}. ` +
                `For your password or help, call us on 0709 100 100.`;
    let delivered = false;
    let error: string | null = null;
    try {
      const [r] = await sendSms([p.phone], msg);
      delivered = r?.status === "Success";
      if (!delivered) error = r?.status || "Failed";
    } catch (e: any) {
      error = e?.message || "send failed";
    }
    // Log against the customer, mirroring the job-card credentials flow so
    // both show up in the same communication history. Body is encrypted.
    if (p.customerId) {
      await pgRun(
        `INSERT INTO crm_communication_logs
           (id, customer_id, channel, direction, subject, body_enc, by_user_id, by_user_email,
            contact_name, contacted_at, created_at, metadata_json)
         VALUES (?, ?, 'sms', 'outbound', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), p.customerId, "Tracking platform login", encryptField(msg),
         req.user!.id, req.user!.email, p.customer, now, now,
         JSON.stringify({ recipient: p.phone, kind: "platform_credentials", source: "customer-service-report", vehicleReg: p.vehicleReg, delivered })]
      ).catch((e) => console.error("[customer-service] comm log failed:", e?.message || e));
    }
    results.push({ leadNo: p.leadNo, customer: p.customer, phone: p.phone, delivered, error });
  }

  const sent = results.filter((r) => r.delivered).length;
  auditLog(req, "CUSTOMER_LOGINS_SHARED_SMS", `retail_leads:${sendable.length}`, "Warning", {
    requested: plan.length, sent, failed: results.length - sent,
  }).catch(console.error);

  return ok(res, {
    total: plan.length,
    sent,
    failed: results.length - sent,
    skipped: plan.filter((p) => !p.willSend),
    results,
  }, `Sent ${sent} of ${results.length} SMS.`);
});

export default router;
