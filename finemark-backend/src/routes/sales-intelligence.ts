import { Router } from "express";
import { z } from "zod";
import { pgAll, pgGet } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { ok, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { buildCsv, sendCsv } from "../utils/csv.js";
import { resolveSalesScope, SalesScope } from "../services/salesScopeService.js";

const router = Router();

// Every sales-facing role plus the two full-visibility oversight roles. Row-
// level scoping below (resolveSalesScope) is what actually constrains an
// individual contributor / team lead to their own data — this gate just
// decides who's allowed in the door at all.
export const SALES_INTEL_ROLES = [
  "Admin", "Executive", "BDM", "BDMCorporate", "CorporateSales", "KAM",
  "Sales", "Telesales", "FieldSales",
];

router.use(requireAuth, requireRole(SALES_INTEL_ROLES));

// ─────────────────────────────────────────────────────────────────────────────
// Scope-clause helpers — turn a SalesScope into a parameterized SQL fragment.
// scope.userIds === null means unrestricted (Admin/Executive): no clause added.
// ─────────────────────────────────────────────────────────────────────────────
function idClause(cols: string[], scope: SalesScope): { sql: string; params: any[] } {
  if (scope.userIds === null) return { sql: "", params: [] };
  const per = cols.map((c) => `${c} = ANY(?::text[])`).join(" OR ");
  return { sql: ` AND (${per})`, params: cols.map(() => scope.userIds!) };
}
function emailClause(col: string, scope: SalesScope): { sql: string; params: any[] } {
  if (scope.emails === null) return { sql: "", params: [] };
  return { sql: ` AND ${col} = ANY(?::text[])`, params: [scope.emails] };
}
function scopeLabel(role: string, scope: SalesScope): string {
  if (scope.userIds === null) return "all";
  if (role === "BDM" || role === "BDMCorporate") return "team";
  return "own";
}

const parsePaging = (page?: string, pageSize?: string) => ({
  parsedPage: Math.max(parseInt(page || "1", 10) || 1, 1),
  parsedPageSize: Math.min(parseInt(pageSize || "50", 10) || 50, 500),
});

// Default window for the dashboard summary and as a sensible report default —
// 12 months back from today, inclusive.
function defaultDateRange(from?: string, to?: string) {
  const today = new Date().toISOString().slice(0, 10);
  const twelveMoAgo = new Date();
  twelveMoAgo.setMonth(twelveMoAgo.getMonth() - 12);
  return {
    from: from || twelveMoAgo.toISOString().slice(0, 10),
    to: to || today,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /summary — dashboard KPIs + chart series, ABAC-scoped, date-ranged.
// ─────────────────────────────────────────────────────────────────────────────
const summaryQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

router.get("/summary", async (req: AuthRequest, res) => {
  const parsed = summaryQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());
  const { from, to } = defaultDateRange(parsed.data.from, parsed.data.to);
  const toEnd = `${to} 23:59:59`;

  const role = req.user!.role;
  const scope = await resolveSalesScope(role, req.user!.id);
  const leadIds = idClause(["sales_rep_id", "assigned_to_id"], scope);
  const retailLeadIds = idClause(["sales_rep_id", "bdm_id"], scope);
  const quoteIds = idClause(["sales_rep_id"], scope);
  const customerIds = idClause(["account_manager_id"], scope);
  const commIds = idClause(["by_user_id"], scope);
  const invEmails = emailClause("sales_person", scope);

  const [
    leadTotals, leadByStatus, leadBySource,
    retailTotals, retailByStatus, retailBySource,
    quoteTotals, quoteByStatus,
    invoiceTotals,
    customerCount, customerNew,
    commTotals, commByChannel,
    revenueTrend,
  ] = await Promise.all([
    pgGet<{ total: string }>(
      `SELECT COUNT(*) AS total FROM crm_leads WHERE deleted_at IS NULL AND lead_date BETWEEN ? AND ? ${leadIds.sql}`,
      [from, to, ...leadIds.params]
    ),
    pgAll<{ status: string; n: string }>(
      `SELECT status, COUNT(*) AS n FROM crm_leads WHERE deleted_at IS NULL AND lead_date BETWEEN ? AND ? ${leadIds.sql} GROUP BY status ORDER BY n DESC`,
      [from, to, ...leadIds.params]
    ),
    pgAll<{ lead_source: string; n: string }>(
      `SELECT lead_source, COUNT(*) AS n FROM crm_leads WHERE deleted_at IS NULL AND lead_date BETWEEN ? AND ? ${leadIds.sql} GROUP BY lead_source ORDER BY n DESC LIMIT 10`,
      [from, to, ...leadIds.params]
    ),
    pgGet<{ total: string }>(
      `SELECT COUNT(*) AS total FROM retail_leads WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ? ${retailLeadIds.sql}`,
      [from, toEnd, ...retailLeadIds.params]
    ),
    pgAll<{ status: string; n: string }>(
      `SELECT status, COUNT(*) AS n FROM retail_leads WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ? ${retailLeadIds.sql} GROUP BY status ORDER BY n DESC`,
      [from, toEnd, ...retailLeadIds.params]
    ),
    pgAll<{ lead_source: string; n: string }>(
      `SELECT lead_source, COUNT(*) AS n FROM retail_leads WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ? ${retailLeadIds.sql} GROUP BY lead_source ORDER BY n DESC LIMIT 10`,
      [from, toEnd, ...retailLeadIds.params]
    ),
    pgGet<{ total: string; sum_amount: string; accepted: string }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(total_amount),0) AS sum_amount,
              COUNT(*) FILTER (WHERE status = 'Accepted') AS accepted
       FROM crm_quotes WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ? ${quoteIds.sql}`,
      [from, toEnd, ...quoteIds.params]
    ),
    pgAll<{ status: string; n: string }>(
      `SELECT status, COUNT(*) AS n FROM crm_quotes WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ? ${quoteIds.sql} GROUP BY status ORDER BY n DESC`,
      [from, toEnd, ...quoteIds.params]
    ),
    pgGet<{ total: string; sum_amount: string; paid: string; outstanding: string }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(amount),0) AS sum_amount,
              COALESCE(SUM(amount) FILTER (WHERE status = 'Paid'),0) AS paid,
              COALESCE(SUM(amount) FILTER (WHERE status != 'Paid'),0) AS outstanding
       FROM invoices WHERE issued_on BETWEEN ? AND ? ${invEmails.sql}`,
      [from, toEnd, ...invEmails.params]
    ),
    pgGet<{ total: string }>(
      `SELECT COUNT(*) AS total FROM crm_customers WHERE deleted_at IS NULL AND status = 'Active' ${customerIds.sql}`,
      [...customerIds.params]
    ),
    pgGet<{ total: string }>(
      `SELECT COUNT(*) AS total FROM crm_customers WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ? ${customerIds.sql}`,
      [from, toEnd, ...customerIds.params]
    ),
    pgGet<{ total: string }>(
      `SELECT COUNT(*) AS total FROM crm_communication_logs WHERE contacted_at BETWEEN ? AND ? ${commIds.sql}`,
      [from, toEnd, ...commIds.params]
    ),
    pgAll<{ channel: string; n: string }>(
      `SELECT channel, COUNT(*) AS n FROM crm_communication_logs WHERE contacted_at BETWEEN ? AND ? ${commIds.sql} GROUP BY channel ORDER BY n DESC`,
      [from, toEnd, ...commIds.params]
    ),
    pgAll<{ label: string; quote_value: string; invoiced_value: string }>(
      `SELECT m.label,
              COALESCE(q.sum_amount, 0) AS quote_value,
              COALESCE(i.sum_amount, 0) AS invoiced_value
       FROM (
         SELECT TO_CHAR(d, 'YYYY-MM') AS label
         FROM generate_series(date_trunc('month', ?::date), date_trunc('month', ?::date), interval '1 month') d
       ) m
       LEFT JOIN (
         SELECT SUBSTRING(created_at, 1, 7) AS label, SUM(total_amount) AS sum_amount
         FROM crm_quotes WHERE deleted_at IS NULL AND created_at BETWEEN ? AND ? ${quoteIds.sql}
         GROUP BY label
       ) q ON q.label = m.label
       LEFT JOIN (
         SELECT SUBSTRING(issued_on, 1, 7) AS label, SUM(amount) AS sum_amount
         FROM invoices WHERE issued_on BETWEEN ? AND ? ${invEmails.sql}
         GROUP BY label
       ) i ON i.label = m.label
       ORDER BY m.label`,
      [from, to, from, toEnd, ...quoteIds.params, from, toEnd, ...invEmails.params]
    ),
  ]);

  const leadTotal = Number(leadTotals?.total || 0) + Number(retailTotals?.total || 0);
  const convertedCorp = leadByStatus.find((r) => r.status === "Converted");
  const convertedRetail = retailByStatus.find((r) => r.status === "completed" || r.status === "Completed");
  const converted = Number(convertedCorp?.n || 0) + Number(convertedRetail?.n || 0);

  return ok(res, {
    scope: scopeLabel(role, scope),
    range: { from, to },
    kpis: {
      totalLeads: leadTotal,
      corporateLeads: Number(leadTotals?.total || 0),
      retailLeads: Number(retailTotals?.total || 0),
      conversionRate: leadTotal ? Math.round((converted / leadTotal) * 1000) / 10 : 0,
      totalQuotes: Number(quoteTotals?.total || 0),
      totalQuoteValue: Number(quoteTotals?.sum_amount || 0),
      quoteWinRate: quoteTotals?.total ? Math.round((Number(quoteTotals.accepted) / Number(quoteTotals.total)) * 1000) / 10 : 0,
      totalInvoices: Number(invoiceTotals?.total || 0),
      totalInvoicedRevenue: Number(invoiceTotals?.sum_amount || 0),
      paidRevenue: Number(invoiceTotals?.paid || 0),
      outstandingRevenue: Number(invoiceTotals?.outstanding || 0),
      activeCustomers: Number(customerCount?.total || 0),
      newCustomers: Number(customerNew?.total || 0),
      totalCommunications: Number(commTotals?.total || 0),
    },
    charts: {
      leadStatus: mergeStatusCounts(leadByStatus, retailByStatus),
      leadSource: mergeStatusCounts(leadBySource.map((r) => ({ status: r.lead_source, n: r.n })), retailBySource.map((r) => ({ status: r.lead_source, n: r.n }))),
      quoteStatus: quoteByStatus.map((r) => ({ label: r.status, count: Number(r.n) })),
      communicationChannel: commByChannel.map((r) => ({ label: r.channel, count: Number(r.n) })),
      revenueTrend: revenueTrend.map((r) => ({
        month: r.label, quoteValue: Number(r.quote_value), invoicedValue: Number(r.invoiced_value),
      })),
    },
  });
});

