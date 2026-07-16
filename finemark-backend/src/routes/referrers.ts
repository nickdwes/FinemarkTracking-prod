import { Router } from "express";
import crypto from "crypto";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

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

  console.log("[referrers] Schema ready");
};

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
    `SELECT rp.*, r.phone as referrer_phone, r.email as referrer_email
     FROM referrer_payments rp
     LEFT JOIN referrers r ON r.id = rp.referrer_id
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
       SUM(fee_amount) as total_paid
     FROM referrer_payments ${where}
     GROUP BY referrer_id, referrer_name ORDER BY total_paid DESC`,
    params
  );
  return res.status(200).json({ data: rows });
});

/** POST /referrers/payments — record a referrer payment */
router.post("/payments", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const { referrerName, referrerId, referrerPhone, invoiceId, feeAmount, transactionCode, paymentDate, notes } = req.body;
  if (!referrerName?.trim())      return errorResponse(res, 400, "VALIDATION_ERROR", "referrerName is required");
  if (!feeAmount || feeAmount <= 0) return errorResponse(res, 400, "VALIDATION_ERROR", "feeAmount must be > 0");

  // Auto-create referrer record if not already in the table
  let resolvedReferrerId = referrerId || null;
  if (!resolvedReferrerId) {
    const existing = await pgGet("SELECT id FROM referrers WHERE name ILIKE ?", [referrerName.trim()]);
    if (existing) {
      resolvedReferrerId = existing.id;
      // Update phone if supplied and not already set
      if (referrerPhone?.trim()) {
        await pgRun("UPDATE referrers SET phone = COALESCE(phone, ?), updated_at = ? WHERE id = ?",
          [referrerPhone.trim(), new Date().toISOString(), existing.id]);
      }
    } else {
      resolvedReferrerId = crypto.randomUUID();
      const now = new Date().toISOString();
      await pgRun(
        "INSERT INTO referrers (id, name, phone, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [resolvedReferrerId, referrerName.trim(), referrerPhone?.trim() || null, req.user?.email || null, now, now]
      );
    }
  }

  // Fetch invoice details for denormalization
  let invoiceNumber: string | null = null;
  let customer: string | null = null;
  if (invoiceId) {
    const inv = await pgGet("SELECT invoice_number, customer FROM invoices WHERE id = ?", [invoiceId]);
    if (inv) { invoiceNumber = inv.invoice_number; customer = inv.customer; }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const date = paymentDate || now.slice(0, 10);
  await pgRun(
    `INSERT INTO referrer_payments
       (id, referrer_id, referrer_name, invoice_id, invoice_number, customer, fee_amount, transaction_code, payment_date, created_by, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, resolvedReferrerId, referrerName.trim(), invoiceId || null, invoiceNumber, customer,
     Number(feeAmount), transactionCode?.trim() || null, date, req.user?.email || null, notes?.trim() || null, now]
  );

  const row = await pgGet("SELECT * FROM referrer_payments WHERE id = ?", [id]);
  auditLog(req, "REFERRER_PAYMENT_CREATED", `referrer_payment:${id}`, "Info", {
    referrerName, invoiceId, feeAmount,
  }).catch(console.error);
  return res.status(201).json({ data: row, message: "Referrer payment recorded" });
});

export default router;
