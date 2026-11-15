import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { salesByBankQuerySchema } from "../utils/financeValidators.js";
import { listSalesByBank } from "../services/reportService.js";
import { auditLog } from "../services/auditService.js";
import { buildCsv, sendCsv } from "../utils/csv.js";
import { pgAll, pgGet, pgRun } from "../db.js";

const router = Router();

/** Sales-people commission rate parameters. One row per bank (bank_key = uppercased
 *  name) + special keys: __DEFAULT__ (unlisted banks), __PRIVATE__ (non-bank-financed
 *  deals), __WHT__ (withholding-tax %). Adjustable from the Sales Commission report tab. */
export const initSalesCommissionSchema = async () => {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS sales_commission_rates (
      bank_key   TEXT PRIMARY KEY,
      rate_pct   DOUBLE PRECISION NOT NULL,
      updated_at TEXT,
      updated_by TEXT
    )
  `);
  // Bank × loan-years commission structure (validated payout list). Stored as one JSON
  // document so Finance edits it as a whole table (replace-all, audited).
  await pgRun(`
    CREATE TABLE IF NOT EXISTS sales_commission_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT,
      updated_by TEXT
    )
  `);
  // Seed ONCE with the validated structure; later edits (incl. deletions) are kept.
  await pgRun(
    `INSERT INTO sales_commission_settings (key, value, updated_at, updated_by)
     VALUES ('matrix', ?, ?, 'system-seed') ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(SC_MATRIX_SEED), new Date().toISOString()]
  );
  console.log("[reports] Sales-commission schema ready");
};

/* ── Commission structure (bank × loan years) ─────────────────────────────────
 * Each cell = the retail price charged, the bank/SACCO commission and the
 * validated salesperson commission (KES per vehicle). Payout per receipt =
 * amount retained × (sales commission ÷ (price − bank commission)), so a fully
 * paid deal at the schedule price pays exactly the validated amount and part
 * payments pay pro-rata. */
type ScTier = { years: number; price: number; bankCommission: number; salesCommission: number };
type ScMatrixBank = { bank: string; aliases: string[]; tiers: ScTier[] };

const seedBank = (bank: string, aliases: string[], cells: [number, number, number][]): ScMatrixBank => ({
  bank, aliases,
  tiers: cells.map(([price, bankCommission, salesCommission], i) => ({ years: i + 1, price, bankCommission, salesCommission })),
});
// Validated 2026-11-10 (Retail Pricing Schedule + first-year-full / extra-years-half structure).
const SC_MATRIX_SEED: ScMatrixBank[] = [
  seedBank("NCBA", [], [[22717, 5000, 709], [37889, 5000, 1012], [53062, 10000, 1216], [68235, 12000, 1479], [83407, 15000, 1722], [98580, 17000, 1986]]),
  seedBank("COOPERATIVE", ["CO-OP", "COOP", "CO OPERATIVE"], [[35000, 5000, 3000], [45000, 5000, 3500], [55000, 10000, 3750], [65000, 12000, 4150], [70000, 15000, 4250], [75000, 17000, 4400]]),
  seedBank("STANBIC", ["CFC STANBIC"], [[30000, 0, 1200], [37000, 0, 1340], [47000, 0, 1540], [60000, 0, 1800], [65000, 0, 1900], [70000, 0, 2000]]),
  seedBank("DTB", ["DIAMOND TRUST"], [[15000, 0, 1500], [25000, 0, 2000], [35000, 0, 2500], [45000, 0, 3000], [55000, 0, 3500], [65000, 0, 4000]]),
  seedBank("SIDIAN", [], [[21000, 5000, 1600], [29000, 5000, 2000], [38000, 5000, 2450], [46000, 10000, 2600], [50000, 10000, 2800]]),
  seedBank("EQUITY", [], [[10000, 0, 1000], [12000, 0, 1100], [14000, 0, 1200], [16000, 0, 1300], [18000, 0, 1400], [20000, 0, 1500]]),
  seedBank("TOWER SACCO", ["TOWER"], [[24000, 9000, 1500], [24000, 9000, 1500], [24000, 9000, 1500], [24000, 9000, 1500], [24000, 9000, 1500]]),
];
export const SC_MAX_YEARS = 6;

async function loadCommissionMatrix(): Promise<{ banks: ScMatrixBank[]; updatedAt: string | null; updatedBy: string | null }> {
  const row: any = await pgGet(`SELECT value, updated_at, updated_by FROM sales_commission_settings WHERE key = 'matrix'`);
  let banks: ScMatrixBank[] = [];
  try { banks = row ? JSON.parse(row.value) : []; } catch { banks = []; }
  return { banks: Array.isArray(banks) ? banks : [], updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null };
}

/** Normalise a bank name for matching: "Co-operative Bank of Kenya Ltd" → "COOPERATIVEOF". */
const NOISE = new Set(["BANK", "KENYA", "LIMITED", "LTD", "PLC", "THE", "GROUP", "OF", "K"]);
const normBank = (s: string) =>
  String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/).filter((w) => w && !NOISE.has(w)).join("");

