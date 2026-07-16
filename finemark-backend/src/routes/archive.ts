import { Router } from "express";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { ok, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { buildCsv, sendCsv } from "../utils/csv.js";
import { archiveAll, archiveGet, archiveRun } from "../archiveDb.js";
import { pgAll, pgRun } from "../db.js";

const router = Router();

// Same role list as the live /api/reports/sales-by-bank, for consistency —
// this is read-only historical data, gated the same way as its live counterpart.
// CorporateSales/KAM were missing — only the legacy "Sales" string could see
// archive reports, locking out anyone whose account already carries the
// canonical role name. CertAdmin added for view-only access to the whole
// archive module, not just the certificate repository (which already had it).
// Technical (ISO) added the same way — note there's no per-report API split
// here matching the frontend's granular capability system (CAPABILITY_DEFS'
// archive_*_view keys), so a role only ever granted ONE report's nav-visible
// capability still gets API access to every route this array gates, not just
// that one. Nav correctly hides the rest; the API doesn't.
const ARCHIVE_ROLES = ["Sales", "Admin", "BDM", "BDMCorporate", "CorporateSales", "KAM", "Telesales", "FieldSales", "Finance", "CertAdmin", "Technical"];
// Same access as the live certificate module's PDF view, plus a few extra
// view-only roles who need certificate history but not the wider archive.
const CERT_ARCHIVE_ROLES = [...ARCHIVE_ROLES, "Executive", "Technician", "InventoryManager", "HR"];
// Sales Report is restricted narrower than the rest of the archive module —
// Admin and Executive only, unlike every other general report here which
// follows the shared ARCHIVE_ROLES list.
const SALES_REPORT_ROLES = ["Admin", "Executive"];
// The retired-inventory sweep soft-deletes rows out of the live inv_items
// ledger — unlike every other route in this file it's a mutation, not a
// read-only report, so it's gated far narrower than ARCHIVE_ROLES.
const INVENTORY_ARCHIVE_ROLES = ["Admin", "InventoryManager"];
// inv_items statuses that mean "nobody has it and it was never installed" —
// the live-availability statuses (Reserved, Issued for Installation, Installed)
// are deliberately excluded so this can never touch active/usable stock.
const RETIRED_INVENTORY_STATUSES = ["In Stock", "Returned", "Defective", "Sent to Supplier", "Replaced"];
// inv_sims equivalent — "available" (unallocated) and "retired" (dead-end).
// "issued"/"installed" are active custody/deployment states, and "suspended"
// can transition back to "available" (STATUS_TRANSITIONS in inventory-sims.ts),
// so it's treated as reactivatable rather than dead stock.
const RETIRED_SIM_STATUSES = ["available", "retired"];

const parsePaging = (page?: string, pageSize?: string) => ({
  parsedPage: Math.max(parseInt(page || "1", 10) || 1, 1),
  parsedPageSize: Math.min(parseInt(pageSize || "50", 10) || 50, 500),
});

// ── GET /api/archive/meta — dropdown source lists (sales people / technicians) ─
// Case-folded (the source data has "AGNES"/"Agnes"/"AGnes" as separate strings for
// the same person) — one representative display value per distinct lowercase key,
// matching the filters below which compare case-insensitively for the same reason.
router.get("/meta", requireAuth, requireRole(ARCHIVE_ROLES), async (_req, res) => {
  const salesPeople = await archiveAll<{ display: string }>(
    `SELECT DISTINCT ON (LOWER(sales_person)) sales_person AS display FROM archive_installations
     WHERE sales_person IS NOT NULL AND TRIM(sales_person) <> '' ORDER BY LOWER(sales_person), sales_person`,
  );
  const technicians = await archiveAll<{ display: string }>(
    `SELECT DISTINCT ON (LOWER(technician)) technician AS display FROM archive_installations
     WHERE technician IS NOT NULL AND TRIM(technician) <> '' ORDER BY LOWER(technician), technician`,
  );
  return res.status(200).json({
    data: {
      // Title-cased so the dropdown label matches how sales-by-bank displays the same
      // name (which title-cases too) — the raw representative casing (e.g. "AGNES")
      // otherwise wouldn't visually match "Agnes" in the report despite being the same person.
      salesPeople: salesPeople.map((r) => titleCase(r.display)).sort((a, b) => a.localeCompare(b)),
      technicians: technicians.map((r) => titleCase(r.display)).sort((a, b) => a.localeCompare(b)),
    },
  });
});

// ── GET /api/archive/installations — search.php equivalent ────────────────────
const installationsQuerySchema = z.object({
  salesPerson: z.string().optional(),
  technician: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startExpiryDate: z.string().optional(),
  endExpiryDate: z.string().optional(),
  clientName: z.string().optional(),
  bank: z.string().optional(),
  vehicleReg: z.string().optional(),
  contact: z.string().optional(),
  trackerNumber: z.string().optional(),
  imei: z.string().optional(),
  status: z.enum(["Active", "Expired", "Zero or Empty Loan", "Renewed"]).optional(),
  tkStatus: z.enum(["Paid", "Not Paid"]).optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

type InstallationFilters = z.infer<typeof installationsQuerySchema>;

function buildInstallationsQuery(filters: InstallationFilters) {
  const clauses: string[] = [];
  const params: any[] = [];

  if (filters.salesPerson) { clauses.push("LOWER(sales_person) = LOWER(?)"); params.push(filters.salesPerson); }
  if (filters.technician) { clauses.push("LOWER(technician) = LOWER(?)"); params.push(filters.technician); }
  if (filters.startDate) { clauses.push("installation_date >= ?"); params.push(filters.startDate); }
  if (filters.endDate) { clauses.push("installation_date <= ?"); params.push(filters.endDate); }
  if (filters.startExpiryDate) { clauses.push("expiry_date >= ?"); params.push(filters.startExpiryDate); }
  if (filters.endExpiryDate) { clauses.push("expiry_date <= ?"); params.push(filters.endExpiryDate); }
  if (filters.clientName) { clauses.push("client_name ILIKE ?"); params.push(`%${filters.clientName}%`); }
  if (filters.bank) { clauses.push("bank_raw ILIKE ?"); params.push(`%${filters.bank}%`); }
  if (filters.vehicleReg) { clauses.push("vehicle_reg ILIKE ?"); params.push(`%${filters.vehicleReg}%`); }
  if (filters.contact) { clauses.push("contact ILIKE ?"); params.push(`%${filters.contact}%`); }
  if (filters.trackerNumber) { clauses.push("tracker_number ILIKE ?"); params.push(`%${filters.trackerNumber}%`); }
  if (filters.imei) { clauses.push("imei ILIKE ?"); params.push(`%${filters.imei}%`); }
  if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
  if (filters.tkStatus === "Paid") clauses.push("tk_paid = true");
  if (filters.tkStatus === "Not Paid") clauses.push("tk_paid = false");

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

// Status priority mirrors search.php exactly: Expired > Renewed > Zero/Empty Loan > Active.
// Unparseable/blank expiry fails toward "Expired" (same as the source's DateTime::createFromFormat check).
const BASE_CTE = `
  WITH base AS (
    SELECT
      i.legacy_id, i.installation_date, i.installation_date_raw, i.client_name, i.sales_person,
      i.vehicle_reg, i.model, i.tracker_number, i.contact, i.bank_raw, i.bank_branch,
      i.tracker_location, i.technician, i.tk_status, i.tracksolid, i.username,
      i.loan_duration, i.c_no, i.expiry_date, i.expiry_date_raw, i.imei,
      i.logins_confirm, i.amount_quoted, i.uploaded_by,
      CASE
        WHEN i.expiry_date IS NULL OR i.expiry_date < CURRENT_DATE THEN 'Expired'
        WHEN r.installation_legacy_id IS NOT NULL THEN 'Renewed'
        WHEN i.loan_duration IS NULL OR TRIM(i.loan_duration) = '' OR TRIM(i.loan_duration) = '0' THEN 'Zero or Empty Loan'
        ELSE 'Active'
      END AS status,
      (i.tk_status IS NOT NULL AND TRIM(i.tk_status) <> '' AND TRIM(i.tk_status) <> '0') AS tk_paid
    FROM archive_installations i
    LEFT JOIN archive_renewals r ON r.installation_legacy_id = i.legacy_id
  )
`;

const mapInstallationRow = (row: any) => ({
  legacyId: row.legacy_id,
  installationDate: row.installation_date,
  installationDateRaw: row.installation_date_raw,
  clientName: row.client_name,
  salesPerson: row.sales_person,
  vehicleReg: row.vehicle_reg,
  model: row.model,
  trackerNumber: row.tracker_number,
  contact: row.contact,
  bank: row.bank_raw,
  bankBranch: row.bank_branch,
  trackerLocation: row.tracker_location,
  technician: row.technician,
  tkStatus: row.tk_status,
  tkPaid: row.tk_paid,
  tracksolid: row.tracksolid,
  username: row.username,
  // password intentionally omitted — see PII note in the migration review.
  loanDuration: row.loan_duration,
  cNo: row.c_no,
  expiryDate: row.expiry_date,
  expiryDateRaw: row.expiry_date_raw,
  imei: row.imei,
  loginsConfirm: row.logins_confirm,
  amountQuoted: Number(row.amount_quoted),
  uploadedBy: row.uploaded_by,
  status: row.status,
});

router.get("/installations", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = installationsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const { parsedPage, parsedPageSize } = parsePaging(parsed.data.page, parsed.data.pageSize);
  const { where, params } = buildInstallationsQuery(parsed.data);
  const offset = (parsedPage - 1) * parsedPageSize;

  const rows = await archiveAll(
    `${BASE_CTE} SELECT * FROM base ${where} ORDER BY installation_date DESC NULLS LAST, legacy_id DESC LIMIT ? OFFSET ?`,
    [...params, parsedPageSize, offset],
  );
  const totalRow = await archiveAll<{ total: string }>(`${BASE_CTE} SELECT COUNT(*)::int AS total FROM base ${where}`, params);

  auditLog(req, "ARCHIVE_REPORT_VIEWED", "archive:installations", "Info", { filters: parsed.data }).catch(console.error);
  return res.status(200).json({
    data: rows.map(mapInstallationRow),
    meta: { total: Number(totalRow[0]?.total ?? 0), page: parsedPage, pageSize: parsedPageSize },
  });
});

router.get("/installations.csv", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = installationsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const { where, params } = buildInstallationsQuery(parsed.data);
  const rows = await archiveAll(`${BASE_CTE} SELECT * FROM base ${where} ORDER BY installation_date DESC NULLS LAST, legacy_id DESC LIMIT 10000`, params);
  const mapped = rows.map(mapInstallationRow);
  const headers = [
    "legacyId", "installationDateRaw", "clientName", "salesPerson", "vehicleReg", "model",
    "trackerNumber", "contact", "bank", "bankBranch", "technician", "tkStatus", "loanDuration",
    "expiryDateRaw", "imei", "amountQuoted", "status",
  ];
  const csv = buildCsv(headers, mapped);
  auditLog(req, "ARCHIVE_REPORT_EXPORTED", "archive:installations", "Info", { filters: parsed.data }).catch(console.error);
  return sendCsv(res, `archive_installations_${Date.now()}.csv`, csv);
});

// ── GET /api/archive/sales-by-bank — sales2.php equivalent ─────────────────────
const salesByBankQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  salesPerson: z.string().optional(),
});

