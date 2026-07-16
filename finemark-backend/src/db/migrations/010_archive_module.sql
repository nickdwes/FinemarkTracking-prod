-- Archive module — read-only historical data migrated from the legacy IDTS system
-- (installation.finemarktracking.co.ke / idts_mysql). Lives in its own database
-- (finemark_archive), never joined against live CRM tables. One-time load, not
-- an ongoing sync — see archiveEtl.ts.

CREATE TABLE IF NOT EXISTS archive_banks (
  id TEXT PRIMARY KEY,
  canonical_name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS archive_installations (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  installation_date DATE,
  installation_date_raw TEXT,
  client_name TEXT,
  sales_person TEXT,
  vehicle_reg TEXT,
  model TEXT,
  tracker_number TEXT,
  contact TEXT,
  bank_id TEXT REFERENCES archive_banks(id),
  bank_raw TEXT,
  bank_branch TEXT,
  tracker_location TEXT,
  technician TEXT,
  tk_status TEXT,
  tracksolid TEXT,
  username TEXT,
  password TEXT,
  loan_duration TEXT,
  c_no TEXT,
  expiry_date DATE,
  expiry_date_raw TEXT,
  imei TEXT,
  logins_confirm TEXT,
  telesales_comment TEXT,
  commented_by TEXT,
  updated_by TEXT,
  uploaded_by TEXT,
  amount_quoted NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_arch_inst_vehicle ON archive_installations(vehicle_reg);
CREATE INDEX IF NOT EXISTS idx_arch_inst_client ON archive_installations(client_name);
CREATE INDEX IF NOT EXISTS idx_arch_inst_imei ON archive_installations(imei);
CREATE INDEX IF NOT EXISTS idx_arch_inst_contact ON archive_installations(contact);
CREATE INDEX IF NOT EXISTS idx_arch_inst_tracker ON archive_installations(tracker_number);
CREATE INDEX IF NOT EXISTS idx_arch_inst_sales_person ON archive_installations(sales_person);
CREATE INDEX IF NOT EXISTS idx_arch_inst_technician ON archive_installations(technician);
CREATE INDEX IF NOT EXISTS idx_arch_inst_install_date ON archive_installations(installation_date);
CREATE INDEX IF NOT EXISTS idx_arch_inst_expiry_date ON archive_installations(expiry_date);
CREATE INDEX IF NOT EXISTS idx_arch_inst_bank ON archive_installations(bank_id);

-- Legacy fine_mark_renewals rows reuse the SOURCE record10.ID as their own id
-- (not an independent auto-increment) — search.php's isRenewed() checks
-- `WHERE ID = <record10 id>`. Preserved as-is via installation_legacy_id.
CREATE TABLE IF NOT EXISTS archive_renewals (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  installation_legacy_id INTEGER NOT NULL,
  vehicle_reg TEXT,
  client_name TEXT,
  renewal_date TIMESTAMPTZ,
  renewal_duration_years INTEGER,
  amount_paid NUMERIC(12,2) DEFAULT 0,
  sales_person TEXT,
  expiry_date DATE,
  expiry_date_raw TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_arch_renew_inst ON archive_renewals(installation_legacy_id);

CREATE TABLE IF NOT EXISTS archive_gadgets (
  imei TEXT PRIMARY KEY,
  batch TEXT,
  gadget_type TEXT,
  price NUMERIC(12,2),
  imsi TEXT,
  arrival_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_arch_gadgets_batch ON archive_gadgets(batch);
CREATE INDEX IF NOT EXISTS idx_arch_gadgets_imsi ON archive_gadgets(imsi);

CREATE TABLE IF NOT EXISTS archive_sims (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  msisdn TEXT,
  imsi TEXT,
  batch TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_arch_sims_msisdn ON archive_sims(msisdn);
CREATE INDEX IF NOT EXISTS idx_arch_sims_batch ON archive_sims(batch);

CREATE TABLE IF NOT EXISTS archive_technician_allocations (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  gadget_imei TEXT,
  gadget_type TEXT,
  date_of_allocation TIMESTAMPTZ,
  technician TEXT,
  imsi TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_arch_tech_alloc_technician ON archive_technician_allocations(technician);
CREATE INDEX IF NOT EXISTS idx_arch_tech_alloc_imei ON archive_technician_allocations(gadget_imei);

CREATE TABLE IF NOT EXISTS archive_invoices (
  invoice_no TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  rep TEXT,
  invoice_date DATE,
  vat_mode TEXT,
  subtotal NUMERIC(12,2) DEFAULT 0,
  tax NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  file_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS archive_invoice_items (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE,
  invoice_no TEXT REFERENCES archive_invoices(invoice_no),
  item TEXT,
  description TEXT,
  quantity NUMERIC(12,2),
  rate NUMERIC(12,2),
  amount NUMERIC(12,2),
  vat NUMERIC(6,2) DEFAULT 0,
  vat_amount NUMERIC(12,2) DEFAULT 0,
  description_select TEXT,
  description_custom TEXT,
  display_rate NUMERIC(12,2)
);
CREATE INDEX IF NOT EXISTS idx_arch_invoice_items_invoice ON archive_invoice_items(invoice_no);

CREATE TABLE IF NOT EXISTS archive_payments (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  payment_method TEXT,
  payment_amount NUMERIC(12,2),
  payment_date TIMESTAMPTZ,
  cheque_number TEXT,
  payment_status TEXT,
  bankers_commission NUMERIC(12,2) DEFAULT 0,
  sales_commission NUMERIC(12,2) DEFAULT 0,
  technician_commission NUMERIC(12,2) DEFAULT 0,
  gadget_price NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS archive_speedgovernors (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  installation_date DATE,
  client_name TEXT,
  contact TEXT,
  reg_no TEXT,
  model TEXT,
  device_type TEXT,
  technician TEXT,
  sales_person TEXT,
  comments TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS archive_tickets (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  ticket_number TEXT NOT NULL,
  client_phone TEXT,
  vehicle_reg TEXT,
  support_name TEXT,
  support_phone TEXT,
  ticket_reason TEXT,
  status TEXT,
  created_by TEXT,
  created_by_phone TEXT,
  created_date DATE,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  closed_by TEXT,
  action_taken TEXT,
  closed_at TIMESTAMPTZ,
  ticket_type TEXT
);
CREATE INDEX IF NOT EXISTS idx_arch_tickets_vehicle ON archive_tickets(vehicle_reg);
CREATE INDEX IF NOT EXISTS idx_arch_tickets_status ON archive_tickets(status);

CREATE TABLE IF NOT EXISTS archive_faulty_gadgets (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  old_imei TEXT NOT NULL,
  installation_date_raw TEXT,
  client_name TEXT,
  sales_person TEXT,
  vehicle_reg TEXT,
  model TEXT,
  tracker_number TEXT,
  contact TEXT,
  bank_raw TEXT,
  technician TEXT,
  loan_duration TEXT,
  c_no TEXT,
  expiry_raw TEXT,
  imei TEXT,
  bank_branch TEXT,
  tracker_location TEXT,
  faulty_date TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS archive_imei_swaps (
  id TEXT PRIMARY KEY,
  old_imei TEXT NOT NULL,
  new_imei TEXT NOT NULL,
  table_name TEXT,
  batch TEXT,
  change_timestamp TIMESTAMPTZ,
  CONSTRAINT uq_arch_imei_swap UNIQUE (old_imei, new_imei, change_timestamp)
);
CREATE INDEX IF NOT EXISTS idx_arch_imei_swap_old ON archive_imei_swaps(old_imei);

-- Added for the second migration pass (report §5 of the review) — fuel-tracking
-- installs, the record10 edit trail, and the soft-delete log, none of which
-- were needed by the first two flagship reports.
CREATE TABLE IF NOT EXISTS archive_fuel_records (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  installation_date DATE,
  client_name TEXT,
  contact TEXT,
  reg_no TEXT,
  model TEXT,
  device_type TEXT,
  tracker_no TEXT,
  technician TEXT,
  sales_person TEXT,
  comments TEXT,
  logins TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_arch_fuel_reg ON archive_fuel_records(reg_no);
CREATE INDEX IF NOT EXISTS idx_arch_fuel_tracker ON archive_fuel_records(tracker_no);

CREATE TABLE IF NOT EXISTS archive_record_audit (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  installation_legacy_id INTEGER,
  changed_by TEXT,
  changed_at TIMESTAMPTZ,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  action_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_arch_audit_inst ON archive_record_audit(installation_legacy_id);
CREATE INDEX IF NOT EXISTS idx_arch_audit_changed_at ON archive_record_audit(changed_at);

CREATE TABLE IF NOT EXISTS archive_removed_installations (
  id TEXT PRIMARY KEY,
  legacy_id INTEGER UNIQUE NOT NULL,
  original_legacy_id INTEGER NOT NULL,
  client_name TEXT,
  vehicle_reg TEXT,
  imei TEXT,
  installation_date_raw TEXT,
  deleted_by TEXT,
  deletion_date TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_arch_removed_deletion_date ON archive_removed_installations(deletion_date);

-- One row per ETL run, for verification/audit — source vs. loaded row counts per table.
CREATE TABLE IF NOT EXISTS archive_load_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  table_counts_json TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  notes TEXT
);