function mergeStatusCounts(a: { status: string; n: string }[], b: { status: string; n: string }[]) {
  const map = new Map<string, number>();
  for (const r of [...a, ...b]) map.set(r.status, (map.get(r.status) || 0) + Number(r.n));
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((x, y) => y.count - x.count);
}

// ─────────────────────────────────────────────────────────────────────────────
// Configurable reports — one endpoint pair (JSON + CSV) per dataset, all
// ABAC-scoped and following the same whitelisted-clause-builder + Zod
// validation + pagination pattern as the archive module's search trackers
// (see routes/archive.ts), just pointed at live tables instead of finemark_archive.
// ─────────────────────────────────────────────────────────────────────────────

const reportQuerySchema = z.object({
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
}).passthrough(); // per-report dynamic filter keys (see filterCols) ride along un-validated by name — each is only ever used as a parameterized bind value, never interpolated, so an unrecognized key is simply ignored rather than a security concern.

// A filterable column's frontend key (e.g. "customerSegment") must match the
// same key the report's `columns` catalog and `mapRow()` output use, so the
// Sales Reports page can derive its filter bar directly from whichever
// columns are currently visible (see sales-reports.html's renderFilterFields).
// `exact: true` columns (closed enums like status) get an `=` match; the rest
// get an ILIKE partial match, since free-text fields (source, region, segment)
// rarely match a stored value exactly.
interface FilterColDef { col: string; exact?: boolean }