/** Find the structure bank a deal's bank string belongs to (longest key/alias match wins). */
function matchMatrixBank(banks: ScMatrixBank[], bank: string): ScMatrixBank | null {
  const n = normBank(bank);
  if (!n) return null;
  let best: ScMatrixBank | null = null, bestLen = 0;
  for (const b of banks) {
    for (const k of [b.bank, ...(b.aliases || [])].map(normBank)) {
      if (k && (n === k || n.includes(k)) && k.length > bestLen) { best = b; bestLen = k.length; }
    }
  }
  return best;
}

/** Loan months → structure year column (same rule as bank-financed quoting: ceil, 1..6). */
const loanYears = (months: number | null) =>
  months == null || !Number.isFinite(months) || months <= 0 ? null : Math.min(SC_MAX_YEARS, Math.max(1, Math.ceil(months / 12)));

const FINANCE_REPORT_ROLES = ["Admin", "Finance", "Executive"];
// Report date = tax date, else issued date, else created — normalised to YYYY-MM-DD.
const INV_DATE = "substr(COALESCE(NULLIF(i.tax_date,''), NULLIF(i.issued_on,''), i.created_at),1,10)";
const dateWhere = (from?: string, to?: string) => {
  const clauses: string[] = []; const params: any[] = [];
  if (from) { clauses.push(`${INV_DATE} >= ?`); params.push(from); }
  if (to)   { clauses.push(`${INV_DATE} <= ?`); params.push(to); }
  return { where: clauses.length ? `AND ${clauses.join(" AND ")}` : "", params };
};
// Generic YYYY-MM-DD range filter on an arbitrary date column (payments.paid_at,
// referrer_payments.payment_date …). Both are TEXT — take the first 10 chars.
const colDateWhere = (col: string, from?: string, to?: string) => {
  const clauses: string[] = []; const params: any[] = [];
  if (from) { clauses.push(`substr(${col},1,10) >= ?`); params.push(from); }
  if (to)   { clauses.push(`substr(${col},1,10) <= ?`); params.push(to); }
  return { where: clauses.length ? `AND ${clauses.join(" AND ")}` : "", params };
};
// Whole days between a YYYY-MM-DD(THH…) string and today (UTC), floored at 0.
const ageDays = (dateStr?: string | null): number => {
  if (!dateStr) return 0;
  const d = Date.parse(String(dateStr).slice(0, 10));
  if (Number.isNaN(d)) return 0;
  return Math.max(0, Math.floor((Date.now() - d) / 86400000));
};
const ageBucket = (days: number): string =>
  days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";

const parsePaging = (page?: string, pageSize?: string) => ({
  parsedPage: Math.max(parseInt(page || "1", 10) || 1, 1),
  parsedPageSize: Math.min(parseInt(pageSize || "50", 10) || 50, 200),
});

router.get("/sales-by-bank", requireAuth, requireRole(["Sales", "Admin", "BDM", "BDMCorporate", "Telesales", "FieldSales"]), async (req, res) => {
  const parsed = salesByBankQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const { parsedPage, parsedPageSize } = parsePaging(parsed.data.page, parsed.data.pageSize);
  const report = await listSalesByBank({ startDate: parsed.data.startDate, endDate: parsed.data.endDate, salesPerson: parsed.data.salesPerson, bank: parsed.data.bank, paymentStatus: parsed.data.paymentStatus, page: parsedPage, pageSize: parsedPageSize });
  auditLog(req, "REPORT_VIEWED_SALES_BY_BANK", "report:sales-by-bank", "Info", { startDate: parsed.data.startDate, endDate: parsed.data.endDate }).catch(console.error);
  return res.status(200).json({
    data: {
      summary: report.summary, byBank: report.byBank,
      rows: report.rows.map((row) => ({ saleId: row.sale_id, saleDate: row.sale_date, salesPerson: row.sales_person, bank: row.bank, vehicleId: row.vehicle_id, vehiclePlate: row.vehicle_plate, vehicleModel: row.vehicle_model, customerName: row.customer_name, amount: row.amount, currency: "KES", paymentStatus: row.payment_status })),
    },
    meta: { total: report.total },
  });
});

router.get("/sales-by-bank.csv", requireAuth, requireRole(["Sales", "Admin", "BDM", "BDMCorporate", "Telesales", "FieldSales"]), async (req, res) => {
  const parsed = salesByBankQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const report = await listSalesByBank({ startDate: parsed.data.startDate, endDate: parsed.data.endDate, salesPerson: parsed.data.salesPerson, bank: parsed.data.bank, paymentStatus: parsed.data.paymentStatus, page: 1, pageSize: 10000 });
  const headers = ["saleId", "saleDate", "salesPerson", "bank", "vehicleId", "vehiclePlate", "vehicleModel", "customerName", "amount", "currency", "paymentStatus"];
  const rows = report.rows.map((row) => ({ saleId: row.sale_id, saleDate: row.sale_date, salesPerson: row.sales_person, bank: row.bank, vehicleId: row.vehicle_id, vehiclePlate: row.vehicle_plate, vehicleModel: row.vehicle_model, customerName: row.customer_name, amount: row.amount, currency: "KES", paymentStatus: row.payment_status }));
  const filename = `sales-by-bank_${parsed.data.startDate || "all"}_to_${parsed.data.endDate || "all"}.csv`;
  const csv = buildCsv(headers, rows);
  auditLog(req, "REPORT_EXPORTED_SALES_BY_BANK", "report:sales-by-bank", "Info", { startDate: parsed.data.startDate, endDate: parsed.data.endDate }).catch(console.error);
  return sendCsv(res, filename, csv);
});

