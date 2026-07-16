import crypto from "crypto";
import { pgGet, pgAll, pgRun } from "../db.js";
import { updateInvoiceStatusFromPayments } from "./invoiceService.js";

const mapPayment = (row: any) => ({
  id: row.id,
  paymentRef: row.payment_ref,
  invoiceId: row.invoice_id,
  invoiceNumber: row.invoice_number || null,
  customer: row.customer,
  amount: row.amount,
  currency: "KES",
  method: row.method,
  bank: row.bank,
  status: row.status,
  paidAt: row.paid_at,
  createdAt: row.created_at,
});

const generatePaymentRef = async (): Promise<string> => {
  const year = new Date().getFullYear();
  const prefix = `PAY-${year}-`;
  const row = await pgGet("SELECT COUNT(*) as total FROM payments WHERE payment_ref LIKE ?", [`${prefix}%`]);
  const next = String(Number(row?.total ?? 0) + 1).padStart(4, "0");
  return `${prefix}${next}`;
};

export const listPayments = async (filters: {
  search?: string; status?: string; from?: string; to?: string; method?: string; bank?: string;
  page: number; pageSize: number;
}) => {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filters.search) {
    clauses.push("(p.payment_ref ILIKE ? OR p.customer ILIKE ? OR p.invoice_id ILIKE ?)");
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.status) { clauses.push("p.status = ?"); params.push(filters.status); }
  if (filters.from) { clauses.push("p.paid_at >= ?"); params.push(filters.from); }
  if (filters.to) { clauses.push("p.paid_at <= ?"); params.push(filters.to); }
  if (filters.method) { clauses.push("p.method = ?"); params.push(filters.method); }
  if (filters.bank) { clauses.push("p.bank = ?"); params.push(filters.bank); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (filters.page - 1) * filters.pageSize;
  const rows = await pgAll(
    `SELECT p.*, i.invoice_number FROM payments p
     LEFT JOIN invoices i ON i.id = p.invoice_id
     ${where} ORDER BY p.paid_at DESC, p.created_at DESC LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM payments p ${where}`, params);
  return { rows: rows.map(mapPayment), total: Number(totalRow?.total ?? 0) };
};

export const createPayment = async (data: {
  invoiceId: string; amount: number; currency: string; method: string;
  bank?: string; status: string; paidAt: string; paymentRef?: string;
}) => {
  const now = new Date().toISOString();
  const paymentRef = data.paymentRef || (await generatePaymentRef());
  const id = crypto.randomUUID();
  const invoice = await pgGet("SELECT * FROM invoices WHERE id = ?", [data.invoiceId]);
  if (!invoice) throw new Error("INVOICE_NOT_FOUND");
  await pgRun(
    `INSERT INTO payments (id, payment_ref, invoice_id, customer, amount, currency, method, bank, status, paid_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, paymentRef, data.invoiceId, invoice.customer, data.amount, "KES",
     data.method, data.bank || null, data.status, data.paidAt, now]
  );
  if (data.status === "Completed") await updateInvoiceStatusFromPayments(data.invoiceId);
  const row = await pgGet("SELECT * FROM payments WHERE id = ?", [id]);
  return mapPayment(row);
};
