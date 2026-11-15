import { Router } from "express";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { pgRun } from "../db.js";
import { listPaymentsQuerySchema, createPaymentSchema } from "../utils/financeValidators.js";
import { listPayments, createPayment } from "../services/paymentService.js";
import { recordReferrerCommission } from "./referrers.js";
import { getCommissionContext } from "../services/commissionService.js";

const router = Router();

router.get("/", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req, res) => {
  const parsed = listPaymentsQuerySchema.safeParse(req.query);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid query params", parsed.error.flatten());
  const page = Math.max(parseInt(parsed.data.page || "1", 10) || 1, 1);
  const pageSize = Math.min(parseInt(parsed.data.pageSize || "50", 10) || 50, 200);
  const { rows, total } = await listPayments({ search: parsed.data.search, status: parsed.data.status, from: parsed.data.from, to: parsed.data.to, method: parsed.data.method, bank: parsed.data.bank, page, pageSize });
  return res.status(200).json({ data: rows, meta: { total } });
});

router.post("/", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const parsed = createPaymentSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());
  try {
    const paidAt = parsed.data.paidAt || new Date().toISOString();
    const commissions = parsed.data.referrerCommissions || [];

    // Advance guard BEFORE creating anything (so a rejected request leaves no orphaned
    // payment): if this receipt won't bring the invoice to fully-paid, commission paid
    // alongside it is an Advanced Commission and needs a reason (inline authorization).
    if (commissions.length) {
      const ctx = await getCommissionContext(parsed.data.invoiceId).catch(() => null);
      if (ctx) {
        const threshold = ctx.amount > 0 ? ctx.amount : ctx.invoiceTotal;
        const willBeFullyPaid = threshold > 0 && (ctx.totalPaid + Number(parsed.data.amount)) >= threshold;
        if (!willBeFullyPaid && commissions.some((c) => !String(c.advanceReason || "").trim())) {
          return errorResponse(res, 400, "ADVANCE_REASON_REQUIRED",
            "The invoice is not fully paid by this receipt — commission paid now is an Advanced Commission and needs an Advanced Commission Reason.");
        }
      }
    }

    const payment = await createPayment({ invoiceId: parsed.data.invoiceId, amount: parsed.data.amount, currency: parsed.data.currency, method: parsed.data.method, bank: parsed.data.bank, status: parsed.data.status, paidAt, paymentRef: parsed.data.paymentRef });

    // Referrer commissions deducted from this receipt. The full invoice amount is
    // still banked (payment.amount); we capture the commission total + net so revenue
    // and sales-people commission can be computed on the net figure.
    let commissionTotal = 0;
    for (const c of commissions) {
      await recordReferrerCommission({
        referrerName: c.name,
        referrerPhone: c.phone || null,
        invoiceId: parsed.data.invoiceId,
        paymentId: payment.id,
        feeAmount: c.amount,
        proposedCommission: c.proposedCommission ?? null,
        transactionCode: c.transactionCode || null,
        // Commission payout date captured specifically for the commission; falls
        // back to the invoice receipt date when not provided.
        paymentDate: c.paidDate || paidAt.slice(0, 10),
        commissionMode: c.commissionMode || null,
        beneficiaryType: c.beneficiaryType || null,
        advanceReason: c.advanceReason || null,
        authorizedByUserId: req.user?.id || null,
        authorizedByEmail: req.user?.email || null,
        actorEmail: req.user?.email || null,
      });
      commissionTotal += Number(c.amount);
    }
    if (commissionTotal > 0) {
      const netAmount = Number(payment.amount) - commissionTotal;
      await pgRun("UPDATE payments SET referrer_commission_total = ?, net_amount = ? WHERE id = ?",
        [commissionTotal, netAmount, payment.id]);
      (payment as any).referrerCommissionTotal = commissionTotal;
      (payment as any).netAmount = netAmount;
    }

    auditLog(req, "PAYMENT_CREATED", `payment:${payment.id}`, "Info", { invoiceId: payment.invoiceId, amount: payment.amount, status: payment.status, commissionTotal }).catch(console.error);
    return res.status(201).json({ data: payment, message: commissionTotal > 0 ? `Payment recorded with ${commissions.length} referrer commission(s)` : "Payment recorded" });
  } catch (error: any) {
    if (error.message === "INVOICE_NOT_FOUND") return errorResponse(res, 404, "NOT_FOUND", "Invoice not found");
    if (error.message === "DUPLICATE_PAYMENT") return errorResponse(res, 409, "CONFLICT", "This exact payment (same reference and amount) is already recorded for this invoice.");
    if (error?.code === "23505") return errorResponse(res, 409, "CONFLICT", "A payment with this reference already exists.");
    return errorResponse(res, 500, "INTERNAL", "Failed to create payment");
  }
});

export default router;