async function runReport(
  req: AuthRequest,
  res: any,
  opts: {
    table: string;
    scopeLabelStr: string;
    dateCol: string;
    scopeSql: string;
    scopeParams: any[];
    searchCols: string[];
    filterCols?: Record<string, FilterColDef>;
    selectSql: string;
    mapRow: (r: any) => Record<string, unknown>;
    orderBy: string;
    csv?: { filename: string; headers: string[] };
  }
) {
  const parsed = reportQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());
  const f = parsed.data as Record<string, string | undefined>;

  const clauses: string[] = [];
  const params: any[] = [];

  if (f.search && opts.searchCols.length) {
    clauses.push(`(${opts.searchCols.map((c) => `${c} ILIKE ?`).join(" OR ")})`);
    opts.searchCols.forEach(() => params.push(`%${f.search}%`));
  }
  for (const [key, def] of Object.entries(opts.filterCols || {})) {
    const val = f[key];
    if (!val?.trim()) continue;
    if (def.exact) { clauses.push(`${def.col} = ?`); params.push(val.trim()); }
    else { clauses.push(`${def.col} ILIKE ?`); params.push(`%${val.trim()}%`); }
  }
  if (f.from) { clauses.push(`${opts.dateCol} >= ?`); params.push(f.from); }
  if (f.to) { clauses.push(`${opts.dateCol} <= ?`); params.push(`${f.to} 23:59:59`); }

  const userWhere = clauses.length ? `AND ${clauses.join(" AND ")}` : "";
  const isCsv = !!opts.csv && req.path.endsWith(".csv");
  // Reuse selectSql's exact FROM/JOIN clause for the COUNT query too — some
  // reports' search filter reaches into a joined table (e.g. customers'
  // name search hits crm_individual_profiles/crm_corporate_profiles), and a
  // COUNT built from opts.table alone would 500 on "missing FROM-clause
  // entry" the moment that filter is used.
  const fromClause = opts.selectSql.slice(opts.selectSql.indexOf(" FROM "));

  if (isCsv) {
    const rows = await pgAll(
      `${opts.selectSql} WHERE 1=1 ${opts.scopeSql} ${userWhere} ORDER BY ${opts.orderBy} LIMIT 5000`,
      [...opts.scopeParams, ...params]
    );
    const mapped = rows.map(opts.mapRow);
    const csv = buildCsv(opts.csv!.headers, mapped);
    auditLog(req, "SALES_REPORT_EXPORTED", opts.table, "Info", { filters: f }).catch(console.error);
    return sendCsv(res, opts.csv!.filename, csv);
  }

  const { parsedPage, parsedPageSize } = parsePaging(f.page, f.pageSize);
  const offset = (parsedPage - 1) * parsedPageSize;

  const [rows, totalRow] = await Promise.all([
    pgAll(
      `${opts.selectSql} WHERE 1=1 ${opts.scopeSql} ${userWhere} ORDER BY ${opts.orderBy} LIMIT ? OFFSET ?`,
      [...opts.scopeParams, ...params, parsedPageSize, offset]
    ),
    pgGet<{ total: string }>(
      `SELECT COUNT(*) AS total ${fromClause} WHERE 1=1 ${opts.scopeSql} ${userWhere}`,
      [...opts.scopeParams, ...params]
    ),
  ]);

  auditLog(req, "SALES_REPORT_VIEWED", opts.table, "Info", { filters: f }).catch(console.error);
  return ok(res, { data: rows.map(opts.mapRow), meta: { total: Number(totalRow?.total || 0), page: parsedPage, pageSize: parsedPageSize }, scope: opts.scopeLabelStr });
}

