import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

const router = Router();

// ── Table bootstrap ──────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS partner_product_pricing (
    id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    loan_term_months INTEGER NOT NULL,
    device_price REAL NOT NULL DEFAULT 0,
    installation_fee REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(partner_id, product_id, loan_term_months)
  )
`, []).catch(e => console.error("[partner_product_pricing] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_ppp_partner ON partner_product_pricing(partner_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_ppp_product ON partner_product_pricing(product_id)`, []).catch(() => {});

function mapPricing(r: any) {
  return {
    id: r.id,
    partnerId: r.partner_id,
    partnerName: r.partner_name || null,
    productId: r.product_id,
    productName: r.product_name || null,
    productCode: r.product_code || null,
    loanTermMonths: r.loan_term_months,
    devicePrice: r.device_price,
    installationFee: r.installation_fee,
    notes: r.notes || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── GET /lookup ───────────────────────────────────────────────────────────────
// Returns a single pricing entry for a given partner + product + loan term.
// Returns { data: null } if no entry is found (not a 404, so the caller can decide).
router.get("/lookup", requireAuth, async (req: AuthRequest, res) => {
  const { partnerId, productId, loanTermMonths } = req.query as any;
  if (!partnerId || !productId || !loanTermMonths) {
    return errorResponse(res, 400, "MISSING_FIELD", "partnerId, productId and loanTermMonths are required.");
  }
  const row = await pgGet(
    `SELECT pp.*, p.name AS partner_name, pc.product_name, pc.product_code
     FROM partner_product_pricing pp
     LEFT JOIN partners p ON p.id::text = pp.partner_id::text
     LEFT JOIN inv_product_catalog pc ON pc.id::text = pp.product_id::text
     WHERE pp.partner_id::text = ? AND pp.product_id::text = ? AND pp.loan_term_months = ?`,
    [String(partnerId), String(productId), parseInt(loanTermMonths, 10)]
  );
  return ok(res, { data: row ? mapPricing(row) : null });
});

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Admin","InventoryManager","Finance","BDM", "BDMCorporate","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const { partnerId, productId, page = "1", pageSize = "100" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 100, 500);
  const offset = (pageNum - 1) * sizeNum;

  const filters: string[] = [];
  const params: any[] = [];

  if (partnerId) { filters.push("pp.partner_id::text = ?"); params.push(String(partnerId)); }
  if (productId) { filters.push("pp.product_id::text = ?"); params.push(String(productId)); }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = await pgAll(
    `SELECT pp.*, p.name AS partner_name, pc.product_name, pc.product_code
     FROM partner_product_pricing pp
     LEFT JOIN partners p ON p.id::text = pp.partner_id::text
     LEFT JOIN inv_product_catalog pc ON pc.id::text = pp.product_id::text
     ${where}
     ORDER BY p.name, pc.product_name, pp.loan_term_months
     LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(
    `SELECT COUNT(*) as total FROM partner_product_pricing pp ${where}`,
    params
  );
  return ok(res, { data: rows.map(mapPricing), meta: { total: Number(totalRow?.total ?? 0) } });
});

// ── POST / ────────────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const { partnerId, productId, loanTermMonths, devicePrice, installationFee, notes } = req.body;
  if (!partnerId || !productId || loanTermMonths == null || devicePrice == null || installationFee == null) {
    return errorResponse(res, 400, "MISSING_FIELD", "partnerId, productId, loanTermMonths, devicePrice and installationFee are required.");
  }

  const partner = await pgGet(`SELECT id FROM partners WHERE id = ?::uuid AND deleted_at IS NULL`, [String(partnerId)]);
  if (!partner) return errorResponse(res, 404, "NOT_FOUND", "Partner not found.");

  const product = await pgGet(`SELECT id FROM inv_product_catalog WHERE id = ? AND deleted_at IS NULL`, [String(productId)]);
  if (!product) return errorResponse(res, 404, "NOT_FOUND", "Product not found.");

  const now = new Date().toISOString();
  const id = uuidv4();

  try {
    await pgRun(
      `INSERT INTO partner_product_pricing
         (id, partner_id, product_id, loan_term_months, device_price, installation_fee, notes, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, String(partnerId), String(productId), parseInt(loanTermMonths, 10), Number(devicePrice), Number(installationFee), notes || null, req.user!.id, now, now]
    );
  } catch (e: any) {
    if (e.message?.includes("UNIQUE") || e.message?.includes("unique")) {
      return errorResponse(res, 409, "DUPLICATE", "A pricing entry already exists for this partner / product / loan term combination.");
    }
    throw e;
  }

  const row = await pgGet(
    `SELECT pp.*, p.name AS partner_name, pc.product_name, pc.product_code
     FROM partner_product_pricing pp
     LEFT JOIN partners p ON p.id::text = pp.partner_id::text
     LEFT JOIN inv_product_catalog pc ON pc.id::text = pp.product_id::text
     WHERE pp.id = ?`,
    [id]
  );
  auditLog(req, "PARTNER_PRICING_CREATED", "partner_product_pricing", "Info", { partnerId, productId, loanTermMonths }).catch(console.error);
  return created(res, { data: mapPricing(row!) }, "Pricing entry created.");
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────
router.patch("/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT * FROM partner_product_pricing WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Pricing entry not found.");

  const { devicePrice, installationFee, loanTermMonths, notes } = req.body;
  const now = new Date().toISOString();

  try {
    await pgRun(
      `UPDATE partner_product_pricing
       SET device_price = ?, installation_fee = ?, loan_term_months = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      [
        devicePrice !== undefined ? Number(devicePrice) : row.device_price,
        installationFee !== undefined ? Number(installationFee) : row.installation_fee,
        loanTermMonths !== undefined ? parseInt(loanTermMonths, 10) : row.loan_term_months,
        notes !== undefined ? (notes || null) : row.notes,
        now,
        req.params.id,
      ]
    );
  } catch (e: any) {
    if (e.message?.includes("UNIQUE") || e.message?.includes("unique")) {
      return errorResponse(res, 409, "DUPLICATE", "A pricing entry already exists for this partner / product / loan term combination.");
    }
    throw e;
  }

  const updated = await pgGet(
    `SELECT pp.*, p.name AS partner_name, pc.product_name, pc.product_code
     FROM partner_product_pricing pp
     LEFT JOIN partners p ON p.id::text = pp.partner_id::text
     LEFT JOIN inv_product_catalog pc ON pc.id::text = pp.product_id::text
     WHERE pp.id = ?`,
    [req.params.id]
  );
  return ok(res, { data: mapPricing(updated!) });
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT id FROM partner_product_pricing WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Pricing entry not found.");
  await pgRun(`DELETE FROM partner_product_pricing WHERE id = ?`, [req.params.id]);
  auditLog(req, "PARTNER_PRICING_DELETED", "partner_product_pricing", "Info", { id: req.params.id }).catch(console.error);
  return ok(res, { message: "Pricing entry deleted." });
});

export default router;
