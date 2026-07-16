import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

const router = Router();

// One row per bank/partner — reference pricing for a bank-financed tracking
// installation, by loan term in years (1-6). Distinct from
// partner_product_pricing (which prices by partner+product+loan-term-months
// for the device-assignment auto-quote) — this table prices the tracking
// installation itself against the bank footing the loan, independent of
// which specific device gets installed.
pgRun(`
  CREATE TABLE IF NOT EXISTS bank_financed_pricing (
    id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL UNIQUE,
    bank_address TEXT,
    year_1 REAL, year_2 REAL, year_3 REAL, year_4 REAL, year_5 REAL, year_6 REAL,
    notes TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch((e) => console.error("[bank_financed_pricing] init:", e));

function mapRow(r: any) {
  return {
    id: r.id,
    partnerId: r.partner_id,
    partnerName: r.partner_name || null,
    bankAddress: r.bank_address || null,
    years: [r.year_1, r.year_2, r.year_3, r.year_4, r.year_5, r.year_6].map((v) => (v == null ? null : Number(v))),
    notes: r.notes || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_JOIN = `
  SELECT bfp.*, p.name AS partner_name
  FROM bank_financed_pricing bfp
  LEFT JOIN partners p ON p.id::text = bfp.partner_id::text
`;

// ── GET /lookup — price for a given partner + loan term in years ────────────
// Returns { data: null } (not 404) when no row/year price exists, so the
// caller (auto-quote automation) can decide what to do without try/catch.
router.get("/lookup", requireAuth, async (req: AuthRequest, res) => {
  const { partnerId, years } = req.query as any;
  const yearsNum = parseInt(years, 10);
  if (!partnerId || !yearsNum || yearsNum < 1 || yearsNum > 6) {
    return errorResponse(res, 400, "MISSING_FIELD", "partnerId and years (1-6) are required.");
  }
  const row = await pgGet(`${SELECT_JOIN} WHERE bfp.partner_id::text = ?`, [String(partnerId)]);
  if (!row) return ok(res, { data: null });
  const mapped = mapRow(row);
  const price = mapped.years[yearsNum - 1];
  return ok(res, { data: price == null ? null : { ...mapped, price, years: yearsNum } });
});

// ── GET / — list all bank pricing rows ───────────────────────────────────────
router.get("/", requireAuth, requireRole(["Admin", "InventoryManager", "Finance", "BDM", "BDMCorporate", "Sales", "Telesales", "FieldSales", "CorporateSales"]), async (_req: AuthRequest, res) => {
  const rows = await pgAll(`${SELECT_JOIN} ORDER BY p.name`);
  return ok(res, { data: rows.map(mapRow) });
});

// ── POST / — add a bank ───────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const { partnerId, bankAddress, years, notes } = req.body || {};
  if (!partnerId) return errorResponse(res, 400, "MISSING_FIELD", "partnerId is required.");
  if (!Array.isArray(years) || years.length !== 6) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "years must be an array of exactly 6 values (use null for unset years).");
  }

  const partner = await pgGet(`SELECT id FROM partners WHERE id = ?::uuid AND deleted_at IS NULL`, [String(partnerId)]);
  if (!partner) return errorResponse(res, 404, "NOT_FOUND", "Partner not found.");

  const now = new Date().toISOString();
  const id = uuidv4();
  try {
    await pgRun(
      `INSERT INTO bank_financed_pricing
         (id, partner_id, bank_address, year_1, year_2, year_3, year_4, year_5, year_6, notes, created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, String(partnerId), bankAddress || null,
       ...years.map((y: any) => (y === null || y === "" ? null : Number(y))),
       notes || null, req.user!.id, now, now]
    );
  } catch (e: any) {
    if (e.message?.toLowerCase().includes("unique")) {
      return errorResponse(res, 409, "DUPLICATE", "This partner already has bank-financed pricing configured.");
    }
    throw e;
  }

  const row = await pgGet(`${SELECT_JOIN} WHERE bfp.id = ?`, [id]);
  auditLog(req, "BANK_FINANCED_PRICING_CREATED", "bank_financed_pricing", "Info", { partnerId }).catch(console.error);
  return created(res, { data: mapRow(row!) }, "Bank pricing added.");
});

// ── PATCH /:id — edit a bank's pricing/address ───────────────────────────────
router.patch("/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT * FROM bank_financed_pricing WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Bank pricing entry not found.");

  const { bankAddress, years, notes } = req.body || {};
  const now = new Date().toISOString();

  const yearVals = Array.isArray(years) && years.length === 6
    ? years.map((y: any) => (y === null || y === "" ? null : Number(y)))
    : [row.year_1, row.year_2, row.year_3, row.year_4, row.year_5, row.year_6];

  await pgRun(
    `UPDATE bank_financed_pricing
     SET bank_address = ?, year_1 = ?, year_2 = ?, year_3 = ?, year_4 = ?, year_5 = ?, year_6 = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
    [bankAddress !== undefined ? (bankAddress || null) : row.bank_address,
     ...yearVals,
     notes !== undefined ? (notes || null) : row.notes,
     now, req.params.id]
  );

  const updated = await pgGet(`${SELECT_JOIN} WHERE bfp.id = ?`, [req.params.id]);
  auditLog(req, "BANK_FINANCED_PRICING_UPDATED", "bank_financed_pricing", "Info", { id: req.params.id }).catch(console.error);
  return ok(res, { data: mapRow(updated!) });
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT id FROM bank_financed_pricing WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Bank pricing entry not found.");
  await pgRun(`DELETE FROM bank_financed_pricing WHERE id = ?`, [req.params.id]);
  auditLog(req, "BANK_FINANCED_PRICING_DELETED", "bank_financed_pricing", "Info", { id: req.params.id }).catch(console.error);
  return ok(res, { message: "Bank pricing entry deleted." });
});

export default router;
