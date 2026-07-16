-- Vehicle Master Database — adds a category field distinguishing motorcycles,
-- tractors, tuktuks, and heavy/construction equipment from ordinary cars and
-- trucks (the only thing KRA's CRSP schedule — the source of most existing
-- rows — actually covers). Existing rows all default to 'motor_vehicle'.

ALTER TABLE vehicle_specs ADD COLUMN IF NOT EXISTS vehicle_category TEXT NOT NULL DEFAULT 'motor_vehicle';

ALTER TABLE vehicle_specs ADD CONSTRAINT chk_vehicle_specs_category
  CHECK (vehicle_category IN ('motor_vehicle', 'motorcycle', 'tractor', 'tuktuk', 'special_equipment'));

CREATE INDEX IF NOT EXISTS idx_vehicle_specs_category ON vehicle_specs(vehicle_category);