async function computeSalesByBank(filters: z.infer<typeof salesByBankQuerySchema>) {
  // installation_date IS NOT NULL mirrors sales2.php's base query, which unconditionally
  // requires INSTALLATION_DATE to match a date-shaped regex (even with no date filter
  // applied) — rows with an unparseable/blank date are silently excluded from this report.
  const clauses: string[] = ["installation_date IS NOT NULL", "sales_person IS NOT NULL", "TRIM(sales_person) <> ''", "bank_raw IS NOT NULL", "TRIM(bank_raw) <> ''"];
  const params: any[] = [];
  if (filters.startDate) { clauses.push("installation_date >= ?"); params.push(filters.startDate); }
  if (filters.endDate) { clauses.push("installation_date <= ?"); params.push(filters.endDate); }
  if (filters.salesPerson) { clauses.push("LOWER(sales_person) = LOWER(?)"); params.push(filters.salesPerson); }

  const rows = await archiveAll<any>(
    `SELECT legacy_id, sales_person, bank_raw, vehicle_reg, contact, installation_date_raw,
            loan_duration, tracker_number, imei, amount_quoted
     FROM archive_installations WHERE ${clauses.join(" AND ")} ORDER BY legacy_id ASC`,
    params,
  );

  // Dual-tracker dedup — identical heuristic to sales2.php: two rows sharing the
  // same VEHICLE_REG|CONTACT key, with legacy IDs within 5 of each other, are
  // treated as one vehicle that got two trackers in the same install job.
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = `${r.vehicle_reg || ""}|${r.contact || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const dualGroupFirstId = new Set<number>();
  const isDualMember = new Set<number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ids = group.map((r) => r.legacy_id);
    if (Math.max(...ids) - Math.min(...ids) > 5) continue;
    const firstId = Math.min(...ids);
    dualGroupFirstId.add(firstId);
    for (const id of ids) isDualMember.add(id);
  }

  type Detail = { displaySalesPerson: string; records: any[] };
  const detail = new Map<string, Detail>();
  const summary = new Map<string, Map<string, { count: number; amount: number; displayBank: string }>>();

  for (const r of rows) {
    const spKey = String(r.sales_person).toLowerCase();
    const bankKey = String(r.bank_raw).trim().toLowerCase();
    if (!detail.has(spKey)) detail.set(spKey, { displaySalesPerson: titleCase(r.sales_person), records: [] });
    detail.get(spKey)!.records.push(r);

    // Summary counts each vehicle once — skip the non-first member of a dual-tracker group.
    if (isDualMember.has(r.legacy_id) && !dualGroupFirstId.has(r.legacy_id)) continue;

    if (!summary.has(spKey)) summary.set(spKey, new Map());
    const bankMap = summary.get(spKey)!;
    if (!bankMap.has(bankKey)) bankMap.set(bankKey, { count: 0, amount: 0, displayBank: bankDisplay(bankKey, r.bank_raw) });
    const entry = bankMap.get(bankKey)!;
    entry.count += 1;
    entry.amount += Number(r.amount_quoted) || 0;
  }

  let grandTotal = 0;
  const bySalesPerson = Array.from(summary.entries()).map(([spKey, bankMap]) => {
    const banks = Array.from(bankMap.values()).sort((a, b) => b.count - a.count);
    const totalVehicles = banks.reduce((s, b) => s + b.count, 0);
    const totalAmount = banks.reduce((s, b) => s + b.amount, 0);
    grandTotal += totalAmount;
    return {
      salesPerson: detail.get(spKey)!.displaySalesPerson,
      uniqueVehicles: totalVehicles,
      totalAmount,
      banks: banks.map((b) => ({ bank: b.displayBank, vehicles: b.count, amount: b.amount })),
    };
  }).sort((a, b) => b.totalAmount - a.totalAmount);

  const detailBySalesPerson = Array.from(detail.entries()).map(([spKey, d]) => ({
    salesPerson: d.displaySalesPerson,
    trackerCount: d.records.length,
    records: d.records.map((r) => ({
      legacyId: r.legacy_id,
      salesPerson: d.displaySalesPerson,
      bank: bankDisplay(String(r.bank_raw).trim().toLowerCase(), r.bank_raw),
      installationDateRaw: r.installation_date_raw,
      loanDuration: r.loan_duration,
      vehicleReg: r.vehicle_reg,
      contact: r.contact,
      imei: r.imei,
      trackerNumber: r.tracker_number,
      amountQuoted: Number(r.amount_quoted) || 0,
    })),
  }));

  return { grandTotal, bySalesPerson, detailBySalesPerson };
}

function titleCase(s: string): string {
  return String(s).trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
function bankDisplay(normKey: string, raw: string): string {
  if (normKey === "co-op" || /^(c0-op|c0op|c00p|coop|c-0p|c-o-p)$/.test(normKey)) return "Co-op";
  return titleCase(raw);
}

router.get("/sales-by-bank", requireAuth, requireRole(SALES_REPORT_ROLES), async (req, res) => {
  const parsed = salesByBankQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const report = await computeSalesByBank(parsed.data);
  auditLog(req, "ARCHIVE_REPORT_VIEWED", "archive:sales-by-bank", "Info", { filters: parsed.data }).catch(console.error);
  return res.status(200).json({ data: report });
});

router.get("/sales-by-bank.csv", requireAuth, requireRole(SALES_REPORT_ROLES), async (req, res) => {
  const parsed = salesByBankQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const report = await computeSalesByBank(parsed.data);
  const flatRows = report.detailBySalesPerson.flatMap((sp) => sp.records);
  const headers = ["legacyId", "salesPerson", "bank", "installationDateRaw", "loanDuration", "vehicleReg", "contact", "imei", "trackerNumber", "amountQuoted"];
  const csv = buildCsv(headers, flatRows);
  auditLog(req, "ARCHIVE_REPORT_EXPORTED", "archive:sales-by-bank", "Info", { filters: parsed.data }).catch(console.error);
  return sendCsv(res, `archive_sales_by_bank_${Date.now()}.csv`, csv);
});

// ── GET /api/archive/bank-report — bank.php equivalent ─────────────────────────
const bankReportQuerySchema = z.object({ startDate: z.string().optional(), endDate: z.string().optional() });

router.get("/bank-report", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = bankReportQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const clauses = ["installation_date IS NOT NULL", "bank_raw IS NOT NULL", "TRIM(bank_raw) <> ''"];
  const params: any[] = [];
  if (parsed.data.startDate) { clauses.push("installation_date >= ?"); params.push(parsed.data.startDate); }
  if (parsed.data.endDate) { clauses.push("installation_date <= ?"); params.push(parsed.data.endDate); }
  const rows = await archiveAll<any>(
    `SELECT sales_person, bank_raw, loan_duration, vehicle_reg, client_name, model, installation_date_raw
     FROM archive_installations WHERE ${clauses.join(" AND ")}`,
    params,
  );
  // bank.php does NOT exclude "Private" and does NOT dedupe dual-tracker rows — every
  // matching row counts, faithfully mirroring the source (unlike sales-by-bank).
  const byBank = new Map<string, { display: string; records: any[] }>();
  for (const r of rows) {
    const key = String(r.bank_raw).trim().toLowerCase();
    const normKey = /^(c0-op|c0op|c00p|co-op|coop|c-0p|c-o-p)$/.test(key) ? "co-op" : key;
    if (!byBank.has(normKey)) byBank.set(normKey, { display: bankDisplay(normKey, r.bank_raw), records: [] });
    byBank.get(normKey)!.records.push({
      bank: bankDisplay(normKey, r.bank_raw),
      installationDateRaw: r.installation_date_raw,
      salesPerson: titleCase(r.sales_person || ""),
      clientName: r.client_name,
      vehicleReg: r.vehicle_reg,
      model: r.model,
      loanDuration: r.loan_duration,
    });
  }
  const summary = Array.from(byBank.values())
    .map((b) => ({ bank: b.display, count: b.records.length }))
    .sort((a, b) => b.count - a.count);
  const detail = Array.from(byBank.values())
    .map((b) => ({ bank: b.display, count: b.records.length, records: b.records }))
    .sort((a, b) => b.count - a.count);
  auditLog(req, "ARCHIVE_REPORT_VIEWED", "archive:bank-report", "Info", { filters: parsed.data }).catch(console.error);
  return res.status(200).json({ data: { summary, detail } });
});

// ── GET /api/archive/technician-report — tech.php equivalent ───────────────────
const technicianReportQuerySchema = z.object({
  startDate: z.string().optional(), endDate: z.string().optional(), technician: z.string().optional(),
});

router.get("/technician-report", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = technicianReportQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const clauses = ["installation_date IS NOT NULL", "technician IS NOT NULL", "TRIM(technician) <> ''", "vehicle_reg IS NOT NULL", "TRIM(vehicle_reg) <> ''"];
  const params: any[] = [];
  if (parsed.data.startDate) { clauses.push("installation_date >= ?"); params.push(parsed.data.startDate); }
  if (parsed.data.endDate) { clauses.push("installation_date <= ?"); params.push(parsed.data.endDate); }
  if (parsed.data.technician) { clauses.push("LOWER(technician) = LOWER(?)"); params.push(parsed.data.technician); }
  const rows = await archiveAll<any>(
    `SELECT technician, vehicle_reg, contact, installation_date_raw, tracker_number, tracker_location, legacy_id
     FROM archive_installations WHERE ${clauses.join(" AND ")} ORDER BY legacy_id`,
    params,
  );
  const byTech = new Map<string, { display: string; vehicleKeys: Set<string>; gadgets: number; records: any[] }>();
  for (const r of rows) {
    const key = String(r.technician).trim().toLowerCase();
    if (!byTech.has(key)) byTech.set(key, { display: titleCase(r.technician), vehicleKeys: new Set(), gadgets: 0, records: [] });
    const entry = byTech.get(key)!;
    const vKey = `${String(r.vehicle_reg).toUpperCase().trim()}|${String(r.contact || "").trim()}`;
    entry.vehicleKeys.add(vKey);
    if (r.tracker_number) entry.gadgets += 1;
    entry.records.push({
      technician: entry.display,
      vehicleReg: String(r.vehicle_reg).toUpperCase().trim(),
      contact: r.contact,
      installationDateRaw: r.installation_date_raw,
      trackerNumber: r.tracker_number,
      trackerLocation: r.tracker_location,
      legacyId: r.legacy_id,
    });
  }
  const summary = Array.from(byTech.values())
    .map((t) => ({ technician: t.display, totalVehicles: t.vehicleKeys.size, totalGadgets: t.gadgets }))
    .sort((a, b) => b.totalVehicles - a.totalVehicles);
  const detail = Array.from(byTech.values())
    .map((t) => ({ technician: t.display, totalVehicles: t.vehicleKeys.size, totalGadgets: t.gadgets, records: t.records }))
    .sort((a, b) => b.totalVehicles - a.totalVehicles);
  auditLog(req, "ARCHIVE_REPORT_VIEWED", "archive:technician-report", "Info", { filters: parsed.data }).catch(console.error);
  return res.status(200).json({ data: { summary, detail } });
});

// ── GET /api/archive/tickets — finemarktickets.php equivalent (read-only) ──────
router.get("/tickets", requireAuth, requireRole(ARCHIVE_ROLES), async (_req, res) => {
  const tickets = await archiveAll<any>(`SELECT * FROM archive_tickets ORDER BY created_date DESC NULLS LAST, legacy_id DESC`);
  const summaryRows = await archiveAll<any>(`
    SELECT created_by,
      COUNT(*)::int AS created_count,
      COUNT(*) FILTER (WHERE status = 'CLOSED' AND closed_by = created_by)::int AS closed_by_self_count,
      COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open_count,
      COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS closed_count
    FROM archive_tickets GROUP BY created_by ORDER BY created_by
  `);
  return res.status(200).json({
    data: {
      tickets: tickets.map((t) => ({
        legacyId: t.legacy_id, ticketNumber: t.ticket_number, clientPhone: t.client_phone, vehicleReg: t.vehicle_reg,
        supportName: t.support_name, supportPhone: t.support_phone, ticketReason: t.ticket_reason, status: t.status,
        createdBy: t.created_by, createdDate: t.created_date, closedBy: t.closed_by, actionTaken: t.action_taken,
        closedAt: t.closed_at, ticketType: t.ticket_type,
      })),
      summary: summaryRows.map((s) => ({
        user: s.created_by, createdCount: s.created_count, closedBySelfCount: s.closed_by_self_count,
        openCount: s.open_count, closedCount: s.closed_count,
      })),
    },
  });
});

// ── GET /api/archive/audit-log — audit_log.php equivalent ──────────────────────
const auditLogQuerySchema = z.object({ vehicleReg: z.string().optional(), fromDate: z.string().optional(), toDate: z.string().optional() });

router.get("/audit-log", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = auditLogQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const clauses = ["a.action_summary IS NOT NULL"];
  const params: any[] = [];
  if (parsed.data.vehicleReg) { clauses.push("i.vehicle_reg ILIKE ?"); params.push(`%${parsed.data.vehicleReg}%`); }
  if (parsed.data.fromDate) { clauses.push("a.changed_at::date >= ?"); params.push(parsed.data.fromDate); }
  if (parsed.data.toDate) { clauses.push("a.changed_at::date <= ?"); params.push(parsed.data.toDate); }
  const rows = await archiveAll<any>(
    `SELECT a.legacy_id, a.installation_legacy_id, a.action_summary, a.changed_by, a.changed_at, i.vehicle_reg
     FROM archive_record_audit a LEFT JOIN archive_installations i ON i.legacy_id = a.installation_legacy_id
     WHERE ${clauses.join(" AND ")} ORDER BY a.changed_at DESC LIMIT 200`,
    params,
  );
  const parsed_logs = rows.map((r) => {
    const changes = String(r.action_summary || "").split(" | ").map((c) => c.trim()).filter(Boolean).map((c) => {
      const m = /^(.+?): (.+?) to (.+)$/.exec(c);
      if (!m) return null;
      return { field: m[1], oldValue: m[2] === "—" ? null : m[2], newValue: m[3] === "—" ? null : m[3] };
    }).filter(Boolean);
    return {
      legacyId: r.legacy_id, vehicleReg: r.vehicle_reg, changedBy: r.changed_by, changedAt: r.changed_at, changes,
    };
  });
  return res.status(200).json({ data: parsed_logs });
});

// ── GET /api/archive/removals-log — removals_log.php equivalent ────────────────
const removalsLogQuerySchema = z.object({ startDate: z.string().optional(), endDate: z.string().optional() });

router.get("/removals-log", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = removalsLogQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const clauses: string[] = [];
  const params: any[] = [];
  if (parsed.data.startDate) { clauses.push("deletion_date >= ?"); params.push(`${parsed.data.startDate} 00:00:00`); }
  if (parsed.data.endDate) { clauses.push("deletion_date <= ?"); params.push(`${parsed.data.endDate} 23:59:59`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await archiveAll<any>(`SELECT * FROM archive_removed_installations ${where} ORDER BY deletion_date DESC`, params);
  return res.status(200).json({
    data: rows.map((r) => ({
      legacyId: r.legacy_id, originalLegacyId: r.original_legacy_id, clientName: r.client_name, vehicleReg: r.vehicle_reg,
      imei: r.imei, installationDateRaw: r.installation_date_raw, deletedBy: r.deleted_by, deletionDate: r.deletion_date,
    })),
  });
});

// ── GET /api/archive/fuel-records — finemarksearch.php equivalent ──────────────
const fuelRecordsQuerySchema = z.object({
  startDate: z.string().optional(), endDate: z.string().optional(), clientName: z.string().optional(),
  contact: z.string().optional(), regNo: z.string().optional(), model: z.string().optional(),
  deviceType: z.string().optional(), trackerNo: z.string().optional(), technician: z.string().optional(),
  salesPerson: z.string().optional(),
});

function buildFuelQuery(f: z.infer<typeof fuelRecordsQuerySchema>) {
  const clauses: string[] = [];
  const params: any[] = [];
  if (f.startDate) { clauses.push("installation_date >= ?"); params.push(f.startDate); }
  if (f.endDate) { clauses.push("installation_date <= ?"); params.push(f.endDate); }
  if (f.clientName) { clauses.push("client_name ILIKE ?"); params.push(`%${f.clientName}%`); }
  if (f.contact) { clauses.push("contact ILIKE ?"); params.push(`%${f.contact}%`); }
  if (f.regNo) { clauses.push("reg_no ILIKE ?"); params.push(`%${f.regNo}%`); }
  if (f.model) { clauses.push("model ILIKE ?"); params.push(`%${f.model}%`); }
  if (f.deviceType) { clauses.push("device_type ILIKE ?"); params.push(`%${f.deviceType}%`); }
  if (f.trackerNo) { clauses.push("tracker_no ILIKE ?"); params.push(`%${f.trackerNo}%`); }
  if (f.technician) { clauses.push("technician ILIKE ?"); params.push(`%${f.technician}%`); }
  if (f.salesPerson) { clauses.push("sales_person ILIKE ?"); params.push(`%${f.salesPerson}%`); }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

router.get("/fuel-records/meta", requireAuth, requireRole(ARCHIVE_ROLES), async (_req, res) => {
  const technicians = await archiveAll<{ v: string }>(`SELECT DISTINCT technician AS v FROM archive_fuel_records WHERE technician IS NOT NULL AND TRIM(technician) <> '' ORDER BY 1`);
  const salesPeople = await archiveAll<{ v: string }>(`SELECT DISTINCT sales_person AS v FROM archive_fuel_records WHERE sales_person IS NOT NULL AND TRIM(sales_person) <> '' ORDER BY 1`);
  return res.status(200).json({ data: { technicians: technicians.map((r) => r.v), salesPeople: salesPeople.map((r) => r.v) } });
});

router.get("/fuel-records", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = fuelRecordsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const { where, params } = buildFuelQuery(parsed.data);
  const rows = await archiveAll<any>(`SELECT * FROM archive_fuel_records ${where} ORDER BY installation_date DESC NULLS LAST LIMIT 2000`, params);
  return res.status(200).json({
    data: rows.map((r) => ({
      legacyId: r.legacy_id, installationDate: r.installation_date, clientName: r.client_name, contact: r.contact,
      regNo: r.reg_no, model: r.model, deviceType: r.device_type, trackerNo: r.tracker_no,
      technician: r.technician, salesPerson: r.sales_person,
    })),
  });
});

router.get("/fuel-records.csv", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = fuelRecordsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const { where, params } = buildFuelQuery(parsed.data);
  const rows = await archiveAll<any>(`SELECT * FROM archive_fuel_records ${where} ORDER BY installation_date DESC NULLS LAST LIMIT 5000`, params);
  const headers = ["legacy_id", "client_name", "contact", "reg_no", "model", "device_type", "tracker_no", "technician", "sales_person", "installation_date"];
  const csv = buildCsv(headers, rows);
  return sendCsv(res, `archive_fuel_records_${Date.now()}.csv`, csv);
});

// ── GET /api/archive/speed-governors — speedgoverrecords.php equivalent ────────
const speedGovQuerySchema = z.object({
  startDate: z.string().optional(), endDate: z.string().optional(), technician: z.string().optional(), salesPerson: z.string().optional(),
});

router.get("/speed-governors", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = speedGovQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const clauses: string[] = [];
  const params: any[] = [];
  if (parsed.data.startDate) { clauses.push("installation_date >= ?"); params.push(parsed.data.startDate); }
  if (parsed.data.endDate) { clauses.push("installation_date <= ?"); params.push(parsed.data.endDate); }
  if (parsed.data.technician) { clauses.push("technician = ?"); params.push(parsed.data.technician); }
  if (parsed.data.salesPerson) { clauses.push("sales_person = ?"); params.push(parsed.data.salesPerson); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await archiveAll<any>(`SELECT * FROM archive_speedgovernors ${where} ORDER BY installation_date DESC NULLS LAST`, params);
  return res.status(200).json({
    data: rows.map((r) => ({
      legacyId: r.legacy_id, installationDate: r.installation_date, clientName: r.client_name, contact: r.contact,
      regNo: r.reg_no, model: r.model, deviceType: r.device_type, technician: r.technician,
      salesPerson: r.sales_person, comments: r.comments,
    })),
  });
});

// ── GET /api/archive/gadget-batches — distinct batch list for the range pickers ─
router.get("/gadget-batches", requireAuth, requireRole(ARCHIVE_ROLES), async (_req, res) => {
  const rows = await archiveAll<{ batch: string }>(`SELECT DISTINCT batch FROM archive_gadgets WHERE batch IS NOT NULL ORDER BY batch`);
  return res.status(200).json({ data: rows.map((r) => r.batch) });
});

// ── GET /api/archive/gadget-batch-report — gadgetsreport.php / gadgetsreport2.php ─
const gadgetBatchReportQuerySchema = z.object({ fromBatch: z.string(), toBatch: z.string() });

router.get("/gadget-batch-report", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const parsed = gadgetBatchReportQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "fromBatch and toBatch are required", parsed.error.flatten());
  const { fromBatch, toBatch } = parsed.data;
  const gadgets = await archiveAll<any>(`SELECT imei, batch FROM archive_gadgets WHERE batch BETWEEN ? AND ?`, [fromBatch, toBatch]);
  const imeis = gadgets.map((g) => g.imei);
  let matching: any[] = [];
  let unused: any[] = [];
  if (imeis.length) {
    const placeholders = imeis.map(() => "?").join(",");
    matching = await archiveAll<any>(
      `SELECT imei, vehicle_reg, technician, installation_date_raw FROM archive_installations WHERE imei IN (${placeholders})`,
      imeis,
    );
    const usedImeis = new Set(matching.map((m) => m.imei));
    const notUsed = imeis.filter((i) => !usedImeis.has(i));
    if (notUsed.length) {
      const ph2 = notUsed.map(() => "?").join(",");
      const allocations = await archiveAll<any>(`SELECT gadget_imei, technician FROM archive_technician_allocations WHERE gadget_imei IN (${ph2})`, notUsed);
      const allocByImei = new Map(allocations.map((a) => [a.gadget_imei, a.technician]));
      unused = notUsed.map((imei) => ({ imei, technician: allocByImei.get(imei) || "Not Allocated" }));
    }
  }
  const batchOf = new Map(gadgets.map((g) => [g.imei, g.batch]));
  const batchTotals = new Map<string, { total: number; used: number; unused: number }>();
  for (const g of gadgets) {
    if (!batchTotals.has(g.batch)) batchTotals.set(g.batch, { total: 0, used: 0, unused: 0 });
    batchTotals.get(g.batch)!.total += 1;
  }
  for (const m of matching) {
    const b = batchOf.get(m.imei);
    if (b && batchTotals.has(b)) batchTotals.get(b)!.used += 1;
  }
  for (const u of unused) {
    const b = batchOf.get(u.imei);
    if (b && batchTotals.has(b)) batchTotals.get(b)!.unused += 1;
  }
  const batchSummary = Array.from(batchTotals.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([batch, counts]) => ({ batch, ...counts }));
  return res.status(200).json({
    data: {
      totalImeisInRange: imeis.length,
      batchSummary,
      matching: matching.map((m) => ({ imei: m.imei, vehicleReg: m.vehicle_reg, technician: m.technician, installDate: m.installation_date_raw, batch: batchOf.get(m.imei) })),
      unused: unused.map((u) => ({ imei: u.imei, technician: u.technician, batch: batchOf.get(u.imei) })),
    },
  });
});

// ── GET /api/archive/gadgets-in-store — gadgets_in_store.php equivalent ────────
router.get("/gadgets-in-store", requireAuth, requireRole(ARCHIVE_ROLES), async (_req, res) => {
  const rows = await archiveAll<any>(`
    SELECT ag.batch, ag.gadget_type, ag.imei
    FROM archive_gadgets ag
    LEFT JOIN archive_technician_allocations ta ON TRIM(ag.imei) = TRIM(ta.gadget_imei)
    LEFT JOIN archive_installations i ON TRIM(ag.imei) = TRIM(i.imei)
    WHERE ta.gadget_imei IS NULL AND i.imei IS NULL
    ORDER BY ag.batch ASC
  `);
  const summary = new Map<string, number>();
  for (const r of rows) summary.set(r.batch, (summary.get(r.batch) || 0) + 1);
  return res.status(200).json({
    data: {
      summary: Array.from(summary.entries()).map(([batch, count]) => ({ batch, count })),
      gadgets: rows.map((r) => ({ batch: r.batch, imei: r.imei, gadgetType: r.gadget_type })),
    },
  });
});

// ── GET /api/archive/gadgets-at-hand — remaining_gadgets.php equivalent (read-only) ─
const EXCLUDED_TRANSFER_IMEIS = ["355139085772496", "355139085774872", "355139085766118", "355139085674221"];

router.get("/gadgets-at-hand", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const batch = typeof req.query.batch === "string" ? req.query.batch : undefined;
  const technician = typeof req.query.technician === "string" ? req.query.technician : undefined;
  const excludedPlaceholders = EXCLUDED_TRANSFER_IMEIS.map(() => "?").join(",");

  let outOfStoreSql = `
    SELECT DISTINCT ta.gadget_imei, ag.gadget_type, ta.technician, ag.arrival_date, ag.batch, s.msisdn
    FROM archive_technician_allocations ta
    JOIN archive_gadgets ag ON ta.gadget_imei = ag.imei
    LEFT JOIN archive_sims s ON ta.imsi = s.imsi
    LEFT JOIN archive_installations i ON ta.gadget_imei = i.imei
    WHERE i.imei IS NULL AND ta.gadget_imei NOT IN (${excludedPlaceholders})`;
  const outParams: any[] = [...EXCLUDED_TRANSFER_IMEIS];
  if (batch) { outOfStoreSql += " AND ag.batch = ?"; outParams.push(batch); }
  if (technician) { outOfStoreSql += " AND ta.technician = ?"; outParams.push(technician); }
  outOfStoreSql += " ORDER BY ag.batch ASC, ta.technician";
  const outOfStore = await archiveAll<any>(outOfStoreSql, outParams);

  let remainingSql = `
    SELECT DISTINCT ag.imei, ag.gadget_type, ag.arrival_date, ag.batch
    FROM archive_gadgets ag
    LEFT JOIN archive_installations i ON ag.imei = i.imei
    LEFT JOIN archive_technician_allocations ta ON ag.imei = ta.gadget_imei
    WHERE i.imei IS NULL AND ta.gadget_imei IS NULL`;
  const remParams: any[] = [];
  if (batch) { remainingSql += " AND ag.batch = ?"; remParams.push(batch); }
  remainingSql += " ORDER BY ag.batch ASC, ag.arrival_date ASC";
  const remaining = await archiveAll<any>(remainingSql, remParams);

  const technicianCountsRows = await archiveAll<any>(`
    SELECT ta.technician, COUNT(ta.gadget_imei)::int AS gadget_count
    FROM archive_technician_allocations ta
    JOIN archive_gadgets ag ON ta.gadget_imei = ag.imei
    LEFT JOIN archive_installations i ON ta.gadget_imei = i.imei
    WHERE i.imei IS NULL AND ta.gadget_imei NOT IN (${excludedPlaceholders})
    GROUP BY ta.technician ORDER BY gadget_count DESC
  `, EXCLUDED_TRANSFER_IMEIS);

  return res.status(200).json({
    data: {
      outOfStore: outOfStore.map((r) => ({ imei: r.gadget_imei, gadgetType: r.gadget_type, technician: r.technician, arrivalDate: r.arrival_date, batch: r.batch, msisdn: r.msisdn })),
      remainingInStore: remaining.map((r) => ({ imei: r.imei, gadgetType: r.gadget_type, arrivalDate: r.arrival_date, batch: r.batch })),
      technicianCounts: technicianCountsRows.map((r) => ({ technician: r.technician, gadgetCount: r.gadget_count })),
    },
  });
});

// ── GET /api/archive/sim-inventory — fetch_by_batch.php equivalent ─────────────
// Postgres port of the original's fuzzy MSISDN/tracker-number join (handles a
// leading '0' and 12-vs-13-digit variants between IOTSIMCARDS.MSISDN and the
// TRACKER_NUMBER/TRACKER_NO fields it's matched against).
router.get("/sim-inventory", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const batch = typeof req.query.batch === "string" ? req.query.batch.trim() : "";
  if (!batch) return errorResponse(res, 400, "VALIDATION_ERROR", "batch is required");

  const trackerJoin = (trackerCol: string) => `
    (
      REPLACE(${trackerCol}, ' ', '') = REPLACE(s.msisdn, ' ', '')
      OR (LENGTH(REPLACE(${trackerCol}, ' ', '')) = 13 AND SUBSTRING(REPLACE(${trackerCol}, ' ', ''), 2) = REPLACE(s.msisdn, ' ', ''))
      OR (LENGTH(REPLACE(s.msisdn, ' ', '')) = 12 AND REPLACE(${trackerCol}, ' ', '') = CONCAT('0', REPLACE(s.msisdn, ' ', '')))
    )
  `;

  const rows = await archiveAll<any>(
    `
    SELECT
      s.msisdn, s.imsi,
      i1.vehicle_reg AS r10_vehicle_reg_imsi, i2.vehicle_reg AS r10_vehicle_reg_tracker,
      i1.bank_raw AS r10_bank_imsi, i2.bank_raw AS r10_bank_tracker,
      i1.installation_date_raw AS r10_date_imsi, i2.installation_date_raw AS r10_date_tracker,
      f1.reg_no AS ffr_reg_imsi, f2.reg_no AS ffr_reg_tracker,
      f1.installation_date AS ffr_date_imsi, f2.installation_date AS ffr_date_tracker,
      f1.client_name AS ffr_client_imsi, f2.client_name AS ffr_client_tracker,
      ta.technician, ta.date_of_allocation, ta.gadget_type
    FROM archive_sims s
    LEFT JOIN archive_installations i1 ON s.imsi = i1.imei
    LEFT JOIN archive_installations i2 ON i2.tracker_number IS NOT NULL AND ${trackerJoin("i2.tracker_number")}
    LEFT JOIN archive_fuel_records f1 ON s.imsi = f1.tracker_no
    LEFT JOIN archive_fuel_records f2 ON f2.tracker_no IS NOT NULL AND ${trackerJoin("f2.tracker_no")}
    LEFT JOIN archive_technician_allocations ta ON s.imsi = ta.imsi
    WHERE s.batch = ?
    `,
    [batch],
  );

  const used: any[] = [];
  const allocatedUnused: any[] = [];
  const unallocatedUnused: any[] = [];
  for (const r of rows) {
    const isUsed = r.r10_vehicle_reg_imsi || r.r10_vehicle_reg_tracker || r.ffr_reg_imsi || r.ffr_reg_tracker;
    if (isUsed) {
      let source = "Unlinked", vehicleReg = "N/A", extra = "N/A", installDate = "N/A";
      if (r.r10_vehicle_reg_imsi || r.r10_vehicle_reg_tracker) {
        source = "Normal Tracking";
        vehicleReg = r.r10_vehicle_reg_imsi || r.r10_vehicle_reg_tracker;
        extra = `Bank: ${r.r10_bank_imsi || r.r10_bank_tracker || ""}`;
        installDate = r.r10_date_imsi || r.r10_date_tracker;
      } else if (r.ffr_reg_imsi || r.ffr_reg_tracker) {
        source = "Fuel";
        vehicleReg = r.ffr_reg_imsi || r.ffr_reg_tracker;
        extra = `Client: ${r.ffr_client_imsi || r.ffr_client_tracker || ""}`;
        installDate = r.ffr_date_imsi || r.ffr_date_tracker;
      }
      used.push({ msisdn: r.msisdn, imsi: r.imsi, source, vehicleReg, extra, installDate });
    } else if (r.technician) {
      allocatedUnused.push({ msisdn: r.msisdn, imsi: r.imsi, technician: r.technician, dateAllocated: r.date_of_allocation, gadgetType: r.gadget_type });
    } else {
      unallocatedUnused.push({ msisdn: r.msisdn, imsi: r.imsi });
    }
  }
  return res.status(200).json({
    data: {
      totalSimsInBatch: rows.length,
      usedCount: used.length, allocatedUnusedCount: allocatedUnused.length, unallocatedUnusedCount: unallocatedUnused.length,
      used, allocatedUnused, unallocatedUnused,
    },
  });
});

// ── GET /api/archive/certificates — admin/getcert.php equivalent ──────────────
// Filesystem-backed, not the archive Postgres DB: the source is a bind-mounted,
// read-only directory of legacy IDTS-generated certificate PDFs (13GB, ~4,150
// files, never copied — see docker-compose.yml). Filenames follow
// "Certificate_<VEHICLE REG>.pdf"; vehicle reg is extracted from the name.
const CERT_DIR = path.join(process.cwd(), "archive-certificates");

function listCertFiles() {
  let names: string[];
  try {
    names = fs.readdirSync(CERT_DIR).filter((n) => n.toLowerCase().endsWith(".pdf"));
  } catch {
    return [];
  }
  return names.map((name) => {
    const stat = fs.statSync(path.join(CERT_DIR, name));
    const m = /^Certificate_(.+)\.pdf$/i.exec(name);
    return {
      filename: name,
      vehicleReg: m ? m[1].trim() : name.replace(/\.pdf$/i, ""),
      sizeBytes: stat.size,
      lastModified: stat.mtime.toISOString(),
    };
  });
}

// Only ever resolves to a plain filename that literally exists in CERT_DIR —
// path.basename strips any directory components, and the membership check
// below means a crafted "../../etc/passwd"-style value simply won't match.
function safeCertPath(rawFilename: string): string | null {
  const base = path.basename(rawFilename);
  const resolved = path.join(CERT_DIR, base);
  if (path.dirname(resolved) !== CERT_DIR) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

const certListQuerySchema = z.object({
  search: z.string().optional(),
  sort: z.enum(["name", "date"]).optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

router.get("/certificates", requireAuth, requireRole(CERT_ARCHIVE_ROLES), async (req, res) => {
  const parsed = certListQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const { parsedPage, parsedPageSize } = parsePaging(parsed.data.page, parsed.data.pageSize || "60");

  let files = listCertFiles();
  if (parsed.data.search) {
    const q = parsed.data.search.toLowerCase();
    files = files.filter((f) => f.vehicleReg.toLowerCase().includes(q) || f.filename.toLowerCase().includes(q));
  }
  files.sort((a, b) => parsed.data.sort === "date"
    ? new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
    : a.filename.localeCompare(b.filename));

  const total = files.length;
  const offset = (parsedPage - 1) * parsedPageSize;
  const page = files.slice(offset, offset + parsedPageSize);

  auditLog(req, "ARCHIVE_REPORT_VIEWED", "archive:certificates", "Info", { search: parsed.data.search }).catch(console.error);
  return res.status(200).json({ data: page, meta: { total, page: parsedPage, pageSize: parsedPageSize } });
});

router.get("/certificates/file/:filename", requireAuth, requireRole(CERT_ARCHIVE_ROLES), async (req, res) => {
  const filePath = safeCertPath(req.params.filename);
  if (!filePath) return errorResponse(res, 404, "NOT_FOUND", "Certificate not found.");
  const download = req.query.download === "1";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${path.basename(filePath)}"`);
  auditLog(req, download ? "ARCHIVE_CERT_DOWNLOADED" : "ARCHIVE_CERT_VIEWED", `archive:certificate:${path.basename(filePath)}`, "Info", {}).catch(console.error);
  fs.createReadStream(filePath).pipe(res);
});

