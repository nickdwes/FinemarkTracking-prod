import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { vehicleGet, vehicleAll, vehicleRun } from "../vehicleDb.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { ADAPTERS } from "../services/vehicleAdapters/index.js";
import { runSync, upsertVehicleSpec } from "../services/vehicleSyncService.js";
import { buildCrspExport } from "../services/vehicleCrspExportService.js";

const router = Router();

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

const VEHICLE_CATEGORIES = ["motor_vehicle", "motorcycle", "tractor", "tuktuk", "special_equipment"] as const;

const mapSpec = (r: any) => ({
  id: r.id, make: r.make, model: r.model, trim: r.trim,
  modelYear: r.model_year, bodyStyle: r.body_style,
  engineType: r.engine_type, engineSizeCc: r.engine_size_cc, engineSizeL: r.engine_size_l,
  fuelType: r.fuel_type, transmission: r.transmission, drivetrain: r.drivetrain,
  wmi: r.wmi, vinPattern: r.vin_pattern,
  productionStartDate: r.production_start_date, productionEndDate: r.production_end_date,
  source: r.source, sourceRef: r.source_ref, status: r.status, vehicleCategory: r.vehicle_category,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const mapSyncRun = (r: any) => ({
  id: r.id, source: r.source, triggerType: r.trigger_type, triggeredBy: r.triggered_by,
  startedAt: r.started_at, finishedAt: r.finished_at, status: r.status,
  rowsFetched: r.rows_fetched, rowsInserted: r.rows_inserted, rowsUpdated: r.rows_updated,
  rowsFailed: r.rows_failed, errorSummary: r.error_summary, notes: r.notes,
});

// Shared WHERE-clause builder for /specs listing and filter-driven bulk actions —
// keeps "select all N matching rows" acting on exactly the same set the table shows.
const buildSpecsWhere = (query: { search?: string; make?: string; source?: string; status?: string; category?: string }) => {
  const { search, make, source, status, category } = query;
  const where: string[] = [];
  const params: any[] = [];
  if (search) {
    where.push(`(make ILIKE ? OR model ILIKE ? OR trim ILIKE ? OR source_ref ILIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (make) { where.push(`make = ?`); params.push(make); }
  if (source) { where.push(`source = ?`); params.push(source); }
  if (status) { where.push(`status = ?`); params.push(status); }
  if (category) { where.push(`vehicle_category = ?`); params.push(category); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params };
};

// ── Live catalog (any authenticated user — read-only) ────────────────────────
// Backs the make/model/model-number pickers used app-wide when creating a
// lead, registering a vehicle, working a job card, or generating a
// certificate. Unlike everything else in this file, these three routes are
// intentionally NOT gated to INVENTORY_FULL — Sales/Telesales/FieldSales/
// Technical/Technician all need to read this to fill in a form. Only
// "approved" rows from KRA CRSP or a manual entry are ever shown — the same
// filter buildCrspExport() already uses for the static-file export, so a
// pending/rejected/foreign-market (NHTSA) row can never leak into a picker.
const CATALOG_SOURCE_FILTER = `status = 'approved' AND source IN ('kra_crsp', 'manual_csv')`;

// category is optional on all three catalog routes below — omitted means
// "every category combined" (motor vehicles, motorcycles, tractors, tuktuks,
// special equipment all mixed into one list, same as how cars and trucks are
// already mixed together with no distinction today), so none of the 6 pages
// already reading from these endpoints need to change to start seeing the
// newly-added machinery. Pass ?category= to narrow to just one.
router.get("/catalog/makes", requireAuth, async (req, res) => {
  const category = String(req.query.category || "").trim();
  if (category && !VEHICLE_CATEGORIES.includes(category as any)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", `category must be one of: ${VEHICLE_CATEGORIES.join(", ")}.`);
  }
  const rows = await vehicleAll<{ make: string }>(
    `SELECT DISTINCT make FROM vehicle_specs WHERE ${CATALOG_SOURCE_FILTER} ${category ? "AND vehicle_category = ?" : ""} ORDER BY make`,
    category ? [category] : []
  );
  return ok(res, { data: rows.map((r) => r.make) });
});

router.get("/catalog/models", requireAuth, async (req, res) => {
  const make = String(req.query.make || "").trim();
  if (!make) return errorResponse(res, 400, "VALIDATION_ERROR", "make is required.");
  const category = String(req.query.category || "").trim();
  if (category && !VEHICLE_CATEGORIES.includes(category as any)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", `category must be one of: ${VEHICLE_CATEGORIES.join(", ")}.`);
  }
  const rows = await vehicleAll<{ model: string; body_style: string | null }>(
    `SELECT DISTINCT ON (model) model, body_style
     FROM vehicle_specs WHERE ${CATALOG_SOURCE_FILTER} AND make = ? ${category ? "AND vehicle_category = ?" : ""}
     ORDER BY model, body_style NULLS LAST`,
    category ? [make, category] : [make]
  );
  return ok(res, { data: rows.map((r) => ({ model: r.model, bodyStyle: r.body_style })) });
});

router.get("/catalog/model-numbers", requireAuth, async (req, res) => {
  const make = String(req.query.make || "").trim();
  const model = String(req.query.model || "").trim();
  if (!make || !model) return errorResponse(res, 400, "VALIDATION_ERROR", "make and model are required.");
  const category = String(req.query.category || "").trim();
  if (category && !VEHICLE_CATEGORIES.includes(category as any)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", `category must be one of: ${VEHICLE_CATEGORIES.join(", ")}.`);
  }
  const rows = await vehicleAll<{ source_ref: string; body_style: string | null }>(
    `SELECT DISTINCT source_ref, body_style
     FROM vehicle_specs WHERE ${CATALOG_SOURCE_FILTER} AND make = ? AND model = ? ${category ? "AND vehicle_category = ?" : ""}
     ORDER BY source_ref`,
    category ? [make, model, category] : [make, model]
  );
  return ok(res, { data: rows.map((r) => ({ modelNumber: r.source_ref, bodyStyle: r.body_style })) });
});

// ── Vehicle specs ────────────────────────────────────────────────────────────
router.get("/specs", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req, res) => {
  const { search, make, source, status, category } = req.query as Record<string, string>;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Number(req.query.pageSize) || 25);
  const offset = (page - 1) * pageSize;

  const { whereSql, params } = buildSpecsWhere({ search, make, source, status, category });

  const rows = await vehicleAll(
    `SELECT * FROM vehicle_specs ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const totalRow = await vehicleGet<{ total: string }>(`SELECT COUNT(*) as total FROM vehicle_specs ${whereSql}`, params);

  return ok(res, { data: rows.map(mapSpec), meta: { total: Number(totalRow?.total || 0), page, pageSize } });
});

router.get("/specs/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req, res) => {
  const spec = await vehicleGet(`SELECT * FROM vehicle_specs WHERE id = ?`, [req.params.id]);
  if (!spec) return errorResponse(res, 404, "NOT_FOUND", "Vehicle spec not found.");
  const colors = await vehicleAll(`SELECT color_name, color_code FROM vehicle_spec_colors WHERE vehicle_spec_id = ?`, [req.params.id]);
  return ok(res, { ...mapSpec(spec), colors: colors.map((c: any) => ({ name: c.color_name, code: c.color_code })) });
});

// Single manual add — the "type in one make/model" counterpart to the
// bulk CSV import above. Auto-approved immediately: a human with
// Admin/InventoryManager access typed this in directly, so there's no
// separate self-review step to gate it behind.
router.post("/specs", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const { make, model, trim, modelYear, bodyStyle, engineType, engineSizeCc, fuelType, transmission, drivetrain, modelNumber, vehicleCategory } = req.body || {};
  if (!make?.trim() || !model?.trim()) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "make and model are required.");
  }
  if (vehicleCategory && !VEHICLE_CATEGORIES.includes(vehicleCategory)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", `vehicleCategory must be one of: ${VEHICLE_CATEGORIES.join(", ")}.`);
  }
  const sourceRef = (modelNumber && String(modelNumber).trim()) || slugify(`${make}-${model}-${trim || ""}-${modelYear || ""}`);

  const result = await upsertVehicleSpec(
    {
      make: make.trim(), model: model.trim(), trim: trim?.trim() || null,
      modelYear: modelYear ? Number(modelYear) : null,
      bodyStyle: bodyStyle?.trim() || null,
      engineType: engineType?.trim() || null,
      engineSizeCc: engineSizeCc ? Number(engineSizeCc) : null,
      fuelType: fuelType?.trim() || null,
      transmission: transmission?.trim() || null,
      drivetrain: drivetrain?.trim() || null,
      vehicleCategory: vehicleCategory?.trim() || "motor_vehicle",
      sourceRef,
    },
    "manual_csv"
  );
  if (result === "skipped") {
    return errorResponse(res, 409, "CONFLICT", "A vehicle spec with this make/model/trim/year (or model number) already exists.");
  }

  const now = new Date().toISOString();
  await vehicleRun(`UPDATE vehicle_specs SET status = 'approved', updated_at = ? WHERE source = 'manual_csv' AND source_ref = ?`, [now, sourceRef]);

  const spec = await vehicleGet(`SELECT * FROM vehicle_specs WHERE source = 'manual_csv' AND source_ref = ?`, [sourceRef]);
  auditLog(req, "VEHICLE_SPEC_CREATED", `vehicle_spec:${spec.id}`, "Info", { make, model, sourceRef }).catch(console.error);
  return created(res, mapSpec(spec), "Vehicle spec added.");
});

