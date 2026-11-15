import { Router } from "express";
import crypto from "crypto";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { getCommissionContext } from "../services/commissionService.js";

const router = Router();

// ─── DB INIT ─────────────────────────────────────────────────────────────────

export const initReferrersSchema = async () => {
  // Master referrers list
  await pgRun(`
    CREATE TABLE IF NOT EXISTS referrers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      phone       TEXT,
      email       TEXT,
      notes       TEXT,
      created_by  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `);

  // Referrer payment records (one per invoice payment)
  await pgRun(`
    CREATE TABLE IF NOT EXISTS referrer_payments (
      id               TEXT PRIMARY KEY,
      referrer_id      TEXT,
      referrer_name    TEXT NOT NULL,
      invoice_id       TEXT,
      invoice_number   TEXT,
      customer         TEXT,
      fee_amount       DOUBLE PRECISION NOT NULL,
      transaction_code TEXT,
      payment_date     TEXT NOT NULL,
      created_by       TEXT,
      notes            TEXT,
      created_at       TEXT NOT NULL
    )
  `);

  await pgRun(`CREATE INDEX IF NOT EXISTS idx_referrer_payments_referrer_id  ON referrer_payments(referrer_id)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_referrer_payments_invoice_id   ON referrer_payments(invoice_id)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_referrer_payments_payment_date ON referrer_payments(payment_date)`);
  // Link each commission to the specific bank payment it was deducted from.
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS payment_id TEXT`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_referrer_payments_payment_id ON referrer_payments(payment_id)`);
  // Proposed commission carried from the lead (fee_amount = the amount actually paid).
  // Storing both lets Finance compare what was pledged vs. what was disbursed.
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS proposed_commission DOUBLE PRECISION`);
  // ── Commission lifecycle (Phase 1): a commission payout is its own financial event,
  //    independent of the invoice payment. Status is DERIVED (see commissionService);
  //    we persist only what a derivation can't recompute. Amounts are never overwritten —
  //    a reversal sets status='Reversed' (a flag) and is audited.
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS commission_mode TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS beneficiary_type TEXT DEFAULT 'referrer'`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS is_advance BOOLEAN DEFAULT FALSE`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS advance_reason TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS authorized_by_user_id TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS authorized_by_email TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS reconciliation_status TEXT DEFAULT 'NotApplicable'`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS reconciled_at TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS status TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS reversed_at TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS reversed_by_email TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS reversal_reason TEXT`);
  // ── Advance approval: paying commission before the invoice is collected is
  //    spending money the company hasn't received, so it now needs a SECOND
  //    person. Until then the payout is held: it exists as a record but is
  //    excluded from every "paid" figure (see COUNTS_AS_PAID).
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'NotRequired'`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS approved_by_user_id TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS approved_by_email TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS approved_at TEXT`);
  await pgRun(`ALTER TABLE referrer_payments ADD COLUMN IF NOT EXISTS approval_notes TEXT`);
  // Everything recorded before this rule existed stays exactly as it was.
  // The ALTER's DEFAULT already stamped existing rows 'NotRequired', so key off
  // that, not NULL. Safe to re-run: new advances are created 'Pending', so only
  // pre-existing ones ever match.
  await pgRun(`UPDATE referrer_payments SET approval_status = 'Approved',
                  approval_notes = COALESCE(approval_notes, 'Approved under the previous rule — recorded before advance approval existed')
                WHERE is_advance = TRUE AND COALESCE(approval_status, 'NotRequired') = 'NotRequired'`);
  await pgRun(`UPDATE referrer_payments SET approval_status = 'NotRequired' WHERE approval_status IS NULL`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_referrer_payments_approval ON referrer_payments(approval_status)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_referrer_payments_recon   ON referrer_payments(reconciliation_status)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_referrer_payments_advance ON referrer_payments(is_advance)`);

  console.log("[referrers] Schema ready");
};

/**
 * A payout only counts as money out once it is allowed to be paid: never
 * required approval, or approval granted. Held ('Pending') and refused
 * ('Rejected') advances are excluded from every total, the exposure figure and
 * the invoice ledger, so the books show only authorised money.
 */
