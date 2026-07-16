import type { VehicleSourceAdapter, NormalizedVehicleRow } from "./types.js";

// Stub — JATO Dynamics requires a paid API subscription. Wire up fetchBatch()/
// normalize() once credentials exist; until then isConfigured() stays false
// and the sync route refuses to enable or run this source.
export function isJatoConfigured(): boolean {
  return (
    !!process.env.JATO_API_KEY &&
    process.env.JATO_API_KEY !== "YOUR_JATO_API_KEY"
  );
}

export const jatoAdapter: VehicleSourceAdapter = {
  key: "jato",
  displayName: "JATO Dynamics",
  isConfigured: isJatoConfigured,
  async fetchBatch(): Promise<unknown[]> {
    if (!isJatoConfigured()) {
      throw new Error("JATO adapter is not configured — set JATO_API_KEY to enable.");
    }
    // TODO: implement once JATO API credentials/docs are available.
    return [];
  },
  normalize(_rawRows: unknown[]): NormalizedVehicleRow[] {
    return [];
  },
};
