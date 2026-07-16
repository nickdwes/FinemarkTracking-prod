import { pgAll } from "../db.js";

type Summary = {
  totalRevenue: number;
  outstanding: number;
  thisMonthRevenue: number;
  avgPaymentDays: number;
  currency: "KES";
};

const calculateOutstanding = (invoices: any[], payments: any[]) => {
  const completedPaymentsByInvoice = payments.reduce<Record<string, number>>((acc, payment) => {
    acc[payment.invoice_id] = (acc[payment.invoice_id] || 0) + Number(payment.amount || 0);
    return acc;
  }, {});
  return invoices
    .filter((invoice) => invoice.status !== "Paid" && invoice.status !== "Cancelled")
    .reduce((sum, invoice) => {
      const paid = completedPaymentsByInvoice[invoice.id] || 0;
      return sum + Math.max(Number(invoice.amount || 0) - paid, 0);
    }, 0);
};

export const getFinanceSummary = async (): Promise<Summary> => {
  const invoices = await pgAll("SELECT * FROM invoices");
  const payments = await pgAll("SELECT * FROM payments WHERE status = 'Completed'");

  const totalRevenue = invoices
    .filter((i) => i.status === "Paid")
    .reduce((sum, i) => sum + Number(i.amount || 0), 0);

  const outstanding = calculateOutstanding(invoices, payments);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const thisMonthRevenue = payments.reduce((sum, p) => {
    const paidAt = p.paid_at ? new Date(p.paid_at) : null;
    if (!paidAt || paidAt < monthStart || paidAt > monthEnd) return sum;
    return sum + Number(p.amount || 0);
  }, 0);

  const paidInvoices = invoices.filter((i) => i.status === "Paid");
  const avgPaymentDays = (() => {
    const diffs: number[] = [];
    for (const invoice of paidInvoices) {
      const related = payments.filter((p) => p.invoice_id === invoice.id);
      if (!related.length) continue;
      const paidAt = related
        .map((p) => new Date(p.paid_at).getTime())
        .filter((v) => !Number.isNaN(v))
        .sort((a, b) => b - a)[0];
      if (!paidAt) continue;
      const issuedOn = new Date(invoice.issued_on).getTime();
      if (Number.isNaN(issuedOn)) continue;
      diffs.push((paidAt - issuedOn) / (1000 * 60 * 60 * 24));
    }
    if (!diffs.length) return 0;
    return Math.round(diffs.reduce((sum, v) => sum + v, 0) / diffs.length);
  })();

  return { totalRevenue, outstanding, thisMonthRevenue, avgPaymentDays, currency: "KES" };
};