// ── Retired inventory (live inv_items → archive report) ────────────────────
// GET /api/archive/retired-inventory — read-only report of devices already
// swept out of the live ledger.
router.get("/retired-inventory", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const { parsedPage, parsedPageSize } = parsePaging(req.query.page as string, req.query.pageSize as string);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";

  const where: string[] = [];
  const params: any[] = [];
  if (search) {
    where.push(`(serial_number ILIKE ? OR imei ILIKE ? OR product_name ILIKE ? OR product_code ILIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (status) { where.push(`status_at_archive = ?`); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await archiveAll<any>(
    `SELECT * FROM archive_retired_inventory ${whereSql} ORDER BY archived_at DESC LIMIT ? OFFSET ?`,
    [...params, parsedPageSize, (parsedPage - 1) * parsedPageSize]
  );
  const totalRow = await archiveGet<{ total: string }>(`SELECT COUNT(*) as total FROM archive_retired_inventory ${whereSql}`, params);
  const summaryRows = await archiveAll<{ status_at_archive: string; count: number }>(
    `SELECT status_at_archive, COUNT(*)::int as count FROM archive_retired_inventory ${whereSql} GROUP BY status_at_archive ORDER BY count DESC`,
    params
  );

  auditLog(req, "ARCHIVE_REPORT_VIEWED", "archive:retired-inventory", "Info", { search, status }).catch(console.error);
  return ok(res, {
    data: rows.map((r) => ({
      id: r.id, sourceItemId: r.source_item_id, productId: r.product_id,
      productName: r.product_name, productCode: r.product_code, serialNumber: r.serial_number,
      imei: r.imei, macAddress: r.mac_address, statusAtArchive: r.status_at_archive,
      warehouseLocation: r.warehouse_location, purchaseDate: r.purchase_date, purchasePrice: r.purchase_price,
      notes: r.notes, sourceCreatedAt: r.source_created_at, archivedAt: r.archived_at, archivedByName: r.archived_by_name,
    })),
    meta: { total: Number(totalRow?.total || 0), page: parsedPage, pageSize: parsedPageSize },
    summary: summaryRows.map((s) => ({ status: s.status_at_archive, count: s.count })),
  });
});

// GET /api/archive/retired-inventory/eligible-count — live preview of what a
// sweep would archive, without changing anything. Lets the UI show real
// numbers before the (irreversible-looking, though actually soft-delete)
// sweep action runs.
router.get("/retired-inventory/eligible-count", requireAuth, requireRole(INVENTORY_ARCHIVE_ROLES), async (_req, res) => {
  const placeholders = RETIRED_INVENTORY_STATUSES.map(() => "?").join(",");
  const rows = await pgAll<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM inv_items
     WHERE deleted_at IS NULL AND issued_to_id IS NULL AND status IN (${placeholders})
     GROUP BY status ORDER BY count DESC`,
    RETIRED_INVENTORY_STATUSES
  );
  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  return ok(res, { total, byStatus: rows.map((r) => ({ status: r.status, count: Number(r.count) })) });
});