// ── Corporate leads ─────────────────────────────────────────────────────────
// Pulls the full pipeline for each lead — most-recent quote, its proforma, the
// resulting invoice + paid status, and the linked installation ticket — via
// LATERAL joins (one row per lead, always the latest of each, never a
// duplicate-row fan-out). Join path: crm_leads -> crm_quotes ->
// crm_proforma_invoices.quote_id -> invoices.id (via proforma.invoice_id) ->
// installation_tickets.invoice_id/proforma_id. crm_leads.converted_to_quote_id
// is NOT used here — it's overwritten on every re-quote and only ever reflects
// the latest, same as this join, so no information is lost by ignoring it.
//
// The lead->quote match itself needs two fallback paths (confirmed against
// live data, not assumed): crm_quotes.lead_id is populated ONLY by the retail
// lead automation (retailQuoteAutomation.ts) — every corporate lead's real
// quote is created post-conversion against the resulting crm_customers row,
// so it only carries customer_id, never lead_id. Matching on lead_id alone
// would show every corporate lead as un-quoted even when it demonstrably has
// quotes. Match on either.
async function corporateLeadsHandler(req: AuthRequest, res: any) {
  const scope = await resolveSalesScope(req.user!.role, req.user!.id);
  const sc = idClause(["l.sales_rep_id", "l.assigned_to_id"], scope);
  return runReport(req, res, {
    table: "crm_leads l",
    scopeLabelStr: scopeLabel(req.user!.role, scope),
    dateCol: "l.lead_date",
    scopeSql: `AND l.deleted_at IS NULL ${sc.sql}`,
    scopeParams: sc.params,
    searchCols: ["l.customer_name", "l.lead_no", "l.phone", "l.email", "l.company_name"],
    filterCols: {
      status: { col: "l.status", exact: true },
      leadSource: { col: "l.lead_source" },
      customerType: { col: "l.customer_type", exact: true },
      customerSegment: { col: "l.customer_segment" },
      region: { col: "l.installation_county" },
      productCategory: { col: "l.product_category_name" },
      partnerName: { col: "l.partner_name" },
      quoteStatus: { col: "q.status" },
      proformaStatus: { col: "pf.status" },
      invoiceStatus: { col: "i.status", exact: true },
      installationStatus: { col: "it.status", exact: true },
      technician: { col: "it.assigned_to_email" },
      isoAssigned: { col: "it.iso_email" },
    },
    selectSql: `
      SELECT l.lead_no, l.customer_name, l.company_name, l.phone, l.email, l.id_number,
             l.status, l.lead_source, l.customer_type, l.customer_segment,
             l.installation_county, l.address, l.fleet_size, l.product_category_name, l.partner_name,
             l.lead_date, l.expected_close_date, l.created_at, l.converted_at,
             u.name AS rep_name, u.email AS rep_email,
             au.name AS assigned_name, au.email AS assigned_email,
             q.quote_no, q.status AS quote_status, q.total_amount AS quote_amount, q.loan_term_months,
             pf.proforma_no, pf.status AS proforma_status,
             i.invoice_number, i.status AS invoice_status, i.amount AS invoice_amount,
             it.ticket_no, it.status AS ticket_status, it.vehicle_registration,
             -- Installation date = when the job card was closed (engineer's
             -- final sign-off, the last step before status flips to Completed;
             -- populated on all completed tickets). Falls back to the
             -- technician sign-off if an engineer one is somehow missing.
             COALESCE(it.engineer_signed_off_at, it.technician_signed_off_at) AS installation_date,
             COALESCE(te.full_name, tu.name, it.assigned_to_email) AS technician_name,
             COALESCE(ise.full_name, isu.name, it.iso_name) AS iso_resolved_name
      FROM crm_leads l
      LEFT JOIN users u  ON u.id = l.sales_rep_id
      LEFT JOIN users au ON au.id = l.assigned_to_id
      LEFT JOIN LATERAL (
        SELECT * FROM crm_quotes q2
        WHERE q2.deleted_at IS NULL
          AND (q2.lead_id = l.id OR (l.customer_id IS NOT NULL AND q2.customer_id = l.customer_id))
        ORDER BY q2.created_at DESC LIMIT 1
      ) q ON true
      LEFT JOIN LATERAL (
        SELECT * FROM crm_proforma_invoices pf2
        WHERE pf2.quote_id = q.id AND pf2.deleted_at IS NULL
        ORDER BY pf2.created_at DESC LIMIT 1
      ) pf ON true
      LEFT JOIN invoices i ON i.id = pf.invoice_id
      LEFT JOIN LATERAL (
        SELECT * FROM installation_tickets it2
        WHERE it2.deleted_at IS NULL AND (it2.invoice_id = i.id OR it2.proforma_id = pf.id)
        ORDER BY it2.created_at DESC LIMIT 1
      ) it ON true
      LEFT JOIN users tu ON tu.id = it.assigned_to_user_id
      LEFT JOIN hr_employees te ON te.user_account_id = it.assigned_to_user_id
      LEFT JOIN users isu ON isu.id = it.iso_user_id
      LEFT JOIN hr_employees ise ON ise.user_account_id = it.iso_user_id`,
    mapRow: (r: any) => ({
      leadNo: r.lead_no, customerName: r.customer_name, companyName: r.company_name,
      phone: r.phone, email: r.email, idNumber: r.id_number,
      status: r.status, leadSource: r.lead_source, customerType: r.customer_type,
      customerSegment: r.customer_segment, region: r.installation_county, address: r.address,
      fleetSize: r.fleet_size, productCategory: r.product_category_name, partnerName: r.partner_name,
      leadDate: r.lead_date, expectedCloseDate: r.expected_close_date, createdAt: r.created_at, convertedAt: r.converted_at,
      salesRep: r.rep_name || r.rep_email || "—",
      assignedTo: r.assigned_name || r.assigned_email || "—",
      quoteNo: r.quote_no || "—", quoteStatus: r.quote_status || "—", quoteAmount: r.quote_amount,
      loanTermMonths: r.loan_term_months ?? null,
      proformaNo: r.proforma_no || "—", proformaStatus: r.proforma_status || "—",
      invoiceNo: r.invoice_number || "—", invoiceStatus: r.invoice_status || "—", invoiceAmount: r.invoice_amount,
      invoicePaid: r.invoice_status === "Paid" ? "Yes" : (r.invoice_status ? "No" : "—"),
      ticketNo: r.ticket_no || "—", installationStatus: r.ticket_status || "—", vehicleRegistration: r.vehicle_registration || "—",
      installationDate: r.installation_date || null,
      technician: r.technician_name || "—", isoAssigned: r.iso_resolved_name || "—",
    }),
    orderBy: "l.created_at DESC",
    csv: {
      filename: "corporate-leads.csv",
      headers: [
        "leadNo", "customerName", "companyName", "phone", "email", "idNumber",
        "status", "leadSource", "customerType", "customerSegment", "region", "address",
        "fleetSize", "productCategory", "partnerName",
        "leadDate", "expectedCloseDate", "createdAt", "convertedAt",
        "salesRep", "assignedTo",
        "quoteNo", "quoteStatus", "quoteAmount", "loanTermMonths",
        "proformaNo", "proformaStatus",
        "invoiceNo", "invoiceStatus", "invoiceAmount", "invoicePaid",
        "ticketNo", "installationStatus", "installationDate", "vehicleRegistration", "technician", "isoAssigned",
      ],
    },
  });
}
router.get("/leads", corporateLeadsHandler);
router.get("/leads.csv", corporateLeadsHandler);