// ── Invoice Amount report — gross invoiced, referrer commission, net revenue ──
async function buildInvoiceAmountReport(from?: string, to?: string) {
  const { where, params } = dateWhere(from, to);
  const rows = await pgAll(
    `SELECT i.id, i.invoice_number, i.customer, i.sales_person, i.status,
            ${INV_DATE} AS report_date,
            COALESCE(i.subtotal,0) AS subtotal, COALESCE(i.vat_total,0) AS vat_total, COALESCE(i.total, i.amount, 0) AS total,
            COALESCE((SELECT SUM(rp.fee_amount) FROM referrer_payments rp WHERE rp.invoice_id = i.id
               AND COALESCE(rp.approval_status, 'NotRequired') IN ('NotRequired','Approved')),0) AS commission
     FROM invoices i
     WHERE 1=1 ${where}
     ORDER BY report_date DESC, i.created_at DESC`,
    params
  );
  const mapped = rows.map((r: any) => {
    const total = Number(r.total), commission = Number(r.commission);
    return { id: r.id, invoiceNumber: r.invoice_number, customer: r.customer, salesPerson: r.sales_person || null,
      date: r.report_date, subtotal: Number(r.subtotal), vat: Number(r.vat_total), total, commission, net: total - commission, status: r.status };
  });
  const summary = mapped.reduce((a, r) => ({ count: a.count + 1, gross: a.gross + r.total, commission: a.commission + r.commission, net: a.net + r.net }), { count: 0, gross: 0, commission: 0, net: 0 });
  const bySalesMap = new Map<string, any>();
  for (const r of mapped) {
    const k = r.salesPerson || "—";
    let s = bySalesMap.get(k);
    if (!s) { s = { salesPerson: k, count: 0, gross: 0, commission: 0, net: 0 }; bySalesMap.set(k, s); }
    s.count++; s.gross += r.total; s.commission += r.commission; s.net += r.net;
  }
  return { summary, bySalesPerson: [...bySalesMap.values()].sort((a, b) => b.net - a.net), rows: mapped };
}

router.get("/invoice-amount", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildInvoiceAmountReport(from, to);
  auditLog(req, "REPORT_VIEWED_INVOICE_AMOUNT", "report:invoice-amount", "Info", { from, to }).catch(console.error);
  return res.status(200).json({ data: report });
});

router.get("/invoice-amount.csv", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildInvoiceAmountReport(from, to);
  const headers = ["invoiceNumber", "date", "customer", "salesPerson", "subtotal", "vat", "total", "commission", "net", "status"];
  const csv = buildCsv(headers, report.rows);
  return sendCsv(res, `invoice-amount_${from || "all"}_to_${to || "all"}.csv`, csv);
});

// ── Tax report — from tax invoices (VAT charged) ──────────────────────────────
async function buildTaxReport(from?: string, to?: string) {
  const { where, params } = dateWhere(from, to);
  const rows = await pgAll(
    `SELECT i.id, i.invoice_number, i.customer, i.status,
            ${INV_DATE} AS report_date,
            COALESCE(i.subtotal,0) AS subtotal, COALESCE(i.vat_total,0) AS vat_total, COALESCE(i.total, i.amount, 0) AS total,
            i.etims_control_no, i.etims_receipt_no
     FROM invoices i
     WHERE COALESCE(i.vat_total,0) > 0 ${where}
     ORDER BY report_date DESC, i.created_at DESC`,
    params
  );
  const mapped = rows.map((r: any) => ({ id: r.id, invoiceNumber: r.invoice_number, customer: r.customer,
    date: r.report_date, taxable: Number(r.subtotal), vat: Number(r.vat_total), total: Number(r.total),
    status: r.status, etimsControlNo: r.etims_control_no || null, etimsReceiptNo: r.etims_receipt_no || null }));
  const summary = mapped.reduce((a, r) => ({ count: a.count + 1, taxable: a.taxable + r.taxable, vat: a.vat + r.vat, gross: a.gross + r.total }), { count: 0, taxable: 0, vat: 0, gross: 0 });
  return { summary, rows: mapped };
}

router.get("/tax", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildTaxReport(from, to);
  auditLog(req, "REPORT_VIEWED_TAX", "report:tax", "Info", { from, to }).catch(console.error);
  return res.status(200).json({ data: report });
});

router.get("/tax.csv", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildTaxReport(from, to);
  const headers = ["invoiceNumber", "date", "customer", "taxable", "vat", "total", "status", "etimsControlNo", "etimsReceiptNo"];
  const csv = buildCsv(headers, report.rows);
  return sendCsv(res, `tax-report_${from || "all"}_to_${to || "all"}.csv`, csv);
});

