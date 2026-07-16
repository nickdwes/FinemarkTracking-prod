// Common shape every vehicle-data source adapter normalizes its rows into,
// regardless of how different each provider's raw response looks.
export interface NormalizedVehicleRow {
  make: string;
  model: string;
  trim?: string | null;
  modelYear?: number | null;
  bodyStyle?: string | null;
  engineType?: string | null;
  engineSizeCc?: number | null;
  engineSizeL?: number | null;
  fuelType?: string | null;
  transmission?: string | null;
  drivetrain?: string | null;
  wmi?: string | null;
  vinPattern?: string | null;
  productionStartDate?: string | null;
  productionEndDate?: string | null;
  /** motor_vehicle (default) | motorcycle | tractor | tuktuk | special_equipment */
  vehicleCategory?: string | null;
  sourceRef: string;
  colors?: { name: string; code?: string | null }[];
  raw?: unknown;
}

export interface VehicleSourceAdapter {
  key: string;
  displayName: string;
  isConfigured(): boolean;
  fetchBatch(params?: { since?: Date }): Promise<unknown[]>;
  normalize(rawRows: unknown[]): NormalizedVehicleRow[];
}
