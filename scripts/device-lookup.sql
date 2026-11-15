-- Read-only device trace. Usage:
--   docker exec -i finemark-prod-db psql -U finemark -d finemark_backend < scripts/device-lookup.sql
-- Matches the numbers anywhere in IMEI / serial (handles a truncated 14-digit IMEI).
-- Edit the two VALUES lists below (\set) to trace other devices.
\set nums '(''90950440304105''), (''865784057244561'')'
\pset pager off
\x auto
\set ON_ERROR_ROLLBACK on
BEGIN READ ONLY;

\echo '=== 1. Inventory record ==='
WITH q(n) AS (VALUES :nums)
SELECT q.n AS searched, i.id, p.product_name AS product, i.imei, i.serial_number, i.status,
       i.issued_to_name, i.issued_at, i.installation_id, i.customer_id,
       i.sim_phone, i.deployed_at, i.activated_at, i.warehouse_location,
       i.defect_ticket_id, i.replaced_by_item_id, i.deleted_at, i.updated_at, i.notes
FROM q LEFT JOIN inv_items i
  ON i.imei LIKE '%'||q.n||'%' OR i.serial_number LIKE '%'||q.n||'%'
LEFT JOIN inv_product_catalog p ON p.id = i.product_id;

\echo '=== 2. Movement history (oldest first) ==='
WITH q(n) AS (VALUES :nums),
     dev AS (SELECT DISTINCT i.id, q.n FROM q JOIN inv_items i ON i.imei LIKE '%'||q.n||'%' OR i.serial_number LIKE '%'||q.n||'%')
SELECT d.n, m.created_at, m.action, m.from_status, m.to_status,
       m.from_location, m.to_location, m.installation_id, m.performed_by_email, m.notes
FROM dev d JOIN inv_movements m ON m.item_id = d.id ORDER BY d.n, m.created_at;

\echo '=== 3. Checkouts to technicians ==='
WITH q(n) AS (VALUES :nums),
     dev AS (SELECT DISTINCT i.id, q.n FROM q JOIN inv_items i ON i.imei LIKE '%'||q.n||'%' OR i.serial_number LIKE '%'||q.n||'%')
SELECT d.n, c.* FROM dev d JOIN inv_checkout_records c ON c.item_id = d.id ORDER BY d.n, c.checkout_at;

\echo '=== 4. Installation tickets using this device ==='
WITH q(n) AS (VALUES :nums),
     dev AS (SELECT DISTINCT i.id, q.n FROM q JOIN inv_items i ON i.imei LIKE '%'||q.n||'%' OR i.serial_number LIKE '%'||q.n||'%')
SELECT d.n, t.ticket_no, t.status, t.stage, t.customer_name, t.vehicle_registration,
       t.assigned_to_email, t.technician_signed_off_at, t.engineer_signed_off_at,
       t.created_at, t.updated_at, t.deleted_at
FROM dev d JOIN installation_tickets t ON t.assigned_device_id = d.id ORDER BY d.n, t.created_at;

\echo '=== 5. Retrievals (uninstall / swap) ==='
WITH q(n) AS (VALUES :nums)
SELECT q.n, r.retrieval_no, r.retrieval_type, r.reason, r.previous_status, r.new_status,
       r.vehicle_registration, r.ticket_no, r.technician_name, r.created_at
FROM q JOIN device_retrievals r ON r.device_imei LIKE '%'||q.n||'%' OR r.device_serial LIKE '%'||q.n||'%'
ORDER BY q.n, r.created_at;

\echo '=== 6. SIM paired with the device ==='
WITH q(n) AS (VALUES :nums),
     dev AS (SELECT DISTINCT i.id, q.n FROM q JOIN inv_items i ON i.imei LIKE '%'||q.n||'%' OR i.serial_number LIKE '%'||q.n||'%')
SELECT d.n, s.iccid, s.msisdn, s.operator, s.status, s.issued_to_name, s.installed_at
FROM dev d JOIN inv_sims s ON s.device_item_id = d.id;

\echo '=== 7. Certificates quoting this IMEI ==='
WITH q(n) AS (VALUES :nums)
SELECT q.n, c.serial_no, c.car_registration, c.name, c.partner_bank, c.start_date, c.end_date, c.deleted_at
FROM q JOIN certificates c ON c.imei_1 LIKE '%'||q.n||'%' OR c.imei_2 LIKE '%'||q.n||'%'
ORDER BY q.n, c.created_at;

ROLLBACK;
