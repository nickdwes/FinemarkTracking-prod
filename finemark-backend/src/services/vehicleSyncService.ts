import { v4 as uuidv4 } from "uuid";
import { vehicleGet, vehicleRun } from "../vehicleDb.js";
import type { VehicleSourceAdapter, NormalizedVehicleRow } from "./vehicleAdapters/types.js";

// Sync/import only ever ADDS new catalog entries — an existing row (matched
// by source+source_ref) is never silently overwritten by a re-sync or
// re-import, even if the source's data for it has since changed. This is
// deliberate: a row may already be human-approved or hand-corrected via
// PATCH /specs/:id, and a resync should never clobber that. To actually
// change an existing row, use PATCH /specs/:id directly.
export async function upsertVehicleSpec(row: NormalizedVehicleRow, source: string): Promise<"inserted" | "skipped"> {
  const existing = await vehicleGet<{ id: string }>(
    `SELECT id FROM vehicle_specs WHERE source = ? AND source_ref = ?`,
    [source, row.sourceRef]
  );
  if (existing) return "skipped";

  const now = new Date().toISOString();
  const specId = uuidv4();
  await vehicleRun(
    `INSERT INTO vehicle_specs
       (id, make, model, trim, model_year, body_style, engine_type, engine_size_cc, engine_size_l,
        fuel_type, transmission, drivetrain, wmi, vin_pattern, production_start_date, production_end_date,
        source, source_ref, status, vehicle_category, raw_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      specId, row.make, row.model, row.trim || null, row.modelYear || null, row.bodyStyle || null,
      row.engineType || null, row.engineSizeCc || null, row.engineSizeL || null, row.fuelType || null,
      row.transmission || null, row.drivetrain || null, row.wmi || null, row.vinPattern || null,
      row.productionStartDate || null, row.productionEndDate || null,
      source, row.sourceRef, "pending_review", row.vehicleCategory || "motor_vehicle",
      row.raw ? JSON.stringify(row.raw) : null, now, now,
    ]
  );

  if (row.colors?.length) {
    for (const color of row.colors) {
      await vehicleRun(
        `INSERT INTO vehicle_spec_colors (id, vehicle_spec_id, color_name, color_code, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT (vehicle_spec_id, color_name) DO UPDATE SET color_code = EXCLUDED.color_code`,
        [uuidv4(), specId, color.name, color.code || null, now]
      );
    }
  }

  return "inserted";
}

export async function runSync(
  adapter: VehicleSourceAdapter,
  triggeredBy: string | null,
  triggerType: "manual" | "cron" = "manual"
): Promise<{ runId: string; status: string; rowsFetched: number; rowsInserted: number; rowsSkipped: number; rowsUpdated: number; rowsFailed: number }> {
  const runId = uuidv4();
  const startedAt = new Date().toISOString();

  await vehicleRun(
    `INSERT INTO vehicle_sync_runs (id, source, trigger_type, triggered_by, started_at, status)
     VALUES (?,?,?,?,?,?)`,
    [runId, adapter.key, triggerType, triggeredBy, startedAt, "running"]
  );

  // rowsUpdated is kept at 0 and left in the returned/stored shape only for
  // API + historical-row compatibility — upsertVehicleSpec() no longer
  // updates existing rows (see its own comment), so nothing increments this
  // counter going forward; past sync runs' stored rows_updated values (from
  // before this change) remain a true historical record.
  let rowsFetched = 0, rowsInserted = 0, rowsSkipped = 0, rowsUpdated = 0, rowsFailed = 0;
  let status: "success" | "partial" | "failed" = "success";
  let errorSummary: string | null = null;

  try {
    const rawRows = await adapter.fetchBatch();
    rowsFetched = rawRows.length;
    const normalized = adapter.normalize(rawRows);

    for (const row of normalized) {
      try {
        const result = await upsertVehicleSpec(row, adapter.key);
        if (result === "inserted") rowsInserted++; else rowsSkipped++;
      } catch (rowErr: any) {
        rowsFailed++;
        console.error(`[VehicleSync] Failed to upsert row (source=${adapter.key}, ref=${row.sourceRef}):`, rowErr);
      }
    }
    status = rowsFailed > 0 ? "partial" : "success";
  } catch (err: any) {
    status = "failed";
    errorSummary = err?.message || String(err);
    console.error(`[VehicleSync] Sync failed for source=${adapter.key}:`, err);
  }

  const finishedAt = new Date().toISOString();
  await vehicleRun(
    `UPDATE vehicle_sync_runs SET
       finished_at = ?, status = ?, rows_fetched = ?, rows_inserted = ?,
       rows_updated = ?, rows_failed = ?, error_summary = ?
     WHERE id = ?`,
    [finishedAt, status, rowsFetched, rowsInserted, rowsUpdated, rowsFailed, errorSummary, runId]
  );

  if (status !== "failed") {
    await vehicleRun(
      `UPDATE vehicle_data_sources SET last_run_id = ?, last_success_at = ?, updated_at = ? WHERE source_key = ?`,
      [runId, finishedAt, finishedAt, adapter.key]
    );
  } else {
    await vehicleRun(
      `UPDATE vehicle_data_sources SET last_run_id = ?, updated_at = ? WHERE source_key = ?`,
      [runId, finishedAt, adapter.key]
    );
  }

  return { runId, status, rowsFetched, rowsInserted, rowsSkipped, rowsUpdated, rowsFailed };
}