router.patch("/specs/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const spec = await vehicleGet(`SELECT id FROM vehicle_specs WHERE id = ?`, [req.params.id]);
  if (!spec) return errorResponse(res, 404, "NOT_FOUND", "Vehicle spec not found.");

  const { status, ...fields } = req.body || {};
  if (status && !["pending_review", "approved", "rejected"].includes(status)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "status must be pending_review, approved, or rejected.");
  }
  if (fields.vehicleCategory && !VEHICLE_CATEGORIES.includes(fields.vehicleCategory)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", `vehicleCategory must be one of: ${VEHICLE_CATEGORIES.join(", ")}.`);
  }

  const colMap: Record<string, string> = {
    make: "make", model: "model", trim: "trim", modelYear: "model_year", bodyStyle: "body_style",
    engineType: "engine_type", engineSizeCc: "engine_size_cc", engineSizeL: "engine_size_l",
    fuelType: "fuel_type", transmission: "transmission", drivetrain: "drivetrain",
    wmi: "wmi", vinPattern: "vin_pattern",
    productionStartDate: "production_start_date", productionEndDate: "production_end_date",
    vehicleCategory: "vehicle_category",
  };
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [key, col] of Object.entries(colMap)) {
    if (fields[key] !== undefined) { sets.push(`${col} = ?`); vals.push(fields[key] || null); }
  }
  if (status) { sets.push(`status = ?`); vals.push(status); }
  if (!sets.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No fields to update.");
  sets.push(`updated_at = ?`); vals.push(new Date().toISOString());
  vals.push(req.params.id);

  await vehicleRun(`UPDATE vehicle_specs SET ${sets.join(", ")} WHERE id = ?`, vals);
  auditLog(req, "VEHICLE_SPEC_UPDATED", `vehicle_spec:${req.params.id}`, "Info", { status }).catch(console.error);

  const updated = await vehicleGet(`SELECT * FROM vehicle_specs WHERE id = ?`, [req.params.id]);
  return ok(res, mapSpec(updated), "Vehicle spec updated.");
});