export const COUNTS_AS_PAID = "COALESCE(approval_status, 'NotRequired') IN ('NotRequired','Approved')";

/**
 * Record a single referrer commission payout, auto-creating the referrer master row
 * (matched by name) when it doesn't exist. Shared by the standalone referrer-payment
 * endpoint and the Process Payment flow (payments route).
 */
export async function recordReferrerCommission(opts: {
  referrerName: string;
  referrerId?: string | null;
  referrerPhone?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  feeAmount: number;
  proposedCommission?: number | null;
  transactionCode?: string | null;
  paymentDate?: string | null;
  notes?: string | null;
  actorEmail?: string | null;
  // Commission-lifecycle fields (Phase 1) — all optional; existing callers unaffected.
  commissionMode?: string | null;
  beneficiaryType?: string | null;
  advanceReason?: string | null;
  authorizedByUserId?: string | null;
  authorizedByEmail?: string | null;
}): Promise<any> {
  const now = new Date().toISOString();
  let resolvedReferrerId = opts.referrerId || null;
  if (!resolvedReferrerId) {
    const existing = await pgGet("SELECT id FROM referrers WHERE name ILIKE ?", [opts.referrerName.trim()]);
    if (existing) {
      resolvedReferrerId = existing.id;
      if (opts.referrerPhone?.trim()) {
        await pgRun("UPDATE referrers SET phone = COALESCE(phone, ?), updated_at = ? WHERE id = ?",
          [opts.referrerPhone.trim(), now, existing.id]);
      }
    } else {
      resolvedReferrerId = crypto.randomUUID();
      await pgRun(
        "INSERT INTO referrers (id, name, phone, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [resolvedReferrerId, opts.referrerName.trim(), opts.referrerPhone?.trim() || null, opts.actorEmail || null, now, now]
      );
    }
  }
  let invoiceNumber: string | null = null;
  let customer: string | null = null;
  if (opts.invoiceId) {
    const inv = await pgGet("SELECT invoice_number, customer FROM invoices WHERE id = ?", [opts.invoiceId]);
    if (inv) { invoiceNumber = inv.invoice_number; customer = inv.customer; }
  }
  const id = crypto.randomUUID();
  const date = opts.paymentDate || now.slice(0, 10);
  // Advance = commission paid while the invoice is NOT yet fully paid. Derived from the
  // invoice's current paid state (the receipt from a "both" flow is already recorded by now).
  let isAdvance = false;
  if (opts.invoiceId && Number(opts.feeAmount) > 0) {
    const ctx = await getCommissionContext(opts.invoiceId).catch(() => null);
    if (ctx && !ctx.invoiceFullyPaid) isAdvance = true;
  }
  const reconStatus = isAdvance ? "Pending" : "NotApplicable";
  await pgRun(
    `INSERT INTO referrer_payments
       (id, referrer_id, referrer_name, invoice_id, invoice_number, customer, fee_amount, proposed_commission,
        transaction_code, payment_date, created_by, notes, payment_id,
        commission_mode, beneficiary_type, is_advance, advance_reason, authorized_by_user_id, authorized_by_email,
        reconciliation_status, created_at, approval_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, resolvedReferrerId, opts.referrerName.trim(), opts.invoiceId || null, invoiceNumber, customer,
     Number(opts.feeAmount),
     (opts.proposedCommission != null && !isNaN(Number(opts.proposedCommission))) ? Number(opts.proposedCommission) : null,
     opts.transactionCode?.trim() || null, date, opts.actorEmail || null, opts.notes?.trim() || null, opts.paymentId || null,
     opts.commissionMode?.trim() || null, opts.beneficiaryType?.trim() || "referrer", isAdvance,
     isAdvance ? (opts.advanceReason?.trim() || null) : null,
     isAdvance ? (opts.authorizedByUserId || null) : null, isAdvance ? (opts.authorizedByEmail || null) : null,
     reconStatus, now,
     // An advance is HELD until a second person releases it.
     isAdvance ? "Pending" : "NotRequired"]
  );
  return await pgGet("SELECT * FROM referrer_payments WHERE id = ?", [id]);
}

// ─── REFERRERS CRUD ──────────────────────────────────────────────────────────

/** GET /referrers — list all referrers (for autocomplete) */
router.get("/", requireAuth, requireRole(ROLE_GROUPS.PROFORMA_APPROVE), async (req, res) => {
  const rows = await pgAll(
    "SELECT id, name, phone, email, notes, created_at FROM referrers ORDER BY name ASC",
    []
  );
  return res.status(200).json({ data: rows });
});

/** POST /referrers — create a referrer */
router.post("/", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const { name, phone, email, notes } = req.body;
  if (!name?.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "name is required");
  const existing = await pgGet("SELECT id FROM referrers WHERE name ILIKE ?", [name.trim()]);
  if (existing) return errorResponse(res, 409, "CONFLICT", "A referrer with this name already exists");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await pgRun(
    "INSERT INTO referrers (id, name, phone, email, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, name.trim(), phone?.trim() || null, email?.trim() || null, notes?.trim() || null, req.user?.email || null, now, now]
  );
  const row = await pgGet("SELECT * FROM referrers WHERE id = ?", [id]);
  auditLog(req, "REFERRER_CREATED", `referrer:${id}`, "Info", { name }).catch(console.error);
  return res.status(201).json({ data: row });
});

// ─── REFERRER PAYMENTS ───────────────────────────────────────────────────────

/** GET /referrers/payments — list all referrer payments with optional filters */
router.get("/payments", requireAuth, requireRole(ROLE_GROUPS.PROFORMA_APPROVE), async (req, res) => {
  const { referrerId, invoiceId, from, to, page = "1", pageSize = "50" } = req.query as Record<string, string>;
  const clauses: string[] = [];
  const params: any[] = [];
  if (referrerId) { clauses.push("rp.referrer_id = ?"); params.push(referrerId); }
  if (invoiceId)  { clauses.push("rp.invoice_id = ?");  params.push(invoiceId); }
  if (from)       { clauses.push("rp.payment_date >= ?"); params.push(from); }
  if (to)         { clauses.push("rp.payment_date <= ?"); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const ps = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (pg - 1) * ps;
  const rows = await pgAll(
    // Per-deal commission ledger: each referrer_payments row enriched with the deal
    // context (installation, vehicle, bank, quote) and the invoice receipt it was
    // deducted from. p = the exact receipt (rp.payment_id); pf = fallback latest
    // Completed payment on the invoice. amount_paid = the banked receipt amount;
    // net_to_finemark = amount_paid − commission (the amount Finemark retains).
    `SELECT rp.*, r.phone AS referrer_phone, r.email AS referrer_email,
            i.customer AS invoice_customer, i.sales_person,
            COALESCE(i.total, i.amount, 0) AS invoice_amount,
            t.technician_signed_off_at AS installation_date,
            t.technician_signed_off_by_name AS technician,
            COALESCE(cv.registration, t.vehicle_registration, q.vehicle_registration) AS vehicle_reg,
            COALESCE(pt.name, rl.bank_partner_name, NULLIF(t.installation_financer, 'Bank Financed'), t.installation_financer, p.bank, pf.bank, i.bank) AS bank,
            COALESCE(cv.loan_tenure_months, q.loan_term_months) AS loan_duration,
            COALESCE(q.total_amount, i.subtotal, i.total, i.amount) AS amount_quoted,
            COALESCE(p.paid_at, pf.paid_at) AS pay_date,
            COALESCE(p.payment_ref, pf.payment_ref) AS pay_ref,
            COALESCE(p.amount, pf.amount, i.total, i.amount, 0) AS amount_paid,
            COALESCE(p.amount, pf.amount, i.total, i.amount, 0) - COALESCE(rp.fee_amount, 0) AS net_to_finemark,
            COALESCE(i.total, i.amount, 0) - COALESCE(rp.fee_amount, 0) AS net_amount
     FROM referrer_payments rp
     LEFT JOIN referrers r ON r.id = rp.referrer_id
     LEFT JOIN invoices i ON i.id = rp.invoice_id
     LEFT JOIN payments p ON p.id = rp.payment_id
     LEFT JOIN LATERAL (
       SELECT paid_at, payment_ref, amount, bank FROM payments
       WHERE invoice_id = rp.invoice_id AND status = 'Completed'
       ORDER BY paid_at DESC LIMIT 1
     ) pf ON TRUE
     LEFT JOIN LATERAL (
       SELECT technician_signed_off_at, technician_signed_off_by_name, vehicle_registration,
              installation_financer, retail_lead_id, vehicle_id, quote_id
       FROM installation_tickets
       WHERE invoice_id = i.id AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1
     ) t ON TRUE
     LEFT JOIN crm_customer_vehicles cv ON cv.id = t.vehicle_id
     LEFT JOIN partners pt ON pt.id::text = cv.partner_id::text AND pt.deleted_at IS NULL
     LEFT JOIN crm_quotes q ON q.id = COALESCE(i.quote_id, t.quote_id)
     LEFT JOIN retail_leads rl ON rl.id = t.retail_lead_id
     ${where} ORDER BY rp.payment_date DESC, rp.created_at DESC LIMIT ? OFFSET ?`,
    [...params, ps, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM referrer_payments rp ${where}`, params);
  return res.status(200).json({ data: rows, meta: { total: Number(totalRow?.total ?? 0), page: pg, pageSize: ps } });
});