// ── Retail leads ─────────────────────────────────────────────────────────────
// As data-rich as Corporate Leads: retail_leads already carries direct FKs to
// its quote (quote_id) and installation ticket (installation_ticket_id) — no
// LATERAL "most recent" guesswork needed there, unlike corporate leads, which
// only ever resolve to a customer post-conversion. retail_lead_vehicles.lead_id
// is UNIQUE too, so a plain LEFT JOIN can't fan out rows. Only the proforma
// step still uses LATERAL, in case a quote ever accumulates more than one
// proforma over its life (e.g. a rejected-then-recreated one).
async function retailLeadsHandler(req: AuthRequest, res: any) {
  const scope = await resolveSalesScope(req.user!.role, req.user!.id);
  const sc = idClause(["l.sales_rep_id", "l.bdm_id"], scope);
  return runReport(req, res, {
    table: "retail_leads l",
    scopeLabelStr: scopeLabel(req.user!.role, scope),
    dateCol: "l.created_at",
    scopeSql: `AND l.deleted_at IS NULL ${sc.sql}`,
    scopeParams: sc.params,
    searchCols: ["l.customer_name", "l.lead_no", "l.customer_phone", "l.customer_email"],
    filterCols: {
      status: { col: "l.status" }, // mixed-case in real data (see mapLead's lowercase normalization elsewhere) — ILIKE avoids case mismatches
      leadSource: { col: "l.lead_source" },
      customerType: { col: "l.customer_type", exact: true },
      customerEntityType: { col: "l.customer_entity_type", exact: true },
      region: { col: "l.installation_county" },
      partnerName: { col: "l.partner_name" },
      bankPartnerName: { col: "l.bank_partner_name" },
      productName: { col: "l.product_name" },
      installationFinancer: { col: "l.installation_financer" },
      vehicleCategory: { col: "v.vehicle_category", exact: true },
      quoteStatus: { col: "q.status" },
      proformaStatus: { col: "pf.status" },
      invoiceStatus: { col: "i.status", exact: true },
      installationStatus: { col: "it.status", exact: true },
      technician: { col: "it.assigned_to_email" },
      isoAssigned: { col: "it.iso_email" },
    },
    selectSql: `
      SELECT l.lead_no, l.customer_name, l.customer_type, l.customer_entity_type,
             l.customer_phone, l.customer_email, l.customer_location,
             l.status, l.lead_source, l.installation_county,
             l.partner_name, l.secondary_partner_name, l.bank_partner_name,
             l.referrer_name, l.referrer_phone,
             l.product_name, l.installation_financer,
             l.installation_contact_name, l.installation_contact_phone, l.location_description,
             l.installation_ticket_no, l.submitted_at, l.created_at,
             u.name AS rep_name, u.email AS rep_email, b.name AS bdm_name_resolved, l.bdm_name,
             v.loan_term_months, v.registration AS vehicle_registration, v.make AS vehicle_make,
             v.model AS vehicle_model, v.vehicle_category,
             q.quote_no, q.status AS quote_status, q.total_amount AS quote_amount,
             pf.proforma_no, pf.status AS proforma_status,
             i.invoice_number, i.status AS invoice_status, i.amount AS invoice_amount,
             it.status AS ticket_status,
             COALESCE(it.engineer_signed_off_at, it.technician_signed_off_at) AS installation_date,
             COALESCE(te.full_name, tu.name, it.assigned_to_email) AS technician_name,
             COALESCE(ise.full_name, isu.name, it.iso_name) AS iso_resolved_name
      FROM retail_leads l
      LEFT JOIN users u ON u.id = l.sales_rep_id
      LEFT JOIN users b ON b.id = l.bdm_id
      LEFT JOIN retail_lead_vehicles v ON v.lead_id = l.id
      LEFT JOIN crm_quotes q ON q.id = l.quote_id AND q.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT * FROM crm_proforma_invoices pf2
        WHERE pf2.quote_id = q.id AND pf2.deleted_at IS NULL
        ORDER BY pf2.created_at DESC LIMIT 1
      ) pf ON true
      LEFT JOIN invoices i ON i.id = pf.invoice_id
      LEFT JOIN installation_tickets it ON it.id = l.installation_ticket_id AND it.deleted_at IS NULL
      LEFT JOIN users tu ON tu.id = it.assigned_to_user_id
      LEFT JOIN hr_employees te ON te.user_account_id = it.assigned_to_user_id
      LEFT JOIN users isu ON isu.id = it.iso_user_id
      LEFT JOIN hr_employees ise ON ise.user_account_id = it.iso_user_id`,
    mapRow: (r: any) => ({
      leadNo: r.lead_no, customerName: r.customer_name, customerType: r.customer_type,
      customerEntityType: r.customer_entity_type || "—",
      phone: r.customer_phone, email: r.customer_email, region: r.installation_county || "—",
      status: r.status, leadSource: r.lead_source,
      partnerName: r.partner_name || "—", secondaryPartnerName: r.secondary_partner_name || "—",
      bankPartnerName: r.bank_partner_name || "—",
      referrerName: r.referrer_name || "—", referrerPhone: r.referrer_phone || "—",
      productName: r.product_name || "—", installationFinancer: r.installation_financer || "—",
      installationContactName: r.installation_contact_name || "—",
      installationContactPhone: r.installation_contact_phone || "—",
      locationDescription: r.location_description || "—",
      loanTermMonths: r.loan_term_months ?? null,
      vehicleRegistration: r.vehicle_registration || "—", vehicleMake: r.vehicle_make || "—",
      vehicleModel: r.vehicle_model || "—", vehicleCategory: r.vehicle_category || "—",
      quoteNo: r.quote_no || "—", quoteStatus: r.quote_status || "—", quoteAmount: r.quote_amount,
      proformaNo: r.proforma_no || "—", proformaStatus: r.proforma_status || "—",
      invoiceNo: r.invoice_number || "—", invoiceStatus: r.invoice_status || "—", invoiceAmount: r.invoice_amount,
      invoicePaid: r.invoice_status === "Paid" ? "Yes" : (r.invoice_status ? "No" : "—"),
      ticketNo: r.installation_ticket_no || "—", installationStatus: r.ticket_status || "—",
      installationDate: r.installation_date || null,
      salesRep: r.rep_name || r.rep_email || "—", bdmName: r.bdm_name_resolved || r.bdm_name || "—",
      submittedAt: r.submitted_at || "—", createdAt: r.created_at,
      technician: r.technician_name || "—", isoAssigned: r.iso_resolved_name || "—",
    }),
    orderBy: "l.created_at DESC",
    csv: {
      filename: "retail-leads.csv",
      headers: [
        "leadNo", "customerName", "customerType", "customerEntityType",
        "phone", "email", "region",
        "status", "leadSource",
        "partnerName", "secondaryPartnerName", "bankPartnerName",
        "referrerName", "referrerPhone",
        "productName", "installationFinancer",
        "installationContactName", "installationContactPhone", "locationDescription",
        "loanTermMonths", "vehicleRegistration", "vehicleMake", "vehicleModel", "vehicleCategory",
        "quoteNo", "quoteStatus", "quoteAmount",
        "proformaNo", "proformaStatus",
        "invoiceNo", "invoiceStatus", "invoiceAmount", "invoicePaid",
        "ticketNo", "installationStatus", "installationDate", "technician", "isoAssigned",
        "salesRep", "bdmName", "submittedAt", "createdAt",
      ],
    },
  });
}
router.get("/retail-leads", retailLeadsHandler);
router.get("/retail-leads.csv", retailLeadsHandler);