// POST /api/archive/retired-inventory/sweep — moves every unallocated,
// uninstalled device (status in RETIRED_INVENTORY_STATUSES, issued_to_id
// NULL) into archive_retired_inventory, then soft-deletes it from the live
// inv_items ledger (deleted_at set — every live query already filters on
// deleted_at IS NULL, so this is reversible: clearing deleted_at restores a
// device to live inventory). inv_movements history is left untouched.
// Archive-insert happens before the live soft-delete for each row, so a
// failure never loses data — worst case a row is temporarily duplicated.
router.post("/retired-inventory/sweep", requireAuth, requireRole(INVENTORY_ARCHIVE_ROLES), async (req: AuthRequest, res) => {
  const placeholders = RETIRED_INVENTORY_STATUSES.map(() => "?").join(",");
  const items = await pgAll<any>(
    `SELECT i.*, p.product_name, p.product_code FROM inv_items i
     LEFT JOIN inv_product_catalog p ON p.id = i.product_id
     WHERE i.deleted_at IS NULL AND i.issued_to_id IS NULL AND i.status IN (${placeholders})`,
    RETIRED_INVENTORY_STATUSES
  );
  if (!items.length) return ok(res, { archived: 0, failed: 0 }, "No unallocated, uninstalled devices to archive.");

  const now = new Date().toISOString();
  let archived = 0;
  const failures: { id: string; reason: string }[] = [];

  for (const item of items) {
    try {
      await archiveRun(
        `INSERT INTO archive_retired_inventory
           (id, source_item_id, product_id, product_name, product_code, serial_number, imei, mac_address, status_at_archive,
            warehouse_location, purchase_date, purchase_price, notes, source_created_at,
            archived_by_user_id, archived_by_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (source_item_id) DO NOTHING`,
        [
          uuidv4(), item.id, item.product_id, item.product_name, item.product_code, item.serial_number, item.imei, item.mac_address, item.status,
          item.warehouse_location, item.purchase_date, item.purchase_price, item.notes, item.created_at,
          req.user!.id, req.user!.email,
        ]
      );
      await pgRun(`UPDATE inv_items SET deleted_at = ?, updated_at = ? WHERE id = ?`, [now, now, item.id]);
      archived++;
    } catch (err: any) {
      failures.push({ id: item.id, reason: err?.message || String(err) });
      console.error(`[ArchiveRetiredInventory] Failed to archive inv_item ${item.id}:`, err);
    }
  }

  auditLog(req, "ARCHIVE_INVENTORY_SWEPT", "archive:retired-inventory", "Info", { archived, failed: failures.length }).catch(console.error);
  return ok(
    res,
    { archived, failed: failures.length, failures },
    `${archived} device(s) archived and removed from the live inventory ledger.${failures.length ? ` ${failures.length} failed — see failures.` : ""}`
  );
});