/** GET /referrers/payments/summary — total paid per referrer */
router.get("/payments/summary", requireAuth, requireRole(ROLE_GROUPS.PROFORMA_APPROVE), async (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  const clauses: string[] = [];
  const params: any[] = [];
  if (from) { clauses.push("payment_date >= ?"); params.push(from); }
  if (to)   { clauses.push("payment_date <= ?"); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await pgAll(
    `SELECT referrer_id, referrer_name,
       COUNT(*) as payment_count,
       COALESCE(SUM(fee_amount) FILTER (WHERE COALESCE(approval_status, 'NotRequired') IN ('NotRequired','Approved')), 0) as total_paid,
       COALESCE(SUM(fee_amount) FILTER (WHERE approval_status = 'Pending'), 0) as total_awaiting_approval
     FROM referrer_payments ${where}
     GROUP BY referrer_id, referrer_name ORDER BY total_paid DESC`,
    params
  );
  return res.status(200).json({ data: rows });
});

/** GET /referrers/payments/exposure — total commission cash paid out in advance that is still
 *  outstanding against uncollected invoices (is_advance & reconciliation_status='Pending', excluding
 *  reversed). Feeds the finance dashboard's "Advanced Commission Exposure" metric. */
router.get("/payments/exposure", requireAuth, requireRole(ROLE_GROUPS.PROFORMA_APPROVE), async (_req, res) => {
  const row = await pgGet<{ exposure: number; cnt: number; awaiting_approval: number; awaiting_count: number }>(
    `SELECT COALESCE(SUM(fee_amount) FILTER (WHERE COALESCE(approval_status, 'NotRequired') IN ('NotRequired','Approved')), 0) AS exposure,
            COUNT(*) FILTER (WHERE COALESCE(approval_status, 'NotRequired') IN ('NotRequired','Approved')) AS cnt,
            COALESCE(SUM(fee_amount) FILTER (WHERE approval_status = 'Pending'), 0) AS awaiting_approval,
            COUNT(*) FILTER (WHERE approval_status = 'Pending') AS awaiting_count
       FROM referrer_payments
      WHERE is_advance = TRUE
        AND reconciliation_status = 'Pending'
        AND (status IS NULL OR status <> 'Reversed')`
  );
  return res.status(200).json({ data: {
    advancedCommissionExposure: Number(row?.exposure ?? 0), advanceCount: Number(row?.cnt ?? 0),
    // Raised but not yet released — not money out, shown separately.
    awaitingApproval: Number((row as any)?.awaiting_approval ?? 0), awaitingApprovalCount: Number((row as any)?.awaiting_count ?? 0),
  } });
});

/** POST /referrers/payments — the "Process Commission" action (commission-only, independent of
 *  any invoice payment). If the invoice isn't fully paid this is an Advanced Commission and an
 *  Advanced Commission Reason is required (inline authorization by the acting Finance/Admin user). */
router.post("/payments", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const { referrerName, referrerId, referrerPhone, invoiceId, feeAmount, transactionCode, paymentDate, notes,
          commissionMode, beneficiaryType, advanceReason } = req.body;
  if (!referrerName?.trim())      return errorResponse(res, 400, "VALIDATION_ERROR", "referrerName is required");
  if (!feeAmount || feeAmount <= 0) return errorResponse(res, 400, "VALIDATION_ERROR", "feeAmount must be > 0");

  // Advance guard: paying commission before the invoice is fully paid needs a reason.
  let willBeAdvance = false;
  if (invoiceId) {
    const ctx = await getCommissionContext(invoiceId).catch(() => null);
    if (ctx && !ctx.invoiceFullyPaid) {
      willBeAdvance = true;
      if (!String(advanceReason || "").trim()) {
        return errorResponse(res, 400, "ADVANCE_REASON_REQUIRED",
          "This commission is being paid before the invoice is fully paid — an Advanced Commission Reason is required.");
      }
    }
  }

  const row = await recordReferrerCommission({
    referrerName, referrerId, referrerPhone, invoiceId, feeAmount,
    transactionCode, paymentDate, notes, commissionMode, beneficiaryType, advanceReason,
    authorizedByUserId: req.user?.id || null, authorizedByEmail: req.user?.email || null,
    actorEmail: req.user?.email || null,
  });
  auditLog(req, willBeAdvance ? "COMMISSION_ADVANCE_REQUESTED" : "REFERRER_PAYMENT_CREATED", `referrer_payment:${row.id}`, willBeAdvance ? "Warning" : "Info", {
    referrerName, invoiceId, feeAmount, isAdvance: row.is_advance, advanceReason: row.advance_reason || undefined,
  }).catch(console.error);
  return res.status(201).json({
    data: row,
    message: row.is_advance
      ? "Advanced commission recorded — HELD until a second approver releases it. It is excluded from commission totals until then."
      : "Commission recorded",
  });
});

