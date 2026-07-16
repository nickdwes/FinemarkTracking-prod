import type { VehicleSourceAdapter, NormalizedVehicleRow } from "./types.js";

// Stub — DataOne Software requires a paid API subscription. Wire up
// fetchBatch()/normalize() once credentials exist; until then isConfigured()
// stays false and the sync route refuses to enable or run this source.
export function isDataOneConfigured(): boolean {
  return (
    !!process.env.DATAONE_API_KEY &&
    process.env.DATAONE_API_KEY !== "YOUR_DATAONE_API_KEY"
  );
}

export const dataOneAdapter: VehicleSourceAdapter = {
  key: "dataone",
  displayName: "DataOne Software",
  isConfigured: isDataOneConfigured,
  async fetchBatch(): Promise<unknown[]> {
    if (!isDataOneConfigured()) {
      throw new Error("DataOne adapter is not configured — set DATAONE_API_KEY to enable.");
    }
    // TODO: implement once DataOne API credentials/docs are available.
    return [];
  },
  normalize(_rawRows: unknown[]): NormalizedVehicleRow[] {
    return [];
  },
};
