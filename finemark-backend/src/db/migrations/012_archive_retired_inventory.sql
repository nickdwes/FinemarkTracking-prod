-- Archived snapshot of live inv_items rows that are unallocated and not
-- installed (status IN 'In Stock','Returned','Defective','Sent to Supplier',
-- 'Replaced' AND issued_to_id IS NULL), swept out of the live ledger via
-- POST /api/archive/retired-inventory/sweep. Lives in finemark_archive, the
-- same physically-isolated database as the rest of the archive module — the
-- live inv_items rows are soft-deleted (deleted_at set), not removed, so this
-- table is a convenience report, not the only surviving copy of the data.

CREATE TABLE IF NOT EXISTS archive_retired_inventory (
  id                    TEXT PRIMARY KEY,
  source_item_id        TEXT NOT NULL,
  product_id            TEXT,
  serial_number         TEXT,
  imei                  TEXT,
  mac_address           TEXT,
  status_at_archive     TEXT NOT NULL,
  warehouse_location    TEXT,
  purchase_date         TEXT,
  purchase_price        TEXT,
  notes                 TEXT,
  source_created_at     TEXT,
  archived_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by_user_id   TEXT,
  archived_by_name      TEXT,
  CONSTRAINT uq_archive_retired_inventory_source UNIQUE (source_item_id)
);
CREATE INDEX IF NOT EXISTS idx_archive_retired_inventory_status ON archive_retired_inventory(status_at_archive);
CREATE INDEX IF NOT EXISTS idx_archive_retired_inventory_archived_at ON archive_retired_inventory(archived_at DESC);