/** POST /referrers/payments/:id/reverse — reverse a commission payout (never deletes/edits the
 *  original amount; sets a status flag + audit trail). */
router.post("/payments/:id/reverse", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const { reason } = req.body || {};
  if (!reason?.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "A reversal reason is required.");
  const row = await pgGet<any>("SELECT * FROM referrer_payments WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Commission payout not found.");
  if (row.status === "Reversed") return errorResponse(res, 409, "ALREADY_REVERSED", "This commission payout is already reversed.");
  const now = new Date().toISOString();
  await pgRun(
    "UPDATE referrer_payments SET status = 'Reversed', reversed_at = ?, reversed_by_email = ?, reversal_reason = ? WHERE id = ?",
    [now, req.user?.email || null, String(reason).trim(), req.params.id]
  );
  auditLog(req, "COMMISSION_REVERSED", `referrer_payment:${req.params.id}`, "Warning", {
    referrerName: row.referrer_name, invoiceId: row.invoice_id, feeAmount: row.fee_amount, reason: String(reason).trim(),
  }).catch(console.error);
  const updated = await pgGet("SELECT * FROM referrer_payments WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: updated, message: "Commission payout reversed." });
});

// ─── ADVANCE APPROVAL ────────────────────────────────────────────────────────
// Paying commission before the invoice is collected is spending uncollected
// money, so it takes a second person: MANAGEMENT (Admin/Executive), and never
// the person who raised it. A held payout counts for nothing until released.