// ── Quotes ───────────────────────────────────────────────────────────────────
async function quotesHandler(req: AuthRequest, res: any) {
  const scope = await resolveSalesScope(req.user!.role, req.user!.id);
  const sc = idClause(["q.sales_rep_id"], scope);
  return runReport(req, res, {
    table: "crm_quotes q",
    scopeLabelStr: scopeLabel(req.user!.role, scope),
    dateCol: "q.created_at",
    scopeSql: `AND q.deleted_at IS NULL ${sc.sql}`,
    scopeParams: sc.params,
    searchCols: ["q.quote_no"],
    filterCols: { status: { col: "q.status" } },
    selectSql: `SELECT q.quote_no, q.status, q.total_amount, q.loan_term_months, q.created_at, q.expiry_date, u.name AS sales_rep_name, q.sales_rep_email
                FROM crm_quotes q LEFT JOIN users u ON u.id = q.sales_rep_id`,
    mapRow: (r: any) => ({
      quoteNo: r.quote_no, status: r.status, totalAmount: Number(r.total_amount || 0),
      loanTermMonths: r.loan_term_months ?? null,
      createdAt: r.created_at, expiryDate: r.expiry_date, salesRep: r.sales_rep_name || r.sales_rep_email || "—",
    }),
    orderBy: "q.created_at DESC",
    csv: { filename: "quotes.csv", headers: ["quoteNo", "status", "totalAmount", "loanTermMonths", "createdAt", "expiryDate", "salesRep"] },
  });
}
router.get("/quotes", quotesHandler);
router.get("/quotes.csv", quotesHandler);

