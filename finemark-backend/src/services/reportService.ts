import { pgGet, pgAll } from "../db.js";

export const listSalesByBank = async (filters: {
  startDate?: string; endDate?: string; salesPerson?: string;
  bank?: string; paymentStatus?: string; page: number; pageSize: number;
}) => {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filters.startDate) { clauses.push("sale_date >= ?"); params.push(filters.startDate); }
  if (filters.endDate) { clauses.push("sale_date <= ?"); params.push(filters.endDate); }
  if (filters.salesPerson) { clauses.push("sales_person = ?"); params.push(filters.salesPerson); }
  if (filters.bank) { clauses.push("bank = ?"); params.push(filters.bank); }
  if (filters.paymentStatus) { clauses.push("payment_status = ?"); params.push(filters.paymentStatus); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (filters.page - 1) * filters.pageSize;

  const rows = await pgAll(
    `SELECT * FROM sales_transactions ${where} ORDER BY sale_date DESC, created_at DESC LIMIT ? OFFSET ?`,
    [...params, filters.pageSize, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM sales_transactions ${where}`, params);
  const allRows = await pgAll(`SELECT * FROM sales_transactions ${where}`, params);

  const uniqueVehicles = new Set(allRows.map((row) => row.vehicle_id));
  const totalPaidRevenue = allRows
    .filter((row) => row.payment_status === "Paid")
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const totalPendingAmount = allRows
    .filter((row) => row.payment_status === "Pending")
    .reduce((sum, row) => sum + Number(row.amount), 0);

  const byBankMap = new Map<string, { bank: string; vehicles: Set<string>; paid: number; pending: number }>();
  for (const row of allRows) {
    if (!byBankMap.has(row.bank)) {
      byBankMap.set(row.bank, { bank: row.bank, vehicles: new Set(), paid: 0, pending: 0 });
    }
    const entry = byBankMap.get(row.bank)!;
    entry.vehicles.add(row.vehicle_id);
    if (row.payment_status === "Paid") entry.paid += Number(row.amount);
    if (row.payment_status === "Pending") entry.pending += Number(row.amount);
  }

  const byBank = Array.from(byBankMap.values()).map((entry) => ({
    bank: entry.bank,
    vehiclesSold: entry.vehicles.size,
    paidRevenue: entry.paid,
    pendingAmount: entry.pending,
    paidSharePct: totalPaidRevenue ? Math.round((entry.paid / totalPaidRevenue) * 10000) / 100 : 0,
  }));

  const topBank = byBank.sort((a, b) => b.paidRevenue - a.paidRevenue)[0]?.bank || null;

  return {
    rows,
    total: Number(totalRow?.total ?? 0),
    summary: { totalVehiclesSold: uniqueVehicles.size, totalPaidRevenue, totalPendingAmount, topBank },
    byBank,
  };
};
