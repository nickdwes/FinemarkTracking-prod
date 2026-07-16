-- Corporate Lead Redesign — Stage Two (vehicle-register.html batch capture)
-- needs a loose, nullable link back to the corporate lead a vehicle was
-- captured from, so a vehicle registered via a lead's batch flow can be
-- traced back to that lead — same style as the existing partner_id column
-- (no foreign key, just traceability; a deleted/converted lead should never
-- block or cascade-delete a vehicle).

ALTER TABLE crm_customer_vehicles ADD COLUMN IF NOT EXISTS lead_id TEXT;