// ── Invoice Payments report — every receipt banked (independent of invoice) ────
async function buildInvoicePaymentsReport(from?: string, to?: string) {
  const { where, params } = colDateWhere("p.paid_at", from, to);
  const rows = await pgAll(
    `SELECT p.id, p.payment_ref, p.paid_at, p.invoice_id, i.invoice_number,
            p.customer, i.sales_person, p.amount, p.method, p.bank, p.status,
            COALESCE(p.referrer_commission_total,0) AS commission,
            COALESCE(p.net_amount, p.amount) AS net
     FROM payments p
     LEFT JOIN invoices i ON i.id = p.invoice_id
     WHERE 1=1 ${where}
     ORDER BY p.paid_at DESC, p.created_at DESC`,
    params
  );
  const mapped = rows.map((r: any) => ({
    id: r.id, paymentRef: r.payment_ref, date: String(r.paid_at || "").slice(0, 10),
    invoiceNumber: r.invoice_number || null, customer: r.customer, salesPerson: r.sales_person || null,
    amount: Number(r.amount), method: r.method || null, bank: r.bank || null,
    commission: Number(r.commission), net: Number(r.net), status: r.status,
  }));
  const summary = mapped.reduce((a, r) => ({ count: a.count + 1, total: a.total + r.amount, commission: a.commission + r.commission, net: a.net + r.net }),
    { count: 0, total: 0, commission: 0, net: 0 });
  const byMethodMap = new Map<string, any>();
  for (const r of mapped) {
    const k = r.method || "—"; let s = byMethodMap.get(k);
    if (!s) { s = { method: k, count: 0, total: 0 }; byMethodMap.set(k, s); }
    s.count++; s.total += r.amount;
  }
  return { summary, byMethod: [...byMethodMap.values()].sort((a, b) => b.total - a.total), rows: mapped };
}

router.get("/invoice-payments", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildInvoicePaymentsReport(from, to);
  auditLog(req, "REPORT_VIEWED_INVOICE_PAYMENTS", "report:invoice-payments", "Info", { from, to }).catch(console.error);
  return res.status(200).json({ data: report });
});

router.get("/invoice-payments.csv", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildInvoicePaymentsReport(from, to);
  const headers = ["paymentRef", "date", "invoiceNumber", "customer", "salesPerson", "amount", "method", "bank", "commission", "net", "status"];
  const csv = buildCsv(headers, report.rows);
  return sendCsv(res, `invoice-payments_${from || "all"}_to_${to || "all"}.csv`, csv);
});

// ── Outstanding Invoices report — issued invoices not yet fully collected ──────
async function buildOutstandingReport(from?: string, to?: string) {
  const { where, params } = dateWhere(from, to);
  const rows = await pgAll(
    `SELECT i.id, i.invoice_number, i.customer, i.sales_person, i.status, i.due_on,
            ${INV_DATE} AS report_date,
            COALESCE(i.total, i.amount, 0) AS invoice_amount,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'Completed'),0) AS paid
     FROM invoices i
     WHERE COALESCE(i.status,'') NOT IN ('Cancelled','Draft','Paid') ${where}
     ORDER BY report_date DESC, i.created_at DESC`,
    params
  );
  const mapped = rows
    .map((r: any) => {
      const invoiceAmount = Number(r.invoice_amount), paid = Number(r.paid);
      const outstanding = invoiceAmount - paid;
      const days = ageDays(r.report_date);
      return { id: r.id, invoiceNumber: r.invoice_number, customer: r.customer, salesPerson: r.sales_person || null,
        date: r.report_date, dueOn: r.due_on ? String(r.due_on).slice(0, 10) : null,
        invoiceAmount, paid, outstanding, status: r.status, ageDays: days, ageBucket: ageBucket(days) };
    })
    .filter((r) => r.outstanding > 0.5); // ignore sub-shilling float residue
  const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 } as Record<string, number>;
  for (const r of mapped) buckets[r.ageBucket] += r.outstanding;
  const summary = mapped.reduce((a, r) => ({ count: a.count + 1, invoiced: a.invoiced + r.invoiceAmount, paid: a.paid + r.paid, outstanding: a.outstanding + r.outstanding }),
    { count: 0, invoiced: 0, paid: 0, outstanding: 0 });
  return { summary, buckets, rows: mapped };
}

router.get("/outstanding", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildOutstandingReport(from, to);
  auditLog(req, "REPORT_VIEWED_OUTSTANDING", "report:outstanding", "Info", { from, to }).catch(console.error);
  return res.status(200).json({ data: report });
});

router.get("/outstanding.csv", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildOutstandingReport(from, to);
  const headers = ["invoiceNumber", "date", "dueOn", "customer", "salesPerson", "invoiceAmount", "paid", "outstanding", "ageDays", "ageBucket", "status"];
  const csv = buildCsv(headers, report.rows);
  return sendCsv(res, `outstanding-invoices_${from || "all"}_to_${to || "all"}.csv`, csv);
});