router.post("/specs/bulk-approve", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const { ids, filter } = req.body as { ids?: string[]; filter?: { search?: string; make?: string; source?: string; status?: string; category?: string } };
  const now = new Date().toISOString();
  let updated = 0;

  if (filter && typeof filter === "object") {
    // "Select all N matching rows" path — approves every row matching the
    // table's current filter, not just the page the client has loaded. An
    // empty filter would match the whole table (including already-rejected
    // rows from other sources), so require at least one real constraint.
    const { whereSql, params } = buildSpecsWhere(filter);
    if (!whereSql) return errorResponse(res, 400, "VALIDATION_ERROR", "A filter (search, make, source, or status) is required for select-all bulk approve.");
    const result = await vehicleAll(
      `UPDATE vehicle_specs SET status = 'approved', updated_at = ? ${whereSql} RETURNING id`,
      [now, ...params]
    );
    updated = result.length;
  } else if (Array.isArray(ids) && ids.length) {
    for (const id of ids) {
      await vehicleRun(`UPDATE vehicle_specs SET status = 'approved', updated_at = ? WHERE id = ?`, [now, id]);
      updated++;
    }
  } else {
    return errorResponse(res, 400, "VALIDATION_ERROR", "ids array or filter object is required.");
  }

  auditLog(req, "VEHICLE_SPECS_BULK_APPROVED", "vehicle_specs", "Info", { count: updated, filter: filter || null }).catch(console.error);
  return ok(res, { updated }, `${updated} vehicle spec(s) approved.`);
});

