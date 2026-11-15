import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { pgGet, pgAll, pgRun } from "../db.js";

const router = Router();

// ── Configurable vehicle-attribute categories/entries ───────────────────────
// Lives in the MAIN app database (unlike vehicle_specs, which is the isolated
// KRA-CRSP make/model catalog) because usage tracking needs to count against
// live crm_customer_vehicles rows. A category's `code` is the exact value
// stored in crm_customer_vehicles.vehicle_category for vehicles of that kind
// (matching the existing motor_vehicle/motorcycle/tractor/tuktuk/
// special_equipment convention) — the vehicle record itself just stores the
// chosen entry's display name in its `model` column (same "catalog feeds a
// dropdown, consuming record stores plain text" pattern vehicle_specs already
// uses for make/model), so no vehicle-table schema change was needed.
export const initVehicleAttributesSchema = async () => {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS vehicle_attribute_categories (
      id                 TEXT PRIMARY KEY,
      code               TEXT UNIQUE NOT NULL,
      name               TEXT NOT NULL,
      description        TEXT,
      status             TEXT NOT NULL DEFAULT 'Active',
      created_at         TEXT NOT NULL,
      created_by_user_id TEXT,
      created_by_email   TEXT,
      updated_at         TEXT,
      updated_by_user_id TEXT,
      updated_by_email   TEXT
    )
  `);
  await pgRun(`
    CREATE TABLE IF NOT EXISTS vehicle_attribute_entries (
      id                 TEXT PRIMARY KEY,
      category_id        TEXT NOT NULL REFERENCES vehicle_attribute_categories(id),
      name               TEXT NOT NULL,
      normalized_name    TEXT NOT NULL,
      description        TEXT,
      status             TEXT NOT NULL DEFAULT 'Active',
      created_at         TEXT NOT NULL,
      created_by_user_id TEXT,
      created_by_email   TEXT,
      updated_at         TEXT,
      updated_by_user_id TEXT,
      updated_by_email   TEXT
    )
  `);
  await pgRun(`CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_attr_entry_cat_norm ON vehicle_attribute_entries(category_id, normalized_name)`);
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_vehicle_attr_entries_category ON vehicle_attribute_entries(category_id)`);

  const now = new Date().toISOString();
  const SEED: { code: string; name: string; description: string }[] = [
    { code: "fabricated_body", name: "Fabricated Body", description: "Custom-fabricated bodies fitted onto a vehicle chassis (e.g. tanker, tipper, box body)." },
    { code: "trailers", name: "Trailers", description: "Towed trailers with no engine of their own (e.g. flatbed, box, tanker trailer)." },
    { code: "special_cargo", name: "Special Cargo", description: "Specialised cargo-handling configurations (e.g. refrigerated, hazardous, oversized)." },
  ];
  for (const c of SEED) {
    await pgRun(
      `INSERT INTO vehicle_attribute_categories (id, code, name, description, status, created_at)
       VALUES (?, ?, ?, ?, 'Active', ?) ON CONFLICT (code) DO NOTHING`,
      [uuidv4(), c.code, c.name, c.description, now]
    );
  }
  console.log("[vehicle-attributes] Schema ready");
};

// Trim + collapse internal whitespace + lowercase — duplicate/uniqueness
// checks and the DB constraint both key off this, never the raw display name.
const normalize = (s: string) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const MAX_NAME_LEN = 120;

const mapCategory = (r: any) => ({
  id: r.id, code: r.code, name: r.name, description: r.description, status: r.status,
});
const mapEntry = (r: any) => ({
  id: r.id, categoryId: r.category_id, name: r.name, normalizedName: r.normalized_name,
  description: r.description, status: r.status,
  createdAt: r.created_at, createdByEmail: r.created_by_email,
  updatedAt: r.updated_at, updatedByEmail: r.updated_by_email,
  usageCount: r.usage_count != null ? Number(r.usage_count) : undefined,
});

async function getCategory(code: string) {
  return pgGet<any>(`SELECT * FROM vehicle_attribute_categories WHERE code = ?`, [code]);
}

// Vehicles reference an entry by (vehicle_category = category.code, model = entry.name) —
// compared on the same normalized basis entries are deduplicated on, so a
// historical vehicle whose model text differs only in casing/spacing still counts.
async function usageCountFor(categoryCode: string, normalizedName: string): Promise<number> {
  const row = await pgGet<{ n: string }>(
    `SELECT COUNT(*) AS n FROM crm_customer_vehicles
      WHERE deleted_at IS NULL AND vehicle_category = ?
        AND REPLACE(LOWER(TRIM(model)), '  ', ' ') = ?`,
    [categoryCode, normalizedName]
  );
  return Number(row?.n || 0);
}