// ── Commission Analytics — by salesperson / customer, advances, reconciliation,
//    aging & partial (pending) payouts. One bundle feeding client-side sub-tabs. ─
async function buildCommissionAnalytics(from?: string, to?: string) {
  const { where, params } = colDateWhere("rp.payment_date", from, to);
  const rows = await pgAll(
    `SELECT rp.id, rp.referrer_name, rp.invoice_id, rp.invoice_number,
            COALESCE(i.customer, rp.customer) AS customer, i.sales_person,
            COALESCE(rp.fee_amount,0) AS fee_amount, COALESCE(rp.proposed_commission,0) AS proposed_commission,
            rp.payment_date, rp.is_advance, rp.advance_reason, rp.reconciliation_status,
            rp.reconciled_at, rp.authorized_by_email, rp.status,
            rp.approval_status, rp.approved_by_email, rp.approved_at
     FROM referrer_payments rp
     LEFT JOIN invoices i ON i.id = rp.invoice_id
     WHERE 1=1 ${where}
     ORDER BY rp.payment_date DESC, rp.created_at DESC`,
    params
  );
  const isReversed = (r: any) => String(r.status || "") === "Reversed";
  const isAdvance = (r: any) => r.is_advance === true || r.is_advance === "t" || r.is_advance === 1;

  const active = rows.filter((r: any) => !isReversed(r));
  const reversed = rows.filter(isReversed);

  const groupSum = (keyFn: (r: any) => string, labelKey: string) => {
    const m = new Map<string, any>();
    for (const r of active as any[]) {
      const k = keyFn(r) || "—"; let s = m.get(k);
      if (!s) { s = { [labelKey]: k, count: 0, total: 0, advanced: 0 }; m.set(k, s); }
      s.count++; s.total += Number(r.fee_amount); if (isAdvance(r)) s.advanced += Number(r.fee_amount);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  };
  const bySalesperson = groupSum((r) => r.sales_person, "salesPerson");
  const byCustomer = groupSum((r) => r.customer, "customer");

  const advanced = (active.filter(isAdvance) as any[]).map((r) => {
    const days = ageDays(r.payment_date);
    return { id: r.id, date: String(r.payment_date).slice(0, 10), referrerName: r.referrer_name,
      customer: r.customer || null, invoiceNumber: r.invoice_number || null, invoiceId: r.invoice_id || null,
      amount: Number(r.fee_amount), advanceReason: r.advance_reason || null,
      reconciliationStatus: r.reconciliation_status || "Pending", reconciledAt: r.reconciled_at ? String(r.reconciled_at).slice(0, 10) : null,
      authorizedBy: r.authorized_by_email || null, ageDays: days, ageBucket: ageBucket(days),
      // Held advances are listed but excluded from the money totals.
      approvalStatus: r.approval_status || "NotRequired",
      approvedBy: r.approved_by_email || null,
      approvedAt: r.approved_at ? String(r.approved_at).slice(0, 10) : null };
  });

  // Partial (pending) payouts: a pledged commission that has been under-paid so far.
  const pending = (active as any[])
    .filter((r) => Number(r.proposed_commission) > 0 && Number(r.fee_amount) < Number(r.proposed_commission) - 0.5)
    .map((r) => ({ id: r.id, date: String(r.payment_date).slice(0, 10), referrerName: r.referrer_name,
      customer: r.customer || null, invoiceNumber: r.invoice_number || null,
      pledged: Number(r.proposed_commission), paid: Number(r.fee_amount), shortfall: Number(r.proposed_commission) - Number(r.fee_amount) }));

  // Aging of still-unreconciled advances (the live exposure).
  const agingBuckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 } as Record<string, number>;
  let pendingExposure = 0, pendingCount = 0, reconciledTotal = 0, reconciledCount = 0;
  for (const a of advanced) {
    if (a.reconciliationStatus === "Reconciled") { reconciledTotal += a.amount; reconciledCount++; }
    else { pendingExposure += a.amount; pendingCount++; agingBuckets[a.ageBucket] += a.amount; }
  }

  const summary = {
    txnCount: active.length,
    totalPaid: active.reduce((s: number, r: any) => s + Number(r.fee_amount), 0),
    advancedCount: advanced.length,
    advancedTotal: advanced.reduce((s, a) => s + a.amount, 0),
    pendingExposure, pendingCount, reconciledTotal, reconciledCount,
    partialCount: pending.length,
    partialShortfall: pending.reduce((s, p) => s + p.shortfall, 0),
    reversedCount: reversed.length,
    reversedTotal: reversed.reduce((s: number, r: any) => s + Number(r.fee_amount), 0),
  };
  return { summary, bySalesperson, byCustomer, advanced, pending, agingBuckets };
}

router.get("/commission-analytics", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildCommissionAnalytics(from, to);
  auditLog(req, "REPORT_VIEWED_COMMISSION_ANALYTICS", "report:commission-analytics", "Info", { from, to }).catch(console.error);
  return res.status(200).json({ data: report });
});

// ── Sales-people commission (per-bank % of amount retained after banker/dealer
//    commission, tiered rates adjustable by Finance, 5% WHT on gross) ───────────

const SC_DEFAULTS = { defaultPct: 10, privatePct: 10, whtPct: 5 };