// ── Manual CSV import ────────────────────────────────────────────────────────
// Expected header columns (case-insensitive): make, model, and optionally
// trim, year, bodystyle, enginetype, enginesizecc, fueltype, transmission,
// drivetrain, modelnumber, colors (semicolon-separated color names).
router.post("/import/csv", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), csvUpload.single("file"), async (req: AuthRequest, res) => {
  if (!req.file) return errorResponse(res, 400, "VALIDATION_ERROR", "CSV file required.");

  const content = req.file.buffer.toString("utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return errorResponse(res, 400, "VALIDATION_ERROR", "CSV must have a header row and at least one data row.");

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const required = ["make", "model"];
  for (const col of required) {
    if (!header.includes(col)) return errorResponse(res, 400, "VALIDATION_ERROR", `Missing required CSV column: ${col}`);
  }
  const idx = (col: string) => header.indexOf(col);
  const get = (cols: string[], col: string) => (idx(col) >= 0 ? (cols[idx(col)] || "").trim() : "");

  let inserted = 0, skipped = 0, failed = 0;
  const errors: { row: number; reason: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const make = get(cols, "make");
    const model = get(cols, "model");
    if (!make || !model) { errors.push({ row: i + 1, reason: "make and model are required" }); failed++; continue; }

    const trim = get(cols, "trim") || null;
    const year = get(cols, "year");
    const modelNumber = get(cols, "modelnumber") || slugify(`${make}-${model}-${trim || ""}-${year || ""}`);
    const colorsRaw = get(cols, "colors");

    try {
      const result = await upsertVehicleSpec(
        {
          make, model, trim,
          modelYear: year ? Number(year) : null,
          bodyStyle: get(cols, "bodystyle") || null,
          engineType: get(cols, "enginetype") || null,
          engineSizeCc: get(cols, "enginesizecc") ? Number(get(cols, "enginesizecc")) : null,
          fuelType: get(cols, "fueltype") || null,
          transmission: get(cols, "transmission") || null,
          drivetrain: get(cols, "drivetrain") || null,
          sourceRef: modelNumber,
          colors: colorsRaw ? colorsRaw.split(";").map((name) => ({ name: name.trim() })).filter((c) => c.name) : undefined,
        },
        "manual_csv"
      );
      if (result === "inserted") inserted++; else skipped++;
    } catch (e: any) {
      failed++;
      errors.push({ row: i + 1, reason: e?.message || "Unknown error" });
    }
  }

  auditLog(req, "VEHICLE_CSV_IMPORTED", "vehicle_specs", "Info", { inserted, skipped, failed }).catch(console.error);
  return ok(res, { inserted, skipped, failed, errors }, `Imported ${inserted} new row(s), ${skipped} already on file (skipped), ${failed} failed.`);
});

// ── Data sources ─────────────────────────────────────────────────────────────
router.get("/sources", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (_req, res) => {
  const rows = await vehicleAll(`SELECT * FROM vehicle_data_sources ORDER BY source_key`);
  const data = rows.map((r: any) => ({
    sourceKey: r.source_key, displayName: r.display_name, enabled: r.enabled,
    scheduleCron: r.schedule_cron, lastRunId: r.last_run_id, lastSuccessAt: r.last_success_at,
    // manual_csv has no registry adapter (it's upload-driven, not sync-now-driven)
    // but is always usable via the Import CSV button, so it reads as "configured".
    isConfigured: ADAPTERS[r.source_key]?.isConfigured() ?? (r.source_key === "manual_csv"),
    hasAdapter: !!ADAPTERS[r.source_key],
  }));
  return ok(res, { data });
});

router.patch("/sources/:sourceKey", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const source = await vehicleGet(`SELECT * FROM vehicle_data_sources WHERE source_key = ?`, [req.params.sourceKey]);
  if (!source) return errorResponse(res, 404, "NOT_FOUND", "Unknown source.");

  const { enabled, scheduleCron } = req.body as { enabled?: boolean; scheduleCron?: string };
  if (enabled === true) {
    const adapter = ADAPTERS[req.params.sourceKey];
    const isConfigured = req.params.sourceKey === "manual_csv" ? true : adapter?.isConfigured();
    if (!isConfigured) {
      return errorResponse(res, 400, "NOT_CONFIGURED", "This source has no credentials configured yet and cannot be enabled.");
    }
  }
  const sets: string[] = [];
  const vals: any[] = [];
  if (enabled !== undefined) { sets.push(`enabled = ?`); vals.push(!!enabled); }
  if (scheduleCron !== undefined) { sets.push(`schedule_cron = ?`); vals.push(scheduleCron || null); }
  if (!sets.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No fields to update.");
  sets.push(`updated_at = ?`); vals.push(new Date().toISOString());
  vals.push(req.params.sourceKey);

  await vehicleRun(`UPDATE vehicle_data_sources SET ${sets.join(", ")} WHERE source_key = ?`, vals);
  auditLog(req, "VEHICLE_SOURCE_UPDATED", `vehicle_data_source:${req.params.sourceKey}`, "Info", { enabled, scheduleCron }).catch(console.error);
  return ok(res, {}, "Source updated.");
});

