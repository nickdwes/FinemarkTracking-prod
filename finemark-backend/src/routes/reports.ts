import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { salesByBankQuerySchema } from "../utils/financeValidators.js";
import { listSalesByBank } from "../services/reportService.js";
import { auditLog } from "../services/auditService.js";
import { buildCsv, sendCsv } from "../utils/csv.js";

const router = Router();

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

export default router;
