import { pgGet, pgAll } from "../db.js";

export type PayRow = { label: string; value: string };

// Fallback M-Pesa lines used only when no M-Pesa account is configured in Finance.
const fallbackMpesa = (reg: string): PayRow[] => [
  { label: "MPESA PAYBILL", value: `Paybill: 4048569 | Account: ${reg}` },
  { label: "MPESA TILL NUMBER", value: "Till: 5620852" },
];

/** Render a single M-Pesa bank_accounts row for the payment table. */
function mpesaRow(m: any, reg: string): PayRow {
  const label = (m.account_name || "M-PESA").toUpperCase();
  const type = `${m.account_type || ""} ${m.account_name || ""}`.toLowerCase();
  if (type.includes("till")) return { label, value: `Till: ${m.account_number}` };
  // Default to Paybill format (with the vehicle reg as the account reference).
  return { label, value: `Paybill: ${m.account_number} | Account: ${reg}` };
}

/**
 * Build the "MODE OF PAYMENTS" rows for a quote/proforma/invoice.
 *
 * - When the document is tied to a partner bank, the partner's configured bank
 *   account (bank_accounts.partner_id) auto-populates the full transfer details:
 *   bank name, branch (+ code), account number, payee, and any instructions.
 * - Otherwise (private / direct / non-partner-priced deals) the configured
 *   M-Pesa accounts are shown, so those customers pay by M-Pesa.
 *
 * partnerName is kept as a fuzzy fallback for older partners not yet linked to a
 * bank account via partner_id.
 */
export async function buildPaymentDetails(opts: {
  partnerId?: string | null;
  partnerName?: string | null;
  vehicleReg?: string | null;
}): Promise<PayRow[]> {
  const reg = (opts.vehicleReg || "").trim() || "(Vehicle Reg.)";

  // 0. Per-bank "Pay To" override from Document Configuration (doc_bank_configs).
  //    Editable in one place (doc-bank-settings.html) and shown identically on the
  //    bank's quotation / proforma / invoice. Falls through to bank_accounts below
  //    when a bank hasn't been configured here.
  if (opts.partnerId) {
    const cfg = await pgGet<any>(
      `SELECT pay_to_bank_name, pay_to_branch, pay_to_account_no, pay_to_payee
         FROM doc_bank_configs WHERE partner_id = ?`,
      [String(opts.partnerId)],
    ).catch(() => null);
    if (cfg && (String(cfg.pay_to_account_no || "").trim() || String(cfg.pay_to_bank_name || "").trim())) {
      const rows: PayRow[] = [];
      if (cfg.pay_to_bank_name)  rows.push({ label: "BANK NAME",   value: String(cfg.pay_to_bank_name).trim() });
      if (cfg.pay_to_branch)     rows.push({ label: "BRANCH",      value: String(cfg.pay_to_branch).trim() });
      if (cfg.pay_to_account_no) rows.push({ label: "ACCOUNT NO.", value: String(cfg.pay_to_account_no).trim() });
      if (cfg.pay_to_payee)      rows.push({ label: "PAYEE",       value: String(cfg.pay_to_payee).trim() });
      if (rows.length) return rows;
    }
  }

  // 1. Partner bank account (explicit link, then fuzzy name fallback)
  if (opts.partnerId || opts.partnerName) {
    let bank: any = null;
    if (opts.partnerId) {
      bank = await pgGet(
        `SELECT * FROM bank_accounts
         WHERE partner_id = ? AND is_active = true AND COALESCE(payment_method,'bank') = 'bank'
         ORDER BY updated_at DESC LIMIT 1`,
        [opts.partnerId],
      ).catch(() => null);
    }
    if (!bank && opts.partnerName) {
      const key = opts.partnerName.trim().split(/\s+/)[0];
      if (key) {
        bank = await pgGet(
          `SELECT * FROM bank_accounts
           WHERE is_active = true AND COALESCE(payment_method,'bank') = 'bank'
             AND LOWER(bank_name) LIKE LOWER(?)
           ORDER BY created_at LIMIT 1`,
          [`%${key}%`],
        ).catch(() => null);
      }
    }
    if (bank) {
      const rows: PayRow[] = [{ label: "BANK NAME", value: bank.bank_name || bank.account_name }];
      const branch = [bank.branch, bank.branch_code ? `(Code ${bank.branch_code})` : null].filter(Boolean).join(" ");
      if (branch) rows.push({ label: "BRANCH", value: branch });
      rows.push({ label: "ACCOUNT NO.", value: String(bank.account_number) });
      const payee = bank.payee_name || bank.account_name;
      if (payee) rows.push({ label: "PAYEE", value: payee });
      if (bank.payment_instructions) rows.push({ label: "INSTRUCTIONS", value: bank.payment_instructions });
      return rows;
    }
  }

  // 2. Non-partner / private → M-Pesa (configured accounts, else built-in defaults)
  const mpesa = await pgAll(
    `SELECT * FROM bank_accounts WHERE is_active = true AND payment_method = 'mpesa' ORDER BY created_at`,
    [],
  ).catch(() => [] as any[]);
  if (mpesa.length) return mpesa.map((m: any) => mpesaRow(m, reg));
  return fallbackMpesa(reg);
}
