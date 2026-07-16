import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { pgAll, pgGet, pgRun } from "../db.js";

const router = Router();

const createSchema = z.object({
  accountName:    z.string().min(1),
  bankName:       z.string().min(1),
  accountNumber:  z.string().min(1),
  branch:         z.string().nullable().optional(),
  accountType:    z.enum(["Current", "Savings", "Fixed Deposit", "Mobile Money"]).optional().default("Current"),
  currency:       z.string().optional().default("KES"),
  openingBalance: z.number().optional().default(0),
  notes:          z.string().nullable().optional(),
});

const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

function mapRow(r: any) {
  return {
    id:             r.id,
    accountName:    r.account_name,
    bankName:       r.bank_name,
    accountNumber:  r.account_number,
    branch:         r.branch || null,
    accountType:    r.account_type,
    currency:       r.currency,
    openingBalance: Number(r.opening_balance),
    currentBalance: Number(r.current_balance),
    isActive:       r.is_active,
    notes:          r.notes || null,
    createdBy:      r.created_by || null,
    createdAt:      r.created_at,
    updatedAt:      r.updated_at,
  };
}

// GET /api/bank-accounts
router.get("/", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (_req, res) => {
  const rows = await pgAll(`
    SELECT ba.*,
      COALESCE((
        SELECT SUM(p.amount) FROM payments p
        WHERE p.bank = ba.bank_name AND p.status = 'Completed'
      ), 0) AS payments_received
    FROM bank_accounts ba
    ORDER BY ba.is_active DESC, ba.bank_name, ba.account_name
  `);
  // Sync current_balance = opening + payments received
  return res.json({ data: rows.map(mapRow) });
});

// GET /api/bank-accounts/:id
router.get("/:id", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req, res) => {
  const row = await pgGet("SELECT * FROM bank_accounts WHERE id = $1", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Bank account not found");
  return res.json({ data: mapRow(row) });
});

// POST /api/bank-accounts
router.post("/", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());
  const d = parsed.data;

  // check duplicate account number
  const existing = await pgGet("SELECT id FROM bank_accounts WHERE account_number = $1", [d.accountNumber]);
  if (existing) return errorResponse(res, 409, "CONFLICT", "An account with this number already exists");

  await pgRun(`
    INSERT INTO bank_accounts (account_name, bank_name, account_number, branch, account_type, currency, opening_balance, current_balance, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)
  `, [d.accountName, d.bankName, d.accountNumber, d.branch || null, d.accountType, d.currency, d.openingBalance, d.notes || null, req.user!.email]);

  const created = await pgGet("SELECT * FROM bank_accounts WHERE account_number = $1", [d.accountNumber]);
  auditLog(req, "BANK_ACCOUNT_CREATED", `bank_account:${created?.id}`, "Info", { accountName: d.accountName, bankName: d.bankName }).catch(console.error);
  return res.status(201).json({ data: mapRow(created), message: "Bank account created" });
});

// PATCH /api/bank-accounts/:id
router.patch("/:id", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());

  const existing = await pgGet("SELECT * FROM bank_accounts WHERE id = $1", [req.params.id]);
  if (!existing) return errorResponse(res, 404, "NOT_FOUND", "Bank account not found");

  const d = parsed.data;
  const sets: string[] = [];
  const params: any[] = [];
  let i = 1;
  const add = (col: string, val: any) => { sets.push(`${col} = $${i++}`); params.push(val); };

  if (d.accountName   !== undefined) add("account_name",    d.accountName);
  if (d.bankName      !== undefined) add("bank_name",       d.bankName);
  if (d.accountNumber !== undefined) add("account_number",  d.accountNumber);
  if (d.branch        !== undefined) add("branch",          d.branch || null);
  if (d.accountType   !== undefined) add("account_type",    d.accountType);
  if (d.currency      !== undefined) add("currency",        d.currency);
  if (d.openingBalance !== undefined) add("opening_balance", d.openingBalance);
  if (d.notes         !== undefined) add("notes",           d.notes || null);
  if (d.isActive      !== undefined) add("is_active",       d.isActive);
  add("updated_at", new Date().toISOString());
  params.push(req.params.id);

  await pgRun(`UPDATE bank_accounts SET ${sets.join(", ")} WHERE id = $${i}`, params);
  const updated = await pgGet("SELECT * FROM bank_accounts WHERE id = $1", [req.params.id]);
  auditLog(req, "BANK_ACCOUNT_UPDATED", `bank_account:${req.params.id}`, "Info", d).catch(console.error);
  return res.json({ data: mapRow(updated), message: "Bank account updated" });
});

// DELETE /api/bank-accounts/:id  (soft-deactivate)
router.delete("/:id", requireAuth, requireRole(ROLE_GROUPS.FINANCE_AMEND), async (req: AuthRequest, res) => {
  const existing = await pgGet("SELECT id FROM bank_accounts WHERE id = $1", [req.params.id]);
  if (!existing) return errorResponse(res, 404, "NOT_FOUND", "Bank account not found");
  await pgRun("UPDATE bank_accounts SET is_active = false, updated_at = $1 WHERE id = $2", [new Date().toISOString(), req.params.id]);
  auditLog(req, "BANK_ACCOUNT_DEACTIVATED", `bank_account:${req.params.id}`, "Warning", {}).catch(console.error);
  return res.json({ message: "Bank account deactivated" });
});

export default router;