/** GET /referrers/payments/pending — advances waiting for a second approver. */
router.get("/payments/pending", requireAuth, requireRole(ROLE_GROUPS.MANAGEMENT), async (_req: AuthRequest, res) => {
  const rows = await pgAll(
    `SELECT p.*, i.invoice_number AS inv_no, i.amount AS invoice_amount
       FROM referrer_payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
      WHERE p.approval_status = 'Pending' AND (p.status IS NULL OR p.status <> 'Reversed')
      ORDER BY p.created_at DESC`
  );
  const total = rows.reduce((sum: number, r: any) => sum + Number(r.fee_amount || 0), 0);
  return res.status(200).json({ data: rows, meta: { count: rows.length, totalHeld: total } });
});

/** POST /referrers/payments/:id/approve — release a held advance for payment. */
router.post("/payments/:id/approve", requireAuth, requireRole(ROLE_GROUPS.MANAGEMENT), async (req: AuthRequest, res) => {
  const row = await pgGet<any>("SELECT * FROM referrer_payments WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Commission payout not found.");
  if (row.approval_status !== "Pending") {
    return errorResponse(res, 409, "NOT_PENDING", `This payout is not awaiting approval (it is ${row.approval_status || "NotRequired"}).`);
  }
  if (row.status === "Reversed") return errorResponse(res, 409, "ALREADY_REVERSED", "This payout has been reversed.");
  // The whole point is a second pair of eyes.
  const actorId = req.user?.id || null, actorEmail = (req.user?.email || "").toLowerCase();
  if ((row.authorized_by_user_id && row.authorized_by_user_id === actorId) ||
      (row.created_by && String(row.created_by).toLowerCase() === actorEmail)) {
    return errorResponse(res, 403, "SELF_APPROVAL", "You raised this advance — someone else must approve it.");
  }
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE referrer_payments SET approval_status = 'Approved', approved_by_user_id = ?, approved_by_email = ?, approved_at = ?, approval_notes = ? WHERE id = ?`,
    [actorId, req.user?.email || null, now, String((req.body || {}).notes || "").trim() || null, req.params.id]
  );
  auditLog(req, "COMMISSION_ADVANCE_APPROVED", `referrer_payment:${req.params.id}`, "Warning", {
    referrerName: row.referrer_name, invoiceId: row.invoice_id, feeAmount: row.fee_amount,
    raisedBy: row.created_by, advanceReason: row.advance_reason || undefined,
  }).catch(console.error);
  const updated = await pgGet("SELECT * FROM referrer_payments WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: updated, message: "Advance approved — it now counts as paid." });
});

/** POST /referrers/payments/:id/reject — refuse a held advance; it never counts as paid. */
router.post("/payments/:id/reject", requireAuth, requireRole(ROLE_GROUPS.MANAGEMENT), async (req: AuthRequest, res) => {
  const reason = String((req.body || {}).reason || "").trim();
  if (!reason) return errorResponse(res, 400, "VALIDATION_ERROR", "A reason is required when refusing an advance.");
  const row = await pgGet<any>("SELECT * FROM referrer_payments WHERE id = ?", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Commission payout not found.");
  if (row.approval_status !== "Pending") {
    return errorResponse(res, 409, "NOT_PENDING", `This payout is not awaiting approval (it is ${row.approval_status || "NotRequired"}).`);
  }
  const actorId = req.user?.id || null, actorEmail = (req.user?.email || "").toLowerCase();
  if ((row.authorized_by_user_id && row.authorized_by_user_id === actorId) ||
      (row.created_by && String(row.created_by).toLowerCase() === actorEmail)) {
    return errorResponse(res, 403, "SELF_APPROVAL", "You raised this advance — someone else must decide it.");
  }
  await pgRun(
    `UPDATE referrer_payments SET approval_status = 'Rejected', approved_by_user_id = ?, approved_by_email = ?, approved_at = ?, approval_notes = ? WHERE id = ?`,
    [actorId, req.user?.email || null, new Date().toISOString(), reason, req.params.id]
  );
  auditLog(req, "COMMISSION_ADVANCE_REJECTED", `referrer_payment:${req.params.id}`, "Warning", {
    referrerName: row.referrer_name, invoiceId: row.invoice_id, feeAmount: row.fee_amount, raisedBy: row.created_by, reason,
  }).catch(console.error);
  const updated = await pgGet("SELECT * FROM referrer_payments WHERE id = ?", [req.params.id]);
  return res.status(200).json({ data: updated, message: "Advance refused — it does not count as paid." });
});

export default router;

