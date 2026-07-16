import crypto from "crypto";
import { pgGet, pgAll, pgRun } from "../db.js";

export const mapInvoice = (row: any) => ({
  id: row.id,
  invoiceNumber: row.invoice_number,
  crmRecordId: row.crm_record_id,
  customerId: row.customer_id || null,
  customer: row.customer,
  representative: row.representative || null,
  vatMode: row.vat_mode || null,
  taxDate: row.tax_date || row.issued_on,
  jobCardNo: row.job_card_no || row.proforma_ticket_no || null,
  ticketNo: row.proforma_ticket_no || null,
  pinNo: row.pin_no || null,
  subtotal: row.subtotal ?? null,
  vatTotal: row.vat_total ?? null,
  total: row.total ?? null,
  paymentPaybill: row.payment_paybill || null,
  paymentAccountHint: row.payment_account_hint || null,
  bankName: row.bank_name || null,
  bankAccountNo: row.bank_account_no || null,
  amount: row.amount,
  currency: "KES",
  status: row.status,
  issuedOn: row.issued_on,
  dueOn: row.due_on,
  bank: row.bank,
  salesPerson: row.sales_person,
  details: row.details_json ? safeJson(row.details_json) : null,
  etrReceiptNo: row.etr_receipt_no || null,
  etimsSigned: row.etims_signed || false,
  etimsControlNo: row.etims_control_no || null,
  etimsReceiptNo: row.etims_receipt_no || null,
  etimsSignedAt: row.etims_signed_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  daysOverdue: row.due_on ? Math.max(0, Math.floor((new Date().getTime() - new Date(row.due_on).getTime()) / 86400000)) : 0,
  customerType: row.customer_type || null,
  vehicleRegistration: row.vehicle_registration || null,
});

const safeJson = (value: string) => {
  try { return JSON.parse(value); } catch { return value; }
};

const generateInvoiceNumber = async (): Promise<string> => {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const row = await pgGet(
    "SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1",
    [`${prefix}%`]
  );
  if (!row?.invoice_number) return `${prefix}0001`;
  const parts = String(row.invoice_number).split("-");
  const last = parseInt(parts[2], 10) || 0;
  return `${prefix}${String(last + 1).padStart(4, "0")}`;
};