// ── Invoices ─────────────────────────────────────────────────────────────────
async function invoicesHandler(req: AuthRequest, res: any) {
  const scope = await resolveSalesScope(req.user!.role, req.user!.id);
  const sc = emailClause("i.sales_person", scope);
  return runReport(req, res, {
    table: "invoices i",
    scopeLabelStr: scopeLabel(req.user!.role, scope),
    dateCol: "i.issued_on",
    scopeSql: sc.sql,
    scopeParams: sc.params,
    searchCols: ["i.invoice_number", "i.customer"],
    filterCols: { status: { col: "i.status", exact: true } },
    selectSql: `SELECT i.invoice_number, i.customer, i.status, i.amount, i.issued_on, i.due_on, i.sales_person
                FROM invoices i`,
    mapRow: (r: any) => ({
      invoiceNumber: r.invoice_number, customer: r.customer, status: r.status,
      amount: Number(r.amount || 0), issuedOn: r.issued_on, dueOn: r.due_on, salesPerson: r.sales_person || "—",
    }),
    orderBy: "i.issued_on DESC",
    csv: { filename: "invoices.csv", headers: ["invoiceNumber", "customer", "status", "amount", "issuedOn", "dueOn", "salesPerson"] },
  });
}
router.get("/invoices", invoicesHandler);
router.get("/invoices.csv", invoicesHandler);