async function loadSalesCommissionConfig() {
  const rows = await pgAll(`SELECT bank_key, rate_pct FROM sales_commission_rates`);
  const banks: { bank: string; ratePct: number }[] = [];
  let defaultPct = SC_DEFAULTS.defaultPct, privatePct = SC_DEFAULTS.privatePct, whtPct = SC_DEFAULTS.whtPct;
  for (const r of rows as any[]) {
    const key = String(r.bank_key);
    if (key === "__DEFAULT__") defaultPct = Number(r.rate_pct);
    else if (key === "__PRIVATE__") privatePct = Number(r.rate_pct);
    else if (key === "__WHT__") whtPct = Number(r.rate_pct);
    else banks.push({ bank: key, ratePct: Number(r.rate_pct) });
  }
  banks.sort((a, b) => a.bank.localeCompare(b.bank));
  return { defaultPct, privatePct, whtPct, banks };
}

router.get("/sales-commission/config", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (_req, res) => {
  return res.status(200).json({ data: await loadSalesCommissionConfig() });
});

router.put("/sales-commission/config", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const { defaultPct, privatePct, whtPct, banks } = req.body || {};
  const pctOk = (v: any) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
  if (!pctOk(defaultPct) || !pctOk(privatePct) || !pctOk(whtPct)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "defaultPct, privatePct and whtPct must be numbers between 0 and 100.");
  }
  if (!Array.isArray(banks)) return errorResponse(res, 400, "VALIDATION_ERROR", "banks must be an array of { bank, ratePct }.");
  const cleaned: { bank: string; ratePct: number }[] = [];
  const seen = new Set<string>();
  for (const b of banks) {
    const name = String(b?.bank || "").trim().toUpperCase();
    if (!name || name.startsWith("__")) continue;
    if (!pctOk(b?.ratePct)) return errorResponse(res, 400, "VALIDATION_ERROR", `Rate for "${name}" must be a number between 0 and 100.`);
    if (seen.has(name)) continue;
    seen.add(name);
    cleaned.push({ bank: name, ratePct: b.ratePct });
  }
  // Replace-all semantics: the saved list IS the config (predictable, no stale rows).
  const now = new Date().toISOString();
  const by = req.user?.email || null;
  await pgRun(`DELETE FROM sales_commission_rates`);
  const upsert = (key: string, pct: number) =>
    pgRun(`INSERT INTO sales_commission_rates (bank_key, rate_pct, updated_at, updated_by) VALUES (?, ?, ?, ?)`, [key, pct, now, by]);
  await upsert("__DEFAULT__", defaultPct);
  await upsert("__PRIVATE__", privatePct);
  await upsert("__WHT__", whtPct);
  for (const b of cleaned) await upsert(b.bank, b.ratePct);
  auditLog(req, "SALES_COMMISSION_CONFIG_UPDATED", "report:sales-commission", "Info", { defaultPct, privatePct, whtPct, banks: cleaned }).catch(console.error);
  return res.status(200).json({ data: await loadSalesCommissionConfig(), message: "Commission rates saved" });
});

router.get("/sales-commission/matrix", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (_req, res) => {
  return res.status(200).json({ data: { ...(await loadCommissionMatrix()), maxYears: SC_MAX_YEARS } });
});

