-- Vehicle Master Database — lives in its own database (finemark_vehicles),
-- physically isolated from finemark_backend and finemark_archive. Populated by
-- pluggable source adapters (see src/services/vehicleAdapters/), reviewed and
-- approved via the Vehicle Data Sync admin page, then selectively exported into
-- the CRSP-shaped car-models.js the rest of the app already consumes.
--
-- Note: NOT the same thing as finemark_backend's own `vehicles` table (a
-- customer's registered vehicle — registration, VIN, customer linkage). This
-- module is named vehicle_* / "vehicle master" throughout to avoid confusion.

CREATE TABLE IF NOT EXISTS vehicle_specs (
  id                     TEXT PRIMARY KEY,
  make                   TEXT NOT NULL,
  model                  TEXT NOT NULL,
  trim                   TEXT,
  model_year             INTEGER,
  body_style             TEXT,
  engine_type            TEXT,
  engine_size_cc         INTEGER,
  engine_size_l          NUMERIC(4,2),
  fuel_type              TEXT,
  transmission           TEXT,
  drivetrain             TEXT,
  wmi                    TEXT,
  vin_pattern            TEXT,
  production_start_date  DATE,
  production_end_date    DATE,
  source                 TEXT NOT NULL,
  source_ref             TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending_review',
  raw_json               JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_vehicle_specs_source_ref UNIQUE (source, source_ref),
  CONSTRAINT chk_vehicle_specs_status CHECK (status IN ('pending_review', 'approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS idx_vehicle_specs_make_model_year ON vehicle_specs(make, model, model_year);
CREATE INDEX IF NOT EXISTS idx_vehicle_specs_status ON vehicle_specs(status);
CREATE INDEX IF NOT EXISTS idx_vehicle_specs_wmi ON vehicle_specs(wmi);
CREATE INDEX IF NOT EXISTS idx_vehicle_specs_source ON vehicle_specs(source);

CREATE TABLE IF NOT EXISTS vehicle_spec_colors (
  id              TEXT PRIMARY KEY,
  vehicle_spec_id TEXT NOT NULL REFERENCES vehicle_specs(id) ON DELETE CASCADE,
  color_name      TEXT NOT NULL,
  color_code      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_vehicle_spec_color UNIQUE (vehicle_spec_id, color_name)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_spec_colors_spec ON vehicle_spec_colors(vehicle_spec_id);

-- One row per ingestion run, for admin visibility/audit — mirrors archive_load_runs.
CREATE TABLE IF NOT EXISTS vehicle_sync_runs (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  trigger_type   TEXT NOT NULL DEFAULT 'manual',
  triggered_by   TEXT,
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'running',
  rows_fetched   INTEGER NOT NULL DEFAULT 0,
  rows_inserted  INTEGER NOT NULL DEFAULT 0,
  rows_updated   INTEGER NOT NULL DEFAULT 0,
  rows_failed    INTEGER NOT NULL DEFAULT 0,
  error_summary  TEXT,
  notes          TEXT,
  CONSTRAINT chk_vehicle_sync_runs_trigger CHECK (trigger_type IN ('manual', 'cron')),
  CONSTRAINT chk_vehicle_sync_runs_status CHECK (status IN ('running', 'success', 'partial', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_vehicle_sync_runs_source ON vehicle_sync_runs(source, started_at DESC);

-- UI-facing per-adapter config (enabled toggle, schedule override, last-run
-- pointer). Credentials themselves stay in .env, never in this table.
CREATE TABLE IF NOT EXISTS vehicle_data_sources (
  source_key      TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  schedule_cron   TEXT,
  last_run_id     TEXT REFERENCES vehicle_sync_runs(id),
  last_success_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO vehicle_data_sources (source_key, display_name, enabled) VALUES
  ('manual_csv', 'Manual CSV Import', true),
  ('kra_crsp',   'KRA CRSP List',     false),
  ('nhtsa_vpic', 'NHTSA vPIC',        false),
  ('jato',       'JATO Dynamics',     false),
  ('carmd',      'CarMD',             false),
  ('dataone',    'DataOne Software',  false)
ON CONFLICT (source_key) DO NOTHING;

-- Audit trail of each "generate CRSP export" action.
CREATE TABLE IF NOT EXISTS vehicle_crsp_push_batches (
  id           TEXT PRIMARY KEY,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  filter_json  TEXT,
  row_count    INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'draft',
  pushed_at    TIMESTAMPTZ,
  notes        TEXT,
  CONSTRAINT chk_vehicle_crsp_push_status CHECK (status IN ('draft', 'downloaded'))
);