// ── Customers ────────────────────────────────────────────────────────────────
async function customersHandler(req: AuthRequest, res: any) {
  const scope = await resolveSalesScope(req.user!.role, req.user!.id);
  const sc = idClause(["c.account_manager_id"], scope);
  return runReport(req, res, {
    table: "crm_customers c",
    scopeLabelStr: scopeLabel(req.user!.role, scope),
    dateCol: "c.created_at",
    scopeSql: `AND c.deleted_at IS NULL ${sc.sql}`,
    scopeParams: sc.params,
    searchCols: ["c.account_no", "COALESCE(ind.full_name, corp.company_name, '')"],
    filterCols: {
      status: { col: "c.status", exact: true },
      type: { col: "c.type", exact: true },
      region: { col: "c.region" },
    },
    selectSql: `SELECT c.account_no, c.type, c.status, c.region, c.created_at, u.name AS am_name, u.email AS am_email,
                       COALESCE(ind.full_name, corp.company_name, '—') AS display_name
                FROM crm_customers c
                LEFT JOIN users u ON u.id = c.account_manager_id
                LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
                LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id`,
    mapRow: (r: any) => ({
      accountNo: r.account_no, displayName: r.display_name, type: r.type, status: r.status,
      region: r.region || "—", createdAt: r.created_at, accountManager: r.am_name || r.am_email || "—",
    }),
    orderBy: "c.created_at DESC",
    csv: { filename: "customers.csv", headers: ["accountNo", "displayName", "type", "status", "region", "createdAt", "accountManager"] },
  });
}
router.get("/customers", customersHandler);
router.get("/customers.csv", customersHandler);

// ── Communications ───────────────────────────────────────────────────────────
async function communicationsHandler(req: AuthRequest, res: any) {
  const scope = await resolveSalesScope(req.user!.role, req.user!.id);
  const sc = idClause(["cl.by_user_id"], scope);
  return runReport(req, res, {
    table: "crm_communication_logs cl",
    scopeLabelStr: scopeLabel(req.user!.role, scope),
    dateCol: "cl.contacted_at",
    scopeSql: `AND 1=1 ${sc.sql}`,
    scopeParams: sc.params,
    searchCols: ["cl.contact_name", "cl.subject"],
    filterCols: { channel: { col: "cl.channel", exact: true } },
    selectSql: `SELECT cl.channel, cl.direction, cl.subject, cl.contact_name, cl.contacted_at, cl.by_user_email
                FROM crm_communication_logs cl`,
    mapRow: (r: any) => ({
      channel: r.channel, direction: r.direction, subject: r.subject || "—",
      contactName: r.contact_name || "—", contactedAt: r.contacted_at, loggedBy: r.by_user_email,
    }),
    orderBy: "cl.contacted_at DESC",
    csv: { filename: "communications.csv", headers: ["channel", "direction", "subject", "contactName", "contactedAt", "loggedBy"] },
  });
}
router.get("/communications", communicationsHandler);
router.get("/communications.csv", communicationsHandler);

export default router;
