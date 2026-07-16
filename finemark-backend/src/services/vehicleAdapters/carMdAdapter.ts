import type { VehicleSourceAdapter, NormalizedVehicleRow } from "./types.js";

// Stub — CarMD requires a paid API subscription (partner token + auth key).
// Wire up fetchBatch()/normalize() once credentials exist; until then
// isConfigured() stays false and the sync route refuses to enable or run this source.
export function isCarMdConfigured(): boolean {
  return (
    !!process.env.CARMD_PARTNER_TOKEN &&
    process.env.CARMD_PARTNER_TOKEN !== "YOUR_CARMD_PARTNER_TOKEN" &&
    !!process.env.CARMD_AUTHORIZATION_KEY &&
    process.env.CARMD_AUTHORIZATION_KEY !== "YOUR_CARMD_AUTHORIZATION_KEY"
  );
}

export const carMdAdapter: VehicleSourceAdapter = {
  key: "carmd",
  displayName: "CarMD",
  isConfigured: isCarMdConfigured,
  async fetchBatch(): Promise<unknown[]> {
    if (!isCarMdConfigured()) {
      throw new Error("CarMD adapter is not configured — set CARMD_PARTNER_TOKEN and CARMD_AUTHORIZATION_KEY to enable.");
    }
    // TODO: implement once CarMD API credentials/docs are available.
    return [];
  },
  normalize(_rawRows: unknown[]): NormalizedVehicleRow[] {
    return [];
  },
};
