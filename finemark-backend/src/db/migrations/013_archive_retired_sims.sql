-- Archived snapshot of live inv_sims rows that are unallocated and not
-- installed/suspended (status IN 'available','retired' AND issued_to_id IS
-- NULL), swept out of the live ledger via POST
-- /api/archive/retired-sims/sweep. Same pattern as archive_retired_inventory
-- (012) — lives in the physically-isolated finemark_archive database. The
-- live inv_sims rows are soft-deleted (deleted_at set), not removed, so this
-- table is a convenience report, not the only surviving copy of the data.

CREATE TABLE IF NOT EXISTS archive_retired_sims (
  id                    TEXT PRIMARY KEY,
  source_sim_id         TEXT NOT NULL,
  iccid                 TEXT,
  imsi                  TEXT,
  msisdn                TEXT,
  operator              TEXT,
  plan                  TEXT,
  sim_type              TEXT,
  status_at_archive     TEXT NOT NULL,
  activation_date       TEXT,
  expiry_date           TEXT,
  notes                 TEXT,
  source_created_at     TEXT,
  archived_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by_user_id   TEXT,
  archived_by_name      TEXT,
  CONSTRAINT uq_archive_retired_sims_source UNIQUE (source_sim_id)
);
CREATE INDEX IF NOT EXISTS idx_archive_retired_sims_status ON archive_retired_sims(status_at_archive);
CREATE INDEX IF NOT EXISTS idx_archive_retired_sims_archived_at ON archive_retired_sims(archived_at DESC);