// ── Retired SIMs (live inv_sims → archive report) — same pattern as retired
// inventory above, applied to inv_sims/inv_sim_ledger instead of inv_items/inv_movements.
router.get("/retired-sims", requireAuth, requireRole(ARCHIVE_ROLES), async (req, res) => {
  const { parsedPage, parsedPageSize } = parsePaging(req.query.page as string, req.query.pageSize as string);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";

  const where: string[] = [];
  const params: any[] = [];
  if (search) {
    where.push(`(iccid ILIKE ? OR imsi ILIKE ? OR msisdn ILIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (status) { where.push(`status_at_archive = ?`); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await archiveAll<any>(
    `SELECT * FROM archive_retired_sims ${whereSql} ORDER BY archived_at DESC LIMIT ? OFFSET ?`,
    [...params, parsedPageSize, (parsedPage - 1) * parsedPageSize]
  );
  const totalRow = await archiveGet<{ total: string }>(`SELECT COUNT(*) as total FROM archive_retired_sims ${whereSql}`, params);
  const summaryRows = await archiveAll<{ status_at_archive: string; count: number }>(
    `SELECT status_at_archive, COUNT(*)::int as count FROM archive_retired_sims ${whereSql} GROUP BY status_at_archive ORDER BY count DESC`,
    params
  );

  auditLog(req, "ARCHIVE_REPORT_VIEWED", "archive:retired-sims", "Info", { search, status }).catch(console.error);
  return ok(res, {
    data: rows.map((r) => ({
      id: r.id, sourceSimId: r.source_sim_id, iccid: r.iccid, imsi: r.imsi, msisdn: r.msisdn,
      operator: r.operator, plan: r.plan, simType: r.sim_type, statusAtArchive: r.status_at_archive,
      activationDate: r.activation_date, expiryDate: r.expiry_date, notes: r.notes,
      sourceCreatedAt: r.source_created_at, archivedAt: r.archived_at, archivedByName: r.archived_by_name,
    })),
    meta: { total: Number(totalRow?.total || 0), page: parsedPage, pageSize: parsedPageSize },
    summary: summaryRows.map((s) => ({ status: s.status_at_archive, count: s.count })),
  });
});

router.get("/retired-sims/eligible-count", requireAuth, requireRole(INVENTORY_ARCHIVE_ROLES), async (_req, res) => {
  const placeholders = RETIRED_SIM_STATUSES.map(() => "?").join(",");
  const rows = await pgAll<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM inv_sims
     WHERE deleted_at IS NULL AND issued_to_id IS NULL AND status IN (${placeholders})
     GROUP BY status ORDER BY count DESC`,
    RETIRED_SIM_STATUSES
  );
  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  return ok(res, { total, byStatus: rows.map((r) => ({ status: r.status, count: Number(r.count) })) });
});

router.post("/retired-sims/sweep", requireAuth, requireRole(INVENTORY_ARCHIVE_ROLES), async (req: AuthRequest, res) => {
  const placeholders = RETIRED_SIM_STATUSES.map(() => "?").join(",");
  const sims = await pgAll<any>(
    `SELECT * FROM inv_sims WHERE deleted_at IS NULL AND issued_to_id IS NULL AND status IN (${placeholders})`,
    RETIRED_SIM_STATUSES
  );
  if (!sims.length) return ok(res, { archived: 0, failed: 0 }, "No unallocated, uninstalled SIMs to archive.");

  const now = new Date().toISOString();
  let archived = 0;
  const failures: { id: string; reason: string }[] = [];

  for (const sim of sims) {
    try {
      await archiveRun(
        `INSERT INTO archive_retired_sims
           (id, source_sim_id, iccid, imsi, msisdn, operator, plan, sim_type, status_at_archive,
            activation_date, expiry_date, notes, source_created_at, archived_by_user_id, archived_by_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (source_sim_id) DO NOTHING`,
        [
          uuidv4(), sim.id, sim.iccid, sim.imsi, sim.msisdn, sim.operator, sim.plan, sim.sim_type, sim.status,
          sim.activation_date, sim.expiry_date, sim.notes, sim.created_at,
          req.user!.id, req.user!.email,
        ]
      );
      await pgRun(`UPDATE inv_sims SET deleted_at = ?, updated_at = ? WHERE id = ?`, [now, now, sim.id]);
      archived++;
    } catch (err: any) {
      failures.push({ id: sim.id, reason: err?.message || String(err) });
      console.error(`[ArchiveRetiredSims] Failed to archive inv_sim ${sim.id}:`, err);
    }
  }

  auditLog(req, "ARCHIVE_SIMS_SWEPT", "archive:retired-sims", "Info", { archived, failed: failures.length }).catch(console.error);
  return ok(
    res,
    { archived, failed: failures.length, failures },
    `${archived} SIM(s) archived and removed from the live inventory ledger.${failures.length ? ` ${failures.length} failed — see failures.` : ""}`
  );
});

export default router;
