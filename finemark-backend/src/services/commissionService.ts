import { pgGet, pgAll } from "../db.js";

// Commission lifecycle (Phase 1). Commission = the referrer/beneficiary commission on a deal.
// Its status is DERIVED from: the pledged amount (carried from the lead/quote/ticket), how much
// has actually been paid out (referrer_payments), and whether the invoice is fully paid. Only the
// facts a derivation can't recompute (is_advance, reason, authorizer, reversal, reconciliation) are
// persisted on referrer_payments.
export type CommissionStatus =
  | "None" | "Pending" | "Eligible" | "Advanced" | "Partially Paid" | "Paid" | "Reversed";

/**
 * Resolve the pledged commission + beneficiary for an invoice by walking the same
 * proforma→ticket→lead / quote→lead / quote→ticket chain the invoice-detail page uses.
 */
export async function resolvePledgedCommission(invoiceId: string): Promise<{
  pledged: number | null; beneficiaryName: string | null; beneficiaryPhone: string | null;
}> {
  const inv = await pgGet<any>("SELECT id, quote_id, proforma_id FROM invoices WHERE id = ?", [invoiceId]).catch(() => null);
  if (!inv) return { pledged: null, beneficiaryName: null, beneficiaryPhone: null };
  let name: string | null = null, phone: string | null = null, pledged: number | null = null;
  const take = (r: any) => { name = r.referrer_name || null; phone = r.referrer_phone || null; pledged = r.referrer_commission != null ? Number(r.referrer_commission) : null; };

  // 1. proforma → installation_ticket → retail_lead
  if (inv.proforma_id) {
    const pf = await pgGet<any>("SELECT installation_ticket_id FROM crm_proforma_invoices WHERE id = ?", [inv.proforma_id]).catch(() => null);
    if (pf?.installation_ticket_id) {
      const it = await pgGet<any>("SELECT retail_lead_id FROM installation_tickets WHERE id = ?", [pf.installation_ticket_id]).catch(() => null);
      if (it?.retail_lead_id) {
        const rl = await pgGet<any>("SELECT referrer_name, referrer_phone, referrer_commission FROM retail_leads WHERE id = ?", [it.retail_lead_id]).catch(() => null);
        if (rl?.referrer_name) take(rl);
      }
    }
  }
  // 2. quote → retail_lead
  if (!name && inv.quote_id) {
    const ql = await pgGet<any>("SELECT rl.referrer_name, rl.referrer_phone, rl.referrer_commission FROM crm_quotes q JOIN retail_leads rl ON rl.id = q.lead_id WHERE q.id = ?", [inv.quote_id]).catch(() => null);
    if (ql?.referrer_name) take(ql);
  }
  // 3. quote → corporate installation_ticket (no retail lead)
  if (!name && inv.quote_id) {
    const tk = await pgGet<any>("SELECT referrer_name, referrer_phone, referrer_commission FROM installation_tickets WHERE quote_id = ? AND deleted_at IS NULL AND referrer_name IS NOT NULL ORDER BY created_at DESC LIMIT 1", [inv.quote_id]).catch(() => null);
    if (tk?.referrer_name) take(tk);
  }
  return { pledged, beneficiaryName: name, beneficiaryPhone: phone };
}

export function deriveCommissionStatus(opts: {
  pledged: number | null; commissionPaid: number; invoiceFullyPaid: boolean; hasReversed: boolean;
}): CommissionStatus {
  const pledged = Number(opts.pledged || 0);
  const paid = Number(opts.commissionPaid || 0);
  if (opts.hasReversed && paid <= 0) return "Reversed";
  if (pledged <= 0 && paid <= 0) return "None";
  if (paid <= 0) return opts.invoiceFullyPaid ? "Eligible" : "Pending";
  if (!opts.invoiceFullyPaid) return "Advanced";                 // paid before the invoice was received
  if (pledged > 0 && paid < pledged) return "Partially Paid";
  return "Paid";
}

/**
 * Full commission + payment context for an invoice. Used both when RECORDING a commission
 * (to decide is_advance) and by the invoice ledger endpoint. "Fully paid" uses invoices.amount
 * as the threshold — the same figure updateInvoiceStatusFromPayments compares against.
 */
export async function getCommissionContext(invoiceId: string): Promise<null | {
  invoiceId: string; invoiceNumber: string | null; customer: string | null;
  invoiceTotal: number; amount: number; totalPaid: number; outstanding: number; invoiceFullyPaid: boolean;
  pledged: number | null; beneficiaryName: string | null; beneficiaryPhone: string | null;
  commissionPaid: number; commissionOutstanding: number; commissionStatus: CommissionStatus;
}> {
  const inv = await pgGet<any>("SELECT id, invoice_number, customer, amount, COALESCE(total, amount, 0) AS invoice_total FROM invoices WHERE id = ?", [invoiceId]).catch(() => null);
  if (!inv) return null;
  const amount = Number(inv.amount || 0);
  const invoiceTotal = Number(inv.invoice_total || inv.amount || 0);
  const totalPaid = Number((await pgGet<any>("SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE invoice_id = ? AND status = 'Completed'", [invoiceId]))?.t || 0);
  const threshold = amount > 0 ? amount : invoiceTotal;
  const invoiceFullyPaid = threshold > 0 && totalPaid >= threshold;
  const outstanding = Math.max(0, invoiceTotal - totalPaid);

  const { pledged, beneficiaryName, beneficiaryPhone } = await resolvePledgedCommission(invoiceId);
  const cRows = await pgAll<any>("SELECT fee_amount, status FROM referrer_payments WHERE invoice_id = ? AND COALESCE(approval_status, 'NotRequired') IN ('NotRequired','Approved')", [invoiceId]).catch(() => []);
  const commissionPaid = cRows.filter((r) => r.status !== "Reversed").reduce((a, r) => a + Number(r.fee_amount || 0), 0);
  const hasReversed = cRows.some((r) => r.status === "Reversed");
  const commissionStatus = deriveCommissionStatus({ pledged, commissionPaid, invoiceFullyPaid, hasReversed });
  const commissionOutstanding = Math.max(0, Number(pledged || 0) - commissionPaid);

  return {
    invoiceId, invoiceNumber: inv.invoice_number, customer: inv.customer,
    invoiceTotal, amount, totalPaid, outstanding, invoiceFullyPaid,
    pledged, beneficiaryName, beneficiaryPhone,
    commissionPaid, commissionOutstanding, commissionStatus,
  };
}
