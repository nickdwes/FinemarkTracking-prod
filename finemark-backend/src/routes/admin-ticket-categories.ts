import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

const router = Router();

// Configurable support-ticket categories (crm-tickets.ts) — each maps to one
// of three resolving teams. The category dropdown on ticket creation, the
// team-routing decision, and the "requires a customer" toggle (Internal
// Ticket / Internal Billing skip the customer/vehicle section entirely) are
// all driven from this table instead of a hardcoded list.
pgRun(`
  CREATE TABLE IF NOT EXISTS ticket_categories (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    team TEXT NOT NULL CHECK (team IN ('Technical','Finance','Support')),
    requires_customer BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch((e) => console.error("[ticket_categories] init:", e));

// Idempotent seed — confirmed category list + team routing.
setTimeout(async () => {
  const now = new Date().toISOString();
  const seed: Array<{ name: string; team: string; requiresCustomer: boolean; sortOrder: number }> = [
    { name: "Technical Issue", team: "Technical", requiresCustomer: true, sortOrder: 1 },
    { name: "Gadget Issue",    team: "Technical", requiresCustomer: true, sortOrder: 2 },
    { name: "SIM Card Issue",  team: "Technical", requiresCustomer: true, sortOrder: 3 },
    { name: "Installation",    team: "Technical", requiresCustomer: true, sortOrder: 4 },
    { name: "Billing Issue",   team: "Finance",   requiresCustomer: true, sortOrder: 5 },
    { name: "Internal Billing",team: "Finance",   requiresCustomer: false, sortOrder: 6 },
    { name: "Internal Ticket", team: "Support",   requiresCustomer: false, sortOrder: 7 },
    { name: "General",         team: "Support",   requiresCustomer: true, sortOrder: 8 },
    { name: "Uninstallation",  team: "Technical", requiresCustomer: true, sortOrder: 9 },
  ];
  for (const c of seed) {
    await pgRun(
      `INSERT INTO ticket_categories (id, name, team, requires_customer, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (name) DO NOTHING`,
      [uuidv4(), c.name, c.team, c.requiresCustomer, c.sortOrder, now, now]
    ).catch((e) => console.error("[ticket_categories] seed:", e));
  }
}, 1500);

function mapRow(r: any) {
  return {
    id: r.id,
    name: r.name,
    team: r.team,
    requiresCustomer: !!r.requires_customer,
    isActive: !!r.is_active,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── GET / — every authenticated role reads this to populate the ────────────
// create-ticket category dropdown; only Admin can list inactive rows too.
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const includeInactive = req.query.includeInactive === "true" && req.user!.role === "Admin";
  const rows = await pgAll(
    `SELECT * FROM ticket_categories ${includeInactive ? "" : "WHERE is_active = TRUE"} ORDER BY sort_order, name`,
    []
  );
  return ok(res, { data: rows.map(mapRow) });
});

// ── POST / — add a category ─────────────────────────────────────────────────
router.post("/", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const { name, team, requiresCustomer, sortOrder } = req.body || {};
  if (!name?.trim()) return errorResponse(res, 400, "MISSING_FIELD", "name is required.");
  if (!["Technical", "Finance", "Support"].includes(team)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "team must be Technical, Finance, or Support.");
  }

  const now = new Date().toISOString();
  const id = uuidv4();
  try {
    await pgRun(
      `INSERT INTO ticket_categories (id, name, team, requires_customer, sort_order, created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, name.trim(), team, requiresCustomer !== false, Number(sortOrder) || 0, req.user!.id, now, now]
    );
  } catch (e: any) {
    if (e.message?.toLowerCase().includes("unique")) {
      return errorResponse(res, 409, "DUPLICATE", "A category with this name already exists.");
    }
    throw e;
  }

  const row = await pgGet(`SELECT * FROM ticket_categories WHERE id = ?`, [id]);
  auditLog(req, "TICKET_CATEGORY_CREATED", `ticket_category:${id}`, "Info", { name, team }).catch(console.error);
  return created(res, { data: mapRow(row!) }, "Category added.");
});

// ── PATCH /:id — edit name/team/requiresCustomer/active/sortOrder ──────────
router.patch("/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT * FROM ticket_categories WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Category not found.");

  const { name, team, requiresCustomer, isActive, sortOrder } = req.body || {};
  if (team !== undefined && !["Technical", "Finance", "Support"].includes(team)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "team must be Technical, Finance, or Support.");
  }

  const now = new Date().toISOString();
  await pgRun(
    `UPDATE ticket_categories
     SET name = ?, team = ?, requires_customer = ?, is_active = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`,
    [
      name !== undefined ? name.trim() : row.name,
      team !== undefined ? team : row.team,
      requiresCustomer !== undefined ? !!requiresCustomer : row.requires_customer,
      isActive !== undefined ? !!isActive : row.is_active,
      sortOrder !== undefined ? Number(sortOrder) || 0 : row.sort_order,
      now, req.params.id,
    ]
  );

  const updated = await pgGet(`SELECT * FROM ticket_categories WHERE id = ?`, [req.params.id]);
  auditLog(req, "TICKET_CATEGORY_UPDATED", `ticket_category:${req.params.id}`, "Info", { fields: Object.keys(req.body || {}) }).catch(console.error);
  return ok(res, { data: mapRow(updated!) });
});

// ── DELETE /:id — soft deactivate, never a hard delete ──────────────────────
// Existing tickets reference a category by its name string, not an FK — a
// hard delete would silently orphan the label on every ticket that used it.
router.delete("/:id", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT id FROM ticket_categories WHERE id = ?`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Category not found.");
  await pgRun(`UPDATE ticket_categories SET is_active = FALSE, updated_at = ? WHERE id = ?`, [new Date().toISOString(), req.params.id]);
  auditLog(req, "TICKET_CATEGORY_DEACTIVATED", `ticket_category:${req.params.id}`, "Info", {}).catch(console.error);
  return ok(res, { message: "Category deactivated." });
});

export default router;