// ── Categories ────────────────────────────────────────────────────────────
router.get("/categories", requireAuth, async (_req, res) => {
  const rows = await pgAll(`SELECT * FROM vehicle_attribute_categories WHERE status = 'Active' ORDER BY name`);
  return ok(res, { data: rows.map(mapCategory) });
});

// ── Entries — read (any authenticated user; feeds registration-form dropdowns) ──
router.get("/categories/:code/entries", requireAuth, async (req, res) => {
  const category = await getCategory(req.params.code);
  if (!category) return errorResponse(res, 404, "NOT_FOUND", "Unknown vehicle attribute category.");
  const search = String(req.query.search || "").trim();
  const clauses = [`category_id = ?`, `status = 'Active'`];
  const params: any[] = [category.id];
  if (search) { clauses.push(`name ILIKE ?`); params.push(`%${search}%`); }
  const rows = await pgAll(`SELECT * FROM vehicle_attribute_entries WHERE ${clauses.join(" AND ")} ORDER BY name LIMIT 200`, params);
  return ok(res, { data: rows.map(mapEntry) });
});

// ── Entries — admin listing (incl. inactive + usage counts + audit fields) ──
router.get("/categories/:code/entries/admin", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req, res) => {
  const category = await getCategory(req.params.code);
  if (!category) return errorResponse(res, 404, "NOT_FOUND", "Unknown vehicle attribute category.");
  const search = String(req.query.search || "").trim();
  const clauses = [`category_id = ?`];
  const params: any[] = [category.id];
  if (search) { clauses.push(`name ILIKE ?`); params.push(`%${search}%`); }
  const rows = await pgAll(`SELECT * FROM vehicle_attribute_entries WHERE ${clauses.join(" AND ")} ORDER BY status, name`, params);
  const withUsage = await Promise.all(rows.map(async (r: any) => ({ ...r, usage_count: await usageCountFor(category.code, r.normalized_name) })));
  return ok(res, { data: withUsage.map(mapEntry), category: mapCategory(category) });
});

