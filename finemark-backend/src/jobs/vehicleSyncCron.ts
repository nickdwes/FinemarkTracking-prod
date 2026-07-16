import cron from "node-cron";
import { vehicleAll } from "../vehicleDb.js";
import { ADAPTERS } from "../services/vehicleAdapters/index.js";
import { runSync } from "../services/vehicleSyncService.js";

export const initVehicleSyncCron = () => {
  const enabled = process.env.VEHICLE_SYNC_CRON_ENABLED === "true";
  if (!enabled) {
    console.log("[VehicleSync Cron] Disabled via VEHICLE_SYNC_CRON_ENABLED=false");
    return;
  }

  // These sources update rarely (KRA: roughly annually, NHTSA: no urgency) —
  // weekly, not every few minutes. Default: Monday 03:00 Africa/Nairobi.
  const schedule = process.env.VEHICLE_SYNC_CRON_SCHEDULE || "0 3 * * 1";

  cron.schedule(schedule, async () => {
    try {
      console.log("[VehicleSync Cron] Running scheduled vehicle data sync...");
      const sources = await vehicleAll<{ source_key: string }>(
        `SELECT source_key FROM vehicle_data_sources WHERE enabled = true`
      );
      for (const { source_key } of sources) {
        const adapter = ADAPTERS[source_key];
        if (!adapter?.isConfigured()) continue;
        const result = await runSync(adapter, null, "cron");
        console.log(`[VehicleSync Cron] ${source_key}: ${result.status} — ${result.rowsInserted} inserted, ${result.rowsUpdated} updated, ${result.rowsFailed} failed`);
      }
    } catch (err) {
      console.error("[VehicleSync Cron] Error:", err);
    }
  }, { timezone: "Africa/Nairobi" });

  console.log(`[VehicleSync Cron] Initialized (schedule: ${schedule}, Africa/Nairobi)`);
};
