-- crm_customer_vehicles had no way to represent "not yet registered" — the
-- registration column was NOT NULL with no status flag, so retail-leads.ts
-- worked around it by writing the chassis number into the registration
-- field whenever a lead's vehicle had no real registration. That pollution
-- then propagated into installation_tickets and job-card.html's inference.
--
-- Fix: add an explicit registration_known flag and relax the NOT NULL
-- constraint. Default TRUE preserves the existing (correct) meaning for
-- every pre-existing row that already has a real registration.

ALTER TABLE crm_customer_vehicles ADD COLUMN IF NOT EXISTS registration_known BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE crm_customer_vehicles ALTER COLUMN registration DROP NOT NULL;

-- One-time cleanup of rows already polluted by the chassis-as-registration
-- workaround: registration exactly equal to chassis_number is the tell, BUT
-- a handful of those matches are a genuine Kenyan plate that also happens to
-- be duplicated into chassis_number (a different, separate data issue) —
-- excluding anything that actually looks like a valid plate (same KE_REG_RE
-- shape used by vehicles.ts/job-card.html/vehicle-register.html) leaves
-- those 2 rows untouched rather than wrongly nulling a real registration.
-- Null out the fabricated registration and mark the vehicle as not-yet-registered
-- — the real chassis number is untouched (it was already correctly stored
-- separately in chassis_number this whole time).
UPDATE crm_customer_vehicles
SET registration = NULL, registration_known = FALSE
WHERE registration IS NOT NULL
  AND chassis_number IS NOT NULL
  AND registration = chassis_number
  AND registration !~* '^(K[A-Z]{2}\s?[0-9]{3}[A-Z]|GK\s?[A-Z][0-9]{3}[A-Z]|CD\s?[0-9]{3}[A-Z]|[0-9]{2}\s?CD\s?[0-9]{2,4}[A-Z]|[0-9]{2}\s?UN\s?[0-9]{3,4}[A-Z])$';