router.put("/sales-commission/matrix", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const { banks } = req.body || {};
  if (!Array.isArray(banks)) return errorResponse(res, 400, "VALIDATION_ERROR", "banks must be an array.");
  const money = (v: any) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000_000;
  const cleaned: ScMatrixBank[] = [];
  const seen = new Set<string>();
  for (const b of banks) {
    const name = String(b?.bank || "").trim().toUpperCase();
    if (!name) continue;
    if (name.startsWith("__")) return errorResponse(res, 400, "VALIDATION_ERROR", `"${name}" is not a valid bank name.`);
    if (seen.has(normBank(name))) return errorResponse(res, 400, "VALIDATION_ERROR", `"${name}" is listed twice.`);
    seen.add(normBank(name));
    const aliases = (Array.isArray(b?.aliases) ? b.aliases : [])
      .map((a: any) => String(a || "").trim().toUpperCase()).filter((a: string) => a && normBank(a)).slice(0, 10);
    const tiers: ScTier[] = [];
    const years = new Set<number>();
    for (const t of Array.isArray(b?.tiers) ? b.tiers : []) {
      const y = Number(t?.years);
      if (!Number.isInteger(y) || y < 1 || y > SC_MAX_YEARS) return errorResponse(res, 400, "VALIDATION_ERROR", `${name}: years must be 1–${SC_MAX_YEARS}.`);
      if (years.has(y)) return errorResponse(res, 400, "VALIDATION_ERROR", `${name}: ${y}-year tier listed twice.`);
      if (!money(t?.price) || !money(t?.bankCommission) || !money(t?.salesCommission))
        return errorResponse(res, 400, "VALIDATION_ERROR", `${name} ${y} yr: price, bank commission and sales commission must be non-negative numbers.`);
      if (t.price <= 0) return errorResponse(res, 400, "VALIDATION_ERROR", `${name} ${y} yr: price must be greater than 0.`);
      if (t.bankCommission >= t.price) return errorResponse(res, 400, "VALIDATION_ERROR", `${name} ${y} yr: bank commission must be less than the price.`);
      if (t.salesCommission > t.price - t.bankCommission)
        return errorResponse(res, 400, "VALIDATION_ERROR", `${name} ${y} yr: sales commission cannot exceed the amount retained (price − bank commission).`);
      years.add(y);
      tiers.push({ years: y, price: t.price, bankCommission: t.bankCommission, salesCommission: t.salesCommission });
    }
    tiers.sort((a, b2) => a.years - b2.years);
    cleaned.push({ bank: name, aliases, tiers });
  }
  const before = await loadCommissionMatrix();
  const now = new Date().toISOString();
  const by = req.user?.email || null;
  await pgRun(
    `INSERT INTO sales_commission_settings (key, value, updated_at, updated_by) VALUES ('matrix', ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(cleaned), now, by]
  );
  auditLog(req, "SALES_COMMISSION_MATRIX_UPDATED", "report:sales-commission", "Info", { before: before.banks, after: cleaned }).catch(console.error);
  return res.status(200).json({ data: { ...(await loadCommissionMatrix()), maxYears: SC_MAX_YEARS }, message: "Commission structure saved" });
});

/** Non-bank-financed deals ("private" clients) get the __PRIVATE__ rate. */
const isPrivateBank = (bank: string) => {
  const b = bank.trim().toUpperCase();
  return !b || b === "PRIVATE" || b === "CASH" || b === "SELF" || b === "PRIVATE CLIENT";
};

async function buildSalesCommissionReport(from?: string, to?: string) {
  const cfg = await loadSalesCommissionConfig();
  const matrix = await loadCommissionMatrix();
  const bankMap = new Map(cfg.banks.map((b) => [b.bank, b.ratePct]));
  const { where, params } = colDateWhere("p.paid_at", from, to);
  // One row per completed receipt, enriched with the deal context (same resolution
  // chain as the referrer Commission Ledger). Banker/dealer commission per receipt:
  // payouts linked to this exact receipt, plus invoice-level payouts (no payment_id)
  // attached to the invoice's LATEST completed receipt so each counts exactly once.
  const rows = await pgAll(
    `SELECT p.id, p.paid_at, p.payment_ref, p.amount, p.invoice_id,
            i.invoice_number, i.customer, i.sales_person,
            t.technician_signed_off_at AS installation_date,
            COALESCE(cv.registration, t.vehicle_registration, q.vehicle_registration) AS vehicle_reg,
            COALESCE(pt.name, rl.bank_partner_name, NULLIF(t.installation_financer, 'Bank Financed'), t.installation_financer, p.bank, i.bank) AS bank,
            COALESCE(cv.loan_tenure_months, q.loan_term_months) AS loan_duration,
            COALESCE(rc.commission, 0) AS dealer_commission
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     LEFT JOIN LATERAL (
       SELECT technician_signed_off_at, vehicle_registration, installation_financer, retail_lead_id, vehicle_id, quote_id
       FROM installation_tickets
       WHERE invoice_id = i.id AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1
     ) t ON TRUE
     LEFT JOIN crm_customer_vehicles cv ON cv.id = t.vehicle_id
     LEFT JOIN partners pt ON pt.id::text = cv.partner_id::text AND pt.deleted_at IS NULL
     LEFT JOIN crm_quotes q ON q.id = COALESCE(i.quote_id, t.quote_id)
     LEFT JOIN retail_leads rl ON rl.id = t.retail_lead_id
     LEFT JOIN LATERAL (
       SELECT SUM(rp.fee_amount) AS commission
       FROM referrer_payments rp
       WHERE (rp.status IS NULL OR rp.status <> 'Reversed')
         AND COALESCE(rp.approval_status, 'NotRequired') IN ('NotRequired','Approved')
         AND (rp.payment_id = p.id
              OR (rp.payment_id IS NULL AND rp.invoice_id = p.invoice_id AND p.id = (
                    SELECT p2.id FROM payments p2
                    WHERE p2.invoice_id = p.invoice_id AND p2.status = 'Completed'
                    ORDER BY p2.paid_at DESC, p2.created_at DESC LIMIT 1)))
     ) rc ON TRUE
     WHERE p.status = 'Completed' ${where}
     ORDER BY p.paid_at DESC, p.created_at DESC`,
    params
  );
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const mapped = rows.map((r: any) => {
    const bank = String(r.bank || "").trim();
    const key = bank.toUpperCase();
    const isPrivate = isPrivateBank(bank);
    const amountPaid = Number(r.amount);
    const dealerCommission = Number(r.dealer_commission);
    const retained = amountPaid - dealerCommission;
    const months = r.loan_duration != null ? Number(r.loan_duration) : null;
    const years = loanYears(months);
    // 1) Commission structure (bank × loan years) — the validated payout list.
    const mBank = isPrivate ? null : matchMatrixBank(matrix.banks, bank);
    const tier = mBank && years ? mBank.tiers.find((t) => t.years === years) : undefined;
    let ratePct: number, rateSource: string, tierLabel: string, scheduleCommission: number | null = null, fallbackReason: string | null = null;
    if (tier && tier.price - tier.bankCommission > 0) {
      ratePct = Math.round((tier.salesCommission / (tier.price - tier.bankCommission)) * 100 * 10000) / 10000;
      rateSource = "structure";
      tierLabel = mBank!.bank + " · " + years + " yr";
      scheduleCommission = tier.salesCommission;
    } else {
      // 2) Fallback: flat per-bank / private / default rate (previous behaviour).
      ratePct = isPrivate ? cfg.privatePct : (bankMap.get(key) ?? cfg.defaultPct);
      rateSource = isPrivate ? "private" : (bankMap.has(key) ? "bank" : "default");
      tierLabel = isPrivate ? "Private · flat " + ratePct + "%" : "Flat " + ratePct + "%";
      if (!isPrivate) fallbackReason = !mBank ? "Bank not in commission structure" : !years ? "Loan duration missing" : `No ${years}-year tier for ${mBank.bank}`;
    }
    return {
      id: r.id, installationDate: r.installation_date ? String(r.installation_date).slice(0, 10) : null,
      date: String(r.paid_at || "").slice(0, 10), customer: r.customer,
      salesPerson: r.sales_person || null, vehicleReg: r.vehicle_reg || null,
      bank: bank || "PRIVATE", loanDuration: r.loan_duration != null ? Number(r.loan_duration) : null,
      paymentRef: r.payment_ref || null, invoiceNumber: r.invoice_number || null,
      loanYears: years, structureBank: mBank?.bank || null, scheduleCommission, tierLabel, fallbackReason,
      amountPaid, dealerCommission, retained, ratePct, rateSource,
      salesCommission: r2(retained * ratePct / 100),
    };
  });
  // Group by applied rate (mirrors the manual sheet's "OTHER BANKS 10% / NCBA-STANBIC 4%" tiers).
  const byRateMap = new Map<number, any>();
  for (const r of mapped) {
    let g = byRateMap.get(r.ratePct);
    if (!g) { g = { ratePct: r.ratePct, banks: new Set<string>(), count: 0, retained: 0, commission: 0 }; byRateMap.set(r.ratePct, g); }
    g.banks.add(r.bank); g.count++; g.retained += r.retained; g.commission += r.salesCommission;
  }
  const byRate = [...byRateMap.values()]
    .map((g) => ({ ratePct: g.ratePct, banks: [...g.banks].sort(), count: g.count, retained: g.retained, commission: r2(g.commission) }))
    .sort((a, b) => b.ratePct - a.ratePct);
  // Per salesperson: gross → WHT → net (commission is paid to individuals).
  const bySpMap = new Map<string, any>();
  for (const r of mapped) {
    const k = r.salesPerson || "—";
    let s = bySpMap.get(k);
    if (!s) { s = { salesPerson: k, deals: 0, amountPaid: 0, retained: 0, gross: 0 }; bySpMap.set(k, s); }
    s.deals++; s.amountPaid += r.amountPaid; s.retained += r.retained; s.gross += r.salesCommission;
  }
  const bySalesperson = [...bySpMap.values()]
    .map((s) => ({ ...s, gross: r2(s.gross), wht: r2(s.gross * cfg.whtPct / 100), net: r2(s.gross * (100 - cfg.whtPct) / 100) }))
    .sort((a, b) => b.gross - a.gross);
  const grossPay = r2(mapped.reduce((s, r) => s + r.salesCommission, 0));
  const wht = r2(grossPay * cfg.whtPct / 100);
  const summary = {
    deals: mapped.length,
    amountPaid: mapped.reduce((s, r) => s + r.amountPaid, 0),
    dealerCommission: mapped.reduce((s, r) => s + r.dealerCommission, 0),
    retained: mapped.reduce((s, r) => s + r.retained, 0),
    grossPay, whtPct: cfg.whtPct, wht, netPay: r2(grossPay - wht),
  };
  return { config: { ...cfg, matrix: matrix.banks, matrixUpdatedAt: matrix.updatedAt, matrixUpdatedBy: matrix.updatedBy, maxYears: SC_MAX_YEARS },
           summary, byRate, bySalesperson, rows: mapped };
}

router.get("/sales-commission", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildSalesCommissionReport(from, to);
  auditLog(req, "REPORT_VIEWED_SALES_COMMISSION", "report:sales-commission", "Info", { from, to }).catch(console.error);
  return res.status(200).json({ data: report });
});

router.get("/sales-commission.csv", requireAuth, requireRole(FINANCE_REPORT_ROLES), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const report = await buildSalesCommissionReport(from, to);
  const headers = ["installationDate", "date", "customer", "salesPerson", "vehicleReg", "bank", "loanDuration", "loanYears", "structureBank", "paymentRef", "invoiceNumber", "amountPaid", "dealerCommission", "retained", "ratePct", "rateSource", "scheduleCommission", "salesCommission", "fallbackReason"];
  const csv = buildCsv(headers, report.rows);
  return sendCsv(res, `sales-commission_${from || "all"}_to_${to || "all"}.csv`, csv);
});

export default router;
