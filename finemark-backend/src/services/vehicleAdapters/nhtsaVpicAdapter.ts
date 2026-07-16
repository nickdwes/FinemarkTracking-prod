import { vehicleAll } from "../../vehicleDb.js";
import type { VehicleSourceAdapter, NormalizedVehicleRow } from "./types.js";

// NHTSA's vPIC (Vehicle Product Information Catalog) is a free, public,
// keyless US-government API — no credentials to configure, ever.
const VPIC_BASE = "https://vpic.nhtsa.dot.gov/api/vehicles";

export function isNhtsaVpicConfigured(): boolean {
  return true;
}

interface RawVpicRow {
  makeName: string;
  modelName: string;
  modelId: number;
  makeId: number;
}

const THROTTLE_MS = 200; // ~5 req/s, per NHTSA's fair-use guidance
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// vPIC's GetModelsForMake does an unanchored substring match against its
// *entire* manufacturer registry (which includes thousands of low-volume
// trailer/golf-cart/motorcycle makers), not just against real car makes —
// e.g. querying "NIO" returns "Junior's Golf Carts", "Companion Trailers",
// and "Dominion Motorcycle" (all contain "nio"), and "BENTLEY" mixes real
// Bentley models with "Bentley Trailers & Custom Coaches" and "A Smith GT
// Bentley". Only accept a row whose Make_Name is the *same* make once both
// sides are stripped to bare alphanumerics — this discards the substring
// noise while still matching legitimate naming variants like
// "MITSUBISHI FUSO" -> "Mitsubishi Fuso".
const normalizeMakeKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function fetchModelsForMake(make: string): Promise<RawVpicRow[]> {
  const url = `${VPIC_BASE}/GetModelsForMake/${encodeURIComponent(make)}?format=json`;
  const res = await fetch(url);
  if (!res.ok) return [];

  // A make with characters vPIC's routing can't handle (e.g. an embedded "/"
  // in "NISSAN DIESEL/UD") comes back as an HTML error page, not JSON, even
  // with a 200-ish status from some edge nodes — guard the parse rather than
  // letting one bad make abort the whole crawl.
  let body: any;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  const results = Array.isArray(body?.Results) ? body.Results : [];
  const wantedKey = normalizeMakeKey(make);
  return results
    .filter((r: any) => r.Model_Name && r.Make_Name && normalizeMakeKey(String(r.Make_Name)) === wantedKey)
    .map((r: any) => ({
      makeName: String(r.Make_Name),
      modelName: String(r.Model_Name),
      modelId: Number(r.Model_ID),
      makeId: Number(r.Make_ID),
    }));
}

export const nhtsaVpicAdapter: VehicleSourceAdapter = {
  key: "nhtsa_vpic",
  displayName: "NHTSA vPIC",
  isConfigured: isNhtsaVpicConfigured,

  // Realistic use of a US-government catalog against a Kenyan used-import
  // fleet: there's no meaningful "since" delta to pull, so this is a bounded
  // backfill crawl — one GetModelsForMake call per make already seen in our
  // own vehicle_specs (from KRA CRSP and prior syncs), throttled to stay well
  // under vPIC's rate limits. Makes vPIC doesn't recognize (naming mismatches
  // like "LANDROVER" vs "Land Rover", or region-specific badges like "SAIC
  // MOTORS") simply return zero rows rather than failing the run.
  async fetchBatch(): Promise<unknown[]> {
    const makeRows = await vehicleAll<{ make: string }>(
      `SELECT DISTINCT make FROM vehicle_specs WHERE make IS NOT NULL AND make <> '' ORDER BY make`
    );

    const allRows: RawVpicRow[] = [];
    for (const { make } of makeRows) {
      try {
        const rows = await fetchModelsForMake(make);
        allRows.push(...rows);
      } catch (err) {
        console.error(`[NhtsaVpicAdapter] Failed to fetch models for make="${make}":`, err);
      }
      await sleep(THROTTLE_MS);
    }
    return allRows;
  },

  normalize(rawRows: unknown[]): NormalizedVehicleRow[] {
    return (rawRows as RawVpicRow[]).map((r) => ({
      make: r.makeName,
      model: r.modelName,
      trim: null,
      modelYear: null,
      bodyStyle: null,
      sourceRef: `nhtsa-${r.modelId}`,
      raw: { makeId: r.makeId, modelId: r.modelId },
    }));
  },
};