export const listInvoices = async (filters: {
  search?: string; status?: string; from?: string; to?: string;
  bank?: string; salesPerson?: string; rep?: string; page: number; pageSize: number;
}) => {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filters.search) {
    clauses.push("(invoice_number ILIKE ? OR customer ILIKE ? OR representative ILIKE ?)");
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
  if (filters.from) { clauses.push("tax_date >= ?"); params.push(filters.from); }
  if (filters.to) { clauses.push("tax_date <= ?"); params.push(filters.to); }
  if (filters.bank) { clauses.push("bank = ?"); params.push(filters.bank); }
  if (filters.salesPerson) { clauses.push("sales_person = ?"); params.push(filters.salesPerson); }
  if (filters.rep) { clauses.push("representative = ?"); params.push(filters.rep); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (filters.page - 1) * filters.pageSize;
  const rows = await pgAll(
    `SELECT *, (
      SELECT it.ticket_no FROM crm_proforma_invoices pf
      JOIN installation_tickets it ON it.id = pf.installation_ticket_id
      WHERE pf.id = invoices.proforma_id LIMIT 1
    ) as proforma_ticket_no, (
      SELECT it.vehicle_registration FROM crm_proforma_invoices pf
      JOIN installation_tickets it ON it.id = pf.installation_ticket_id
      WHERE pf.id = invoices.proforma_id LIMIT 1
    ) as vehicle_registration FROM invoices ${where} ORDER BY issued_on DESC, created_at DESC LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM invoices ${where}`, params);
  return { rows: rows.map(mapInvoice), total: Number(totalRow?.total ?? 0) };
};

export const createInvoice = async (data: {
  invoiceNumber?: string; customer: string; representative?: string; vatMode?: string;
  taxDate?: string; jobCardNo?: string; pinNo?: string; subtotal?: number; vatTotal?: number;
  total?: number; paymentPaybill?: string; paymentAccountHint?: string; bankName?: string;
  bankAccountNo?: string; amount: number; currency: string; status: string; issuedOn: string;
  dueOn: string; bank?: string; salesPerson?: string; details?: Record<string, unknown>; crmRecordId?: string;
}) => {
  const now = new Date().toISOString();
  const invoiceNumber = data.invoiceNumber || (await generateInvoiceNumber());
  const id = crypto.randomUUID();
  await pgRun(
    `INSERT INTO invoices (
       id, invoice_number, crm_record_id, customer, representative, vat_mode,
       tax_date, job_card_no, pin_no, subtotal, vat_total, total,
       payment_paybill, payment_account_hint, bank_name, bank_account_no,
       amount, currency, status, issued_on, due_on, bank, sales_person, details_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, invoiceNumber, data.crmRecordId || null, data.customer, data.representative || null,
     data.vatMode || null, data.taxDate || data.issuedOn, data.jobCardNo || null, data.pinNo || null,
     data.subtotal ?? null, data.vatTotal ?? null, data.total ?? null,
     data.paymentPaybill || null, data.paymentAccountHint || null, data.bankName || null, data.bankAccountNo || null,
     data.amount, "KES", data.status, data.issuedOn, data.dueOn,
     data.bank || null, data.salesPerson || null, data.details ? JSON.stringify(data.details) : null, now, now]
  );
  const row = await pgGet("SELECT * FROM invoices WHERE id = ?", [id]);
  return mapInvoice(row);
};

export const updateInvoice = async (id: string, patch: {
  status?: string; dueOn?: string; bank?: string; salesPerson?: string; details?: Record<string, unknown>;
}) => {
  const existing = await pgGet("SELECT id FROM invoices WHERE id = ?", [id]);
  if (!existing) return null;
  const updates: string[] = [];
  const params: any[] = [];
  if (patch.status) { updates.push("status = ?"); params.push(patch.status); }
  if (patch.dueOn) { updates.push("due_on = ?"); params.push(patch.dueOn); }
  if (patch.bank !== undefined) { updates.push("bank = ?"); params.push(patch.bank || null); }
  if (patch.salesPerson !== undefined) { updates.push("sales_person = ?"); params.push(patch.salesPerson || null); }
  if (patch.details !== undefined) { updates.push("details_json = ?"); params.push(patch.details ? JSON.stringify(patch.details) : null); }
  updates.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);
  await pgRun(`UPDATE invoices SET ${updates.join(", ")} WHERE id = ?`, params);
  const row = await pgGet("SELECT * FROM invoices WHERE id = ?", [id]);
  if (!row) return null;
  if (row.status !== "Paid" && row.status !== "Cancelled" && row.due_on) {
    const now = new Date().toISOString().slice(0, 10);
    if (row.due_on < now && row.status !== "Overdue") {
      await pgRun("UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?", ["Overdue", new Date().toISOString(), id]);
    }
  }
  const refreshed = await updateInvoiceStatusFromPayments(id);
  if (refreshed) return refreshed;
  return mapInvoice(row);
};

export const updateInvoiceStatusFromPayments = async (invoiceId: string) => {
  const invoice = await pgGet("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  if (!invoice) return null;
  // A cancelled invoice (e.g. resolved via a billing credit note/cheque) must
  // never have its status recomputed from payments — a stray payment
  // recorded against it would otherwise silently flip it back to
  // PartiallyPaid/Paid, undoing the cancellation.
  if (invoice.status === "Cancelled") return mapInvoice(invoice);
  const paidRow = await pgGet(
    "SELECT SUM(amount) as total FROM payments WHERE invoice_id = ? AND status = 'Completed'",
    [invoiceId]
  );
  const paid = Number(paidRow?.total || 0);
  let nextStatus = invoice.status;
  if (paid >= Number(invoice.amount)) nextStatus = "Paid";
  else if (paid > 0) nextStatus = "PartiallyPaid";
  if (nextStatus !== invoice.status) {
    await pgRun("UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?", [nextStatus, new Date().toISOString(), invoiceId]);
  }
  const row = await pgGet("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
  return mapInvoice(row);
};

/**
 * Get AR aggregations: KPIs, aging buckets, segments, by-customer-type breakdown.
 */
export const getArAggregations = async (options: { customerType?: string } = {}) => {
  const { customerType } = options;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Filter: unpaid/partial
  const whereClause = "WHERE i.status IN ('Unpaid', 'PartiallyPaid', 'Overdue', 'Pending')";
  const params: any[] = [];
  // customerType filter intentionally omitted (column not present in current schema)
  void customerType;

  // All outstanding invoices (with paid_amount subquery to avoid row duplication)
  const allInvoices = await pgAll(`SELECT i.*, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE invoice_id = i.id AND status = 'Completed') as paid_amount FROM invoices i ${whereClause} ORDER BY i.due_on ASC`, params);

  // Paid in last 30 days
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const paidRecently = await pgAll(
    "SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'Completed' AND created_at >= ?",
    [thirtyDaysAgo]
  );
  const collectedLast30d = Number(paidRecently[0]?.total || 0);

  // Today's expected
  const todayExpected = allInvoices
    .filter((inv) => inv.due_on === today)
    .reduce((sum, inv) => sum + Number(inv.amount), 0);

  // This week's expected (today to 7 days out)
  const weekFromNow = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const weekExpected = allInvoices
    .filter((inv) => inv.due_on >= today && inv.due_on <= weekFromNow)
    .reduce((sum, inv) => sum + Number(inv.amount), 0);

  // This month's expected
  const monthFromNow = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const monthExpected = allInvoices
    .filter((inv) => inv.due_on >= today && inv.due_on <= monthFromNow)
    .reduce((sum, inv) => sum + Number(inv.amount), 0);

  // Total outstanding
  const totalOutstanding = allInvoices.reduce((sum, inv) => sum + Number(inv.amount), 0);

  // Aging buckets
  const dueTodayCount = allInvoices.filter((inv) => inv.due_on === today).length;
  const dueThisWeekCount = allInvoices.filter((inv) => inv.due_on > today && inv.due_on <= weekFromNow).length;
  const dueThisMonthCount = allInvoices.filter((inv) => inv.due_on > weekFromNow && inv.due_on <= monthFromNow).length;

  const overdue1_7Count = allInvoices
    .filter((inv) => {
      const daysOverdue = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000);
      return daysOverdue > 0 && daysOverdue <= 7;
    })
    .length;

  const overdue8_30Count = allInvoices
    .filter((inv) => {
      const daysOverdue = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000);
      return daysOverdue > 7 && daysOverdue <= 30;
    })
    .length;

  const overdue31_60Count = allInvoices
    .filter((inv) => {
      const daysOverdue = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000);
      return daysOverdue > 30 && daysOverdue <= 60;
    })
    .length;

  const atRisk60PlusCount = allInvoices
    .filter((inv) => {
      const daysOverdue = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000);
      return daysOverdue > 60;
    })
    .length;

  const partiallyPaidCount = allInvoices.filter((inv) => inv.status === "PartiallyPaid").length;

  // By customer type
  const corporateOutstanding = allInvoices
    .filter((inv) => inv.customer_type === "Corporate")
    .reduce((sum, inv) => sum + Number(inv.amount), 0);

  const individualOutstanding = allInvoices
    .filter((inv) => inv.customer_type === "Individual")
    .reduce((sum, inv) => sum + Number(inv.amount), 0);

  // Top 10 at-risk (>30 days overdue)
  const atRiskInvoices = allInvoices
    .filter((inv) => {
      const daysOverdue = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000);
      return daysOverdue > 30;
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      customer: inv.customer,
      amount: inv.amount,
      dueOn: inv.due_on,
      daysOverdue: Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000),
    }));

  // Collection rate (collected last 30d / expected last 30d invoices)
  const invoicesIssuedLast30d = await pgAll(
    "SELECT COALESCE(SUM(amount), 0) as total FROM invoices WHERE issued_on >= ? AND status IN ('Paid', 'PartiallyPaid', 'Unpaid', 'Overdue')",
    [thirtyDaysAgo]
  );
  const expectedLast30d = Number(invoicesIssuedLast30d[0]?.total || 0);
  const collectionRate = expectedLast30d > 0 ? Math.round((collectedLast30d / expectedLast30d) * 100) : 0;

  // DSO (Days Sales Outstanding) = (outstanding total / daily average revenue)
  const invoicesLast90d = await pgAll(
    "SELECT COALESCE(SUM(amount), 0) as total FROM invoices WHERE issued_on >= ?",
    [new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10)]
  );
  const totalLast90d = Number(invoicesLast90d[0]?.total || 0);
  const dailyAverage = totalLast90d / 90;
  const dso = dailyAverage > 0 ? Math.round(totalOutstanding / dailyAverage) : 0;

  return {
    kpis: {
      totalOutstanding,
      collectedLast30d,
      collectionRate,
      dso,
      todayExpected,
      weekExpected,
      monthExpected,
    },
    segments: {
      dueToday: { count: dueTodayCount, amount: allInvoices.filter((inv) => inv.due_on === today).reduce((sum, inv) => sum + Number(inv.amount), 0) },
      dueThisWeek: { count: dueThisWeekCount, amount: allInvoices.filter((inv) => inv.due_on > today && inv.due_on <= weekFromNow).reduce((sum, inv) => sum + Number(inv.amount), 0) },
      dueThisMonth: { count: dueThisMonthCount, amount: allInvoices.filter((inv) => inv.due_on > weekFromNow && inv.due_on <= monthFromNow).reduce((sum, inv) => sum + Number(inv.amount), 0) },
      overdue1_7: { count: overdue1_7Count, amount: allInvoices.filter((inv) => { const d = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000); return d > 0 && d <= 7; }).reduce((sum, inv) => sum + Number(inv.amount), 0) },
      overdue8_30: { count: overdue8_30Count, amount: allInvoices.filter((inv) => { const d = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000); return d > 7 && d <= 30; }).reduce((sum, inv) => sum + Number(inv.amount), 0) },
      overdue31_60: { count: overdue31_60Count, amount: allInvoices.filter((inv) => { const d = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000); return d > 30 && d <= 60; }).reduce((sum, inv) => sum + Number(inv.amount), 0) },
      atRisk60Plus: { count: atRisk60PlusCount, amount: allInvoices.filter((inv) => { const d = Math.floor((now.getTime() - new Date(inv.due_on).getTime()) / 86400000); return d > 60; }).reduce((sum, inv) => sum + Number(inv.amount), 0) },
      partiallyPaid: { count: partiallyPaidCount, amount: allInvoices.filter((inv) => inv.status === "PartiallyPaid").reduce((sum, inv) => sum + Number(inv.amount), 0) },
    },
    byCustomerType: {
      corporate: corporateOutstanding,
      individual: individualOutstanding,
    },
    atRiskTop10: atRiskInvoices,
  };
};