// ── Entries — create (any authenticated user: registering a vehicle is the
//    normal path to needing a brand-new entry; duplicate-protected + audited) ──
router.post("/categories/:code/entries", requireAuth, async (req: AuthRequest, res) => {
  const category = await getCategory(req.params.code);
  if (!category) return errorResponse(res, 404, "NOT_FOUND", "Unknown vehicle attribute category.");
  if (category.status !== "Active") return errorResponse(res, 422, "VALIDATION_ERROR", "This category is not active.");

  const raw = String(req.body?.name || "");
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return errorResponse(res, 400, "VALIDATION_ERROR", "Entry name is required.");
  if (name.length > MAX_NAME_LEN) return errorResponse(res, 400, "VALIDATION_ERROR", `Entry name must be ${MAX_NAME_LEN} characters or fewer.`);
  const normalizedName = normalize(name);

  const existing = await pgGet<any>(
    `SELECT * FROM vehicle_attribute_entries WHERE category_id = ? AND normalized_name = ?`,
    [category.id, normalizedName]
  );
  if (existing) {
    return errorResponse(res, 409, "DUPLICATE_ENTRY", `"${existing.name}" already exists under ${category.name}.`, { existingEntry: mapEntry(existing) });
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  try {
    await pgRun(
      `INSERT INTO vehicle_attribute_entries (id, category_id, name, normalized_name, description, status, created_at, created_by_user_id, created_by_email)
       VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
      [id, category.id, name, normalizedName, req.body?.description || null, now, req.user?.id || null, req.user?.email || null]
    );
  } catch (error: any) {
    // DB-level unique constraint as a second line of defence against a race
    // between the pre-check above and this insert.
    if (error?.code === "23505") {
      const race = await pgGet<any>(`SELECT * FROM vehicle_attribute_entries WHERE category_id = ? AND normalized_name = ?`, [category.id, normalizedName]);
      return errorResponse(res, 409, "DUPLICATE_ENTRY", `"${race?.name || name}" already exists under ${category.name}.`, { existingEntry: race ? mapEntry(race) : undefined });
    }
    throw error;
  }

  const row = await pgGet<any>(`SELECT * FROM vehicle_attribute_entries WHERE id = ?`, [id]);
  auditLog(req, "VEHICLE_ATTRIBUTE_ENTRY_CREATED", `vehicle_attribute_entry:${id}`, "Info", { category: category.code, name }).catch(console.error);
  return created(res, mapEntry(row), "Entry created.");
});

// ── Entries — edit name/description (Admin/InventoryManager only) ──────────
router.patch("/entries/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const entry = await pgGet<any>(`SELECT * FROM vehicle_attribute_entries WHERE id = ?`, [req.params.id]);
  if (!entry) return errorResponse(res, 404, "NOT_FOUND", "Entry not found.");
  const category = await pgGet<any>(`SELECT * FROM vehicle_attribute_categories WHERE id = ?`, [entry.category_id]);

  const sets: string[] = [];
  const vals: any[] = [];
  let newNormalized = entry.normalized_name;
  let newName = entry.name;
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().replace(/\s+/g, " ");
    if (!name) return errorResponse(res, 400, "VALIDATION_ERROR", "Entry name cannot be blank.");
    if (name.length > MAX_NAME_LEN) return errorResponse(res, 400, "VALIDATION_ERROR", `Entry name must be ${MAX_NAME_LEN} characters or fewer.`);
    newNormalized = normalize(name);
    newName = name;
    if (newNormalized !== entry.normalized_name) {
      const dup = await pgGet<any>(`SELECT id, name FROM vehicle_attribute_entries WHERE category_id = ? AND normalized_name = ? AND id <> ?`, [entry.category_id, newNormalized, entry.id]);
      if (dup) return errorResponse(res, 409, "DUPLICATE_ENTRY", `"${dup.name}" already exists under ${category?.name || "this category"}.`, { existingEntry: mapEntry(dup) });
    }
    sets.push("name = ?", "normalized_name = ?"); vals.push(name, newNormalized);
  }
  if (req.body?.description !== undefined) { sets.push("description = ?"); vals.push(req.body.description || null); }
  if (!sets.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No fields to update.");
  const now = new Date().toISOString();
  sets.push("updated_at = ?", "updated_by_user_id = ?", "updated_by_email = ?");
  vals.push(now, req.user?.id || null, req.user?.email || null, req.params.id);

  await pgRun(`UPDATE vehicle_attribute_entries SET ${sets.join(", ")} WHERE id = ?`, vals);
  auditLog(req, "VEHICLE_ATTRIBUTE_ENTRY_UPDATED", `vehicle_attribute_entry:${req.params.id}`, "Info", { previous: entry.name, new: newName }).catch(console.error);
  const row = await pgGet<any>(`SELECT * FROM vehicle_attribute_entries WHERE id = ?`, [req.params.id]);
  return ok(res, mapEntry(row), "Entry updated.");
});

// ── Entries — usage count (drives the deactivate confirmation dialog) ──────
router.get("/entries/:id/usage", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req, res) => {
  const entry = await pgGet<any>(`SELECT * FROM vehicle_attribute_entries WHERE id = ?`, [req.params.id]);
  if (!entry) return errorResponse(res, 404, "NOT_FOUND", "Entry not found.");
  const category = await pgGet<any>(`SELECT * FROM vehicle_attribute_categories WHERE id = ?`, [entry.category_id]);
  const count = await usageCountFor(category.code, entry.normalized_name);
  return ok(res, { data: { entryId: entry.id, name: entry.name, usageCount: count } });
});

// ── Entries — activate/deactivate (never delete; historical vehicles keep
//    showing whatever they already reference) ───────────────────────────────
router.patch("/entries/:id/status", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const entry = await pgGet<any>(`SELECT * FROM vehicle_attribute_entries WHERE id = ?`, [req.params.id]);
  if (!entry) return errorResponse(res, 404, "NOT_FOUND", "Entry not found.");
  const status = req.body?.status;
  if (!["Active", "Inactive"].includes(status)) return errorResponse(res, 400, "VALIDATION_ERROR", "status must be Active or Inactive.");
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE vehicle_attribute_entries SET status = ?, updated_at = ?, updated_by_user_id = ?, updated_by_email = ? WHERE id = ?`,
    [status, now, req.user?.id || null, req.user?.email || null, req.params.id]
  );
  auditLog(req, status === "Active" ? "VEHICLE_ATTRIBUTE_ENTRY_REACTIVATED" : "VEHICLE_ATTRIBUTE_ENTRY_DEACTIVATED",
    `vehicle_attribute_entry:${req.params.id}`, "Info", { name: entry.name, reason: req.body?.reason || undefined }).catch(console.error);
  const row = await pgGet<any>(`SELECT * FROM vehicle_attribute_entries WHERE id = ?`, [req.params.id]);
  return ok(res, mapEntry(row), `Entry ${status === "Active" ? "reactivated" : "deactivated"}.`);
});

export default router;
