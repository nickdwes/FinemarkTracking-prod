import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { auditLog } from "../services/auditService.js";
import { getFinanceSummary } from "../services/financeService.js";

const router = Router();

router.get("/summary", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req, res) => {
  const summary = await getFinanceSummary();
  auditLog(req, "FINANCE_SUMMARY_VIEWED", "finance:summary", "Info", { outstandingCalculation: "remaining_balance" }).catch(console.error);
  return res.status(200).json({ data: summary });
});

export default router;
