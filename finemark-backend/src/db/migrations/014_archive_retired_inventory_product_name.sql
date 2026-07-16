-- archive_retired_inventory only stored the raw product_id, a foreign key into
-- the LIVE finemark_backend.inv_product_catalog — a physically separate
-- database that can't be joined from here. Snapshot the product's display
-- name/code at archive time instead, same as every other field on this table.

ALTER TABLE archive_retired_inventory ADD COLUMN IF NOT EXISTS product_name TEXT;
ALTER TABLE archive_retired_inventory ADD COLUMN IF NOT EXISTS product_code TEXT;
