import type { VehicleSourceAdapter } from "./types.js";
import { jatoAdapter } from "./jatoAdapter.js";
import { carMdAdapter } from "./carMdAdapter.js";
import { dataOneAdapter } from "./dataOneAdapter.js";
import { kraCrspAdapter } from "./kraCrspAdapter.js";
import { nhtsaVpicAdapter } from "./nhtsaVpicAdapter.js";

// Registry of adapters that support the sync-now/cron flow. manual_csv is
// handled by its own upload route, not through this registry.
export const ADAPTERS: Record<string, VehicleSourceAdapter> = {
  jato: jatoAdapter,
  carmd: carMdAdapter,
  dataone: dataOneAdapter,
  kra_crsp: kraCrspAdapter,
  nhtsa_vpic: nhtsaVpicAdapter,
};

export type { VehicleSourceAdapter, NormalizedVehicleRow } from "./types.js";