router.post("/sources/:sourceKey/sync-now", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const adapter = ADAPTERS[req.params.sourceKey];
  if (!adapter) return errorResponse(res, 400, "NO_ADAPTER", "This source doesn't support on-demand sync yet.");
  if (!adapter.isConfigured()) return errorResponse(res, 400, "NOT_CONFIGURED", "This source has no credentials configured yet.");

  const result = await runSync(adapter, req.user!.id, "manual");
  auditLog(req, "VEHICLE_SYNC_TRIGGERED", `vehicle_data_source:${req.params.sourceKey}`, "Info", result).catch(console.error);
  return created(res, result, `Sync ${result.status} — ${result.rowsInserted} inserted, ${result.rowsSkipped} already on file, ${result.rowsFailed} failed.`);
});

// ── Sync run history ─────────────────────────────────────────────────────────
router.get("/sync-runs", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req, res) => {
  const { source } = req.query as Record<string, string>;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Number(req.query.pageSize) || 25);
  const offset = (page - 1) * pageSize;
  const where = source ? `WHERE source = ?` : "";
  const params = source ? [source] : [];
  const rows = await vehicleAll(
    `SELECT * FROM vehicle_sync_runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const totalRow = await vehicleGet<{ total: string }>(`SELECT COUNT(*) as total FROM vehicle_sync_runs ${where}`, params);
  return ok(res, { data: rows.map(mapSyncRun), meta: { total: Number(totalRow?.total || 0), page, pageSize } });
});

router.get("/sync-runs/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req, res) => {
  const run = await vehicleGet(`SELECT * FROM vehicle_sync_runs WHERE id = ?`, [req.params.id]);
  if (!run) return errorResponse(res, 404, "NOT_FOUND", "Sync run not found.");
  return ok(res, mapSyncRun(run));
});

// ── Push to CRSP ─────────────────────────────────────────────────────────────
router.post("/crsp-push", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const filter = (req.body?.filter || {}) as { make?: string; source?: string };
  const { fileText, rowCount } = await buildCrspExport(filter);

  const batchId = uuidv4();
  const now = new Date().toISOString();
  await vehicleRun(
    `INSERT INTO vehicle_crsp_push_batches (id, created_by, created_at, filter_json, row_count, status)
     VALUES (?,?,?,?,?,'draft')`,
    [batchId, req.user!.id, now, JSON.stringify(filter), rowCount]
  );

  auditLog(req, "VEHICLE_CRSP_EXPORT_CREATED", `vehicle_crsp_push_batch:${batchId}`, "Info", { rowCount, filter }).catch(console.error);
  return created(res, { batchId, rowCount }, `Export batch created with ${rowCount} row(s).`);
});

router.get("/crsp-push/:batchId/download", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const batch = await vehicleGet<{ id: string; filter_json: string }>(`SELECT * FROM vehicle_crsp_push_batches WHERE id = ?`, [req.params.batchId]);
  if (!batch) return errorResponse(res, 404, "NOT_FOUND", "Export batch not found.");

  const filter = batch.filter_json ? JSON.parse(batch.filter_json) : {};
  const { fileText } = await buildCrspExport(filter);

  const now = new Date().toISOString();
  await vehicleRun(`UPDATE vehicle_crsp_push_batches SET status = 'downloaded', pushed_at = ? WHERE id = ?`, [now, req.params.batchId]);
  auditLog(req, "VEHICLE_CRSP_EXPORT_DOWNLOADED", `vehicle_crsp_push_batch:${req.params.batchId}`, "Info", {}).catch(console.error);

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="car-models.js"`);
  return res.status(200).send(fileText);
});

router.get("/crsp-push", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req, res) => {
  const rows = await vehicleAll(`SELECT * FROM vehicle_crsp_push_batches ORDER BY created_at DESC LIMIT 100`);
  return ok(res, { data: rows.map((r: any) => ({
    id: r.id, createdBy: r.created_by, createdAt: r.created_at,
    filter: r.filter_json ? JSON.parse(r.filter_json) : {},
    rowCount: r.row_count, status: r.status, pushedAt: r.pushed_at,
  })) });
});

export default router;
