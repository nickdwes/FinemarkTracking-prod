import { Router } from "express";
import { pgAll, pgExec } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok } from "../utils/responses.js";

const router = Router();

// Owns the credit_notes domain table — the single Finance resolution record
// for a "Billing Issue" / "Internal Billing" ticket (approved/rejected claim,
// and — when a reimbursement is issued — the credit note or cheque details).
// Written by crm-tickets.ts's POST /:id/resolve-billing, mirroring how
// device-custody.ts owns di_reinstallations while crm-tickets.ts's
// POST /:id/swap-device does the actual INSERT into it.
pgExec(`
  CREATE TABLE IF NOT EXISTS credit_notes (
    id                    TEXT PRIMARY KEY,
    credit_note_no        TEXT UNIQUE,
    ticket_id             TEXT NOT NULL,
    ticket_no             TEXT,
    invoice_id            TEXT,
    invoice_number        TEXT,
    customer_id           TEXT,
    outcome               TEXT NOT NULL,
    reimbursement_issued  BOOLEAN NOT NULL DEFAULT FALSE,
    method                TEXT,
    claim_amount          DOUBLE PRECISION,
    commission_fee        DOUBLE PRECISION,
    tax_amount            DOUBLE PRECISION,
    net_amount            DOUBLE PRECISION,
    cheque_number         TEXT,
    reason                TEXT NOT NULL,
    created_by_user_id    TEXT NOT NULL,
    created_by_email      TEXT,
    created_at            TEXT NOT NULL
  )
`).catch(e => console.error("[credit_notes] init:", e));

pgExec(`CREATE INDEX IF NOT EXISTS idx_credit_notes_ticket   ON credit_notes(ticket_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice  ON credit_notes(invoice_id)`).catch(() => {});
pgExec(`CREATE INDEX IF NOT EXISTS idx_credit_notes_customer ON credit_notes(customer_id)`).catch(() => {});

function mapCreditNote(row: any) {
  return {
    id: row.id,
    creditNoteNo: row.credit_note_no,
    ticketId: row.ticket_id,
    ticketNo: row.ticket_no,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    customerId: row.customer_id,
    outcome: row.outcome,
    reimbursementIssued: row.reimbursement_issued,
    method: row.method,
    claimAmount: row.claim_amount != null ? Number(row.claim_amount) : null,
    commissionFee: row.commission_fee != null ? Number(row.commission_fee) : null,
    taxAmount: row.tax_amount != null ? Number(row.tax_amount) : null,
    netAmount: row.net_amount != null ? Number(row.net_amount) : null,
    chequeNumber: row.cheque_number,
    reason: row.reason,
    createdByUserId: row.created_by_user_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

// ── List — filtered by invoiceId and/or ticketId ────────────────────────────
// Finance-only read (commission/tax breakdowns are sensitive financial data).
router.get("/", requireAuth, requireRole(ROLE_GROUPS.TEAM_FINANCE), async (req: AuthRequest, res) => {
  const { invoiceId, ticketId } = req.query as any;
  const filters: string[] = [];
  const params: any[] = [];
  if (invoiceId) { filters.push("invoice_id = ?"); params.push(invoiceId); }
  if (ticketId) { filters.push("ticket_id = ?"); params.push(ticketId); }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await pgAll(`SELECT * FROM credit_notes ${where} ORDER BY created_at DESC LIMIT 200`, params);
  return ok(res, { data: rows.map(mapCreditNote) });
});

export default router;
