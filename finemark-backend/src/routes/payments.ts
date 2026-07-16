import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { listPaymentsQuerySchema, createPaymentSchema } from "../utils/financeValidators.js";
import { listPayments, createPayment } from "../services/paymentService.js";

const router = Router();

router.get("/", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req, res) => {
  const parsed = listPaymentsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const page = Math.max(parseInt(parsed.data.page || "1", 10) || 1, 1);
  const pageSize = Math.min(parseInt(parsed.data.pageSize || "50", 10) || 50, 200);
  const { rows, total } = await listPayments({ search: parsed.data.search, status: parsed.data.status, from: parsed.data.from, to: parsed.data.to, method: parsed.data.method, bank: parsed.data.bank, page, pageSize });
  return res.status(200).json({ data: rows, meta: { total } });
});

router.post("/", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req, res) => {
  const parsed = createPaymentSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());
  try {
    const payment = await createPayment({ invoiceId: parsed.data.invoiceId, amount: parsed.data.amount, currency: parsed.data.currency, method: parsed.data.method, bank: parsed.data.bank, status: parsed.data.status, paidAt: parsed.data.paidAt || new Date().toISOString(), paymentRef: parsed.data.paymentRef });
    auditLog(req, "PAYMENT_CREATED", `payment:${payment.id}`, "Info", { invoiceId: payment.invoiceId, amount: payment.amount, status: payment.status }).catch(console.error);
    return res.status(201).json({ data: payment, message: "Payment recorded" });
  } catch (error: any) {
    if (error.message === "INVOICE_NOT_FOUND") return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");
    if (error?.code === "23505") return errorResponse(res, 409, "CONFLICT", "Payment reference already exists.");
    return errorResponse(res, 500, "INTERNAL", "Failed to create payment");
  }
});

export default router;
