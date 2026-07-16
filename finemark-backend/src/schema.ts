import { pgExec } from "./db.js";
import { syncRosterUserAccountIds } from "./services/identityService.js";

export const initSchema = async (): Promise<void> => {
  await pgExec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      force_password_reset INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await pgExec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_url TEXT`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  // login_method distinguishes which flow created the session — password / otp / azure —
  // so idle timeouts can be enforced independently per sign-in method.
  await pgExec(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS login_method TEXT NOT NULL DEFAULT 'password'`);
  await pgExec(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_activity_at TEXT`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      customer TEXT NOT NULL,
      location TEXT NOT NULL,
      status TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      customer_phone TEXT,
      customer_email TEXT,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_records_created_at ON crm_records(created_at)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_records_type ON crm_records(type)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_records_status ON crm_records(status)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_records_owner_email ON crm_records(owner_email)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS installation_jobs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      location TEXT NOT NULL,
      scheduled_date TEXT,
      assigned_technician_id TEXT,
      assigned_technician_email TEXT,
      status TEXT NOT NULL,
      job_details_json TEXT NOT NULL DEFAULT '{}',
      job_card_json TEXT NOT NULL DEFAULT '{}',
      confirmation_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await pgExec(`CREATE INDEX IF NOT EXISTS idx_installation_jobs_status ON installation_jobs(status)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_installation_jobs_request_id ON installation_jobs(request_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_installation_jobs_assigned_technician_id ON installation_jobs(assigned_technician_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_installation_jobs_created_at ON installation_jobs(created_at)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS otp_verifications (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS login_otp_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      target_email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_lot_user ON login_otp_tokens(user_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      user_id TEXT,
      user_email TEXT,
      role TEXT,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      severity TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    )
  `);
  // Parsed from user_agent + a geo-IP lookup at write time, so the log stays
  // readable even if the IP later resolves differently or geoip data updates.
  await pgExec(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS browser TEXT`);
  await pgExec(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS os TEXT`);
  await pgExec(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS device_type TEXT`);
  await pgExec(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS city TEXT`);
  await pgExec(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS region TEXT`);
  await pgExec(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS country TEXT`);

  await pgExec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON audit_logs(severity)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_email ON audit_logs(user_email)`);

  // ── Performance indexes ─────────────────────────────────────────────────
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_it_status       ON installation_tickets(status)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_it_customer_id  ON installation_tickets(customer_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_it_created_at   ON installation_tickets(created_at DESC)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_it_deleted_at   ON installation_tickets(deleted_at)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_it_assigned_to  ON installation_tickets(assigned_to_user_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_it_vi_install   ON installation_tickets(vi_installation_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_refresh_user_id ON refresh_tokens(user_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_emp_job_role ON hr_employees(job_role_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_emp_cadre    ON hr_employees(cadre_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_partner_sess_user ON partner_sessions(partner_user_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_partner_otp_user  ON partner_otp(partner_user_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      crm_record_id TEXT,
      customer TEXT NOT NULL,
      representative TEXT,
      vat_mode TEXT,
      tax_date TEXT,
      job_card_no TEXT,
      pin_no TEXT,
      subtotal DOUBLE PRECISION,
      vat_total DOUBLE PRECISION,
      total DOUBLE PRECISION,
      payment_paybill TEXT,
      payment_account_hint TEXT,
      bank_name TEXT,
      bank_account_no TEXT,
      amount DOUBLE PRECISION NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KES',
      status TEXT NOT NULL,
      issued_on TEXT NOT NULL,
      due_on TEXT NOT NULL,
      bank TEXT,
      sales_person TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await pgExec(`CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_invoices_tax_date ON invoices(tax_date)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      item TEXT NOT NULL,
      description TEXT,
      qty DOUBLE PRECISION NOT NULL,
      rate DOUBLE PRECISION NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      vat DOUBLE PRECISION NOT NULL,
      FOREIGN KEY(invoice_id) REFERENCES invoices(id)
    )
  `);

  await pgExec(`CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      payment_ref TEXT UNIQUE NOT NULL,
      invoice_id TEXT NOT NULL,
      customer TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KES',
      method TEXT NOT NULL,
      bank TEXT,
      status TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS speed_governors (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      registration_number TEXT NOT NULL,
      model TEXT NOT NULL,
      device_type TEXT NOT NULL,
      technician_id TEXT NOT NULL,
      technician_name TEXT NOT NULL,
      technician_email TEXT NOT NULL,
      sales_person_id TEXT NOT NULL,
      sales_person_name TEXT NOT NULL,
      sales_person_email TEXT NOT NULL,
      comments TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await pgExec(`CREATE INDEX IF NOT EXISTS idx_speed_governors_created_at ON speed_governors(created_at)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_speed_governors_registration ON speed_governors(registration_number)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_speed_governors_device_type ON speed_governors(device_type)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_speed_governors_technician_id ON speed_governors(technician_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_speed_governors_sales_person_id ON speed_governors(sales_person_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS certificates (
      id TEXT PRIMARY KEY,
      serial_no TEXT UNIQUE NOT NULL,
      system_type TEXT NOT NULL,
      car_registration TEXT NOT NULL,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      phone TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      loan_duration_years DOUBLE PRECISION NOT NULL,
      imei_1 TEXT NOT NULL,
      imei_2 TEXT,
      tracker_no_1 TEXT NOT NULL,
      tracker_no_2 TEXT,
      pdf_base64 TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS additional_devices_json TEXT`);
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS chassis_number TEXT`);
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS engine_number TEXT`);
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS partner_bank TEXT`);
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS printed_by_user_id TEXT`);
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS printed_by_name TEXT`);
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS printed_by_signature_url TEXT`);
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS authorized_by_name TEXT`);
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS authorized_by_role TEXT`);
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS authorized_by_signature_url TEXT`);
  // "finemark" | "unique" — which certificate template/paper this record was generated on.
  await pgExec(`ALTER TABLE certificates ADD COLUMN IF NOT EXISTS template TEXT NOT NULL DEFAULT 'finemark'`);
  // The Unique Tracking template only requires Registration — every other
  // field (including model, on both templates — vehicle make/model may not
  // be known yet) must accept NULL so those certificates can be saved without them.
  await pgExec(`ALTER TABLE certificates ALTER COLUMN model DROP NOT NULL`);
  await pgExec(`ALTER TABLE certificates ALTER COLUMN system_type DROP NOT NULL`);
  await pgExec(`ALTER TABLE certificates ALTER COLUMN date DROP NOT NULL`);
  await pgExec(`ALTER TABLE certificates ALTER COLUMN name DROP NOT NULL`);
  await pgExec(`ALTER TABLE certificates ALTER COLUMN phone DROP NOT NULL`);
  await pgExec(`ALTER TABLE certificates ALTER COLUMN start_date DROP NOT NULL`);
  await pgExec(`ALTER TABLE certificates ALTER COLUMN end_date DROP NOT NULL`);
  await pgExec(`ALTER TABLE certificates ALTER COLUMN loan_duration_years DROP NOT NULL`);
  await pgExec(`ALTER TABLE certificates ALTER COLUMN imei_1 DROP NOT NULL`);
  await pgExec(`ALTER TABLE certificates ALTER COLUMN tracker_no_1 DROP NOT NULL`);

  await pgExec(`CREATE INDEX IF NOT EXISTS idx_certificates_created_at ON certificates(created_at)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_certificates_serial_no ON certificates(serial_no)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_certificates_registration ON certificates(car_registration)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_certificates_name ON certificates(name)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_certificates_phone ON certificates(phone)`);

  // Admin-managed designated signatories (COO/CEO) whose name + signature PNG
  // are printed in the certificate's "Authorised By" section. Exactly one row
  // per role_title should have is_active = true at a time — the currently
  // active one is what gets pulled onto newly generated certificates.
  await pgExec(`
    CREATE TABLE IF NOT EXISTS cert_signatories (
      id TEXT PRIMARY KEY,
      role_title TEXT NOT NULL,
      full_name TEXT NOT NULL,
      signature_url TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_cert_signatories_role ON cert_signatories(role_title)`);

  // Admin-managed per-bank certificate policy — which template a bank's
  // certificates print on, and which fields that bank's paper has room for.
  // Drives create-certificate.html's category auto-detect so Admins can add
  // a new financing partner without a code change. One row has is_default =
  // true (the "Others" catch-all) and can never be deleted, only edited.
  await pgExec(`
    CREATE TABLE IF NOT EXISTS cert_bank_configs (
      id TEXT PRIMARY KEY,
      bank_name TEXT NOT NULL UNIQUE,
      template TEXT NOT NULL DEFAULT 'finemark',
      show_chassis BOOLEAN NOT NULL DEFAULT false,
      show_engine BOOLEAN NOT NULL DEFAULT false,
      show_imei BOOLEAN NOT NULL DEFAULT true,
      show_tracker BOOLEAN NOT NULL DEFAULT true,
      max_imei INTEGER NOT NULL DEFAULT 2,
      max_tracker INTEGER NOT NULL DEFAULT 2,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_default BOOLEAN NOT NULL DEFAULT false,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_cert_bank_configs_name ON cert_bank_configs(bank_name)`);
  // full_name added below (Full legal/display name — shown in the Partner/
  // Bank dropdown on create-certificate.html and printed on the certificate
  // itself, distinct from bank_name, the short matching key) — included
  // directly in this INSERT's column list since the column is NOT NULL:
  // `ON CONFLICT DO NOTHING` only skips a row AFTER it passes NOT NULL
  // validation, so omitting a NOT NULL column here would fail this INSERT
  // (and crash every subsequent boot) even for rows that already exist.
  await pgExec(`ALTER TABLE cert_bank_configs ADD COLUMN IF NOT EXISTS full_name TEXT`);
  await pgExec(`
    INSERT INTO cert_bank_configs (id, bank_name, full_name, template, show_chassis, show_engine, show_imei, show_tracker, max_imei, max_tracker, sort_order, is_default, created_at, updated_at)
    VALUES
      (gen_random_uuid()::text, 'TOWER',       'Tower Sacco',                'finemark', false, false, true,  true,  2, 2, 10, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'SIDIAN',      'Sidian Bank',                'finemark', false, false, true,  true,  2, 2, 20, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'SMEP',        'SMEP Microfinance Bank',     'finemark', false, false, true,  true,  2, 1, 30, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'PRIVATE',     'Private / Individual',       'finemark', false, false, true,  true,  2, 2, 40, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'COOPERATIVE', 'Co-operative Bank of Kenya', 'finemark', true,  true,  true,  true,  2, 2, 50, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'DTB',         'Diamond Trust Bank (DTB)',   'finemark', true,  true,  true,  true,  2, 1, 60, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'NCBA',        'NCBA Bank Kenya PLC',        'finemark', true,  true,  true,  true,  2, 2, 70, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'STANBIC',     'Stanbic Bank Kenya',         'finemark', true,  true,  true,  true,  2, 2, 80, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'EQUITY',      'Equity Bank',                'unique',   false, false, false, false, 0, 0, 90, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'MHASIBU',     'Mhasibu Sacco',              'unique',   false, false, false, false, 0, 0, 100, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'NRS',         'NRS Sacco',                  'unique',   false, false, false, false, 0, 0, 110, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'MUUNGANO',    'Muungano Sacco',             'unique',   false, false, false, false, 0, 0, 120, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'NATIONAL',    'National Sacco',             'unique',   false, false, false, false, 0, 0, 130, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'VERONA',      'Verona Sacco',               'unique',   false, false, false, false, 0, 0, 140, false, NOW()::text, NOW()::text),
      (gen_random_uuid()::text, 'Others',      'Other / Not Listed',         'unique',   false, false, false, false, 0, 0, 999, true,  NOW()::text, NOW()::text)
    ON CONFLICT (bank_name) DO NOTHING
  `);

  // Backfill safety net for any row that predates full_name (e.g. was
  // inserted by an older boot before this column existed).
  await pgExec(`
    UPDATE cert_bank_configs SET full_name = CASE bank_name
      WHEN 'TOWER'       THEN 'Tower Sacco'
      WHEN 'SIDIAN'      THEN 'Sidian Bank'
      WHEN 'SMEP'        THEN 'SMEP Microfinance Bank'
      WHEN 'PRIVATE'     THEN 'Private / Individual'
      WHEN 'COOPERATIVE' THEN 'Co-operative Bank of Kenya'
      WHEN 'DTB'         THEN 'Diamond Trust Bank (DTB)'
      WHEN 'NCBA'        THEN 'NCBA Bank Kenya PLC'
      WHEN 'STANBIC'     THEN 'Stanbic Bank Kenya'
      WHEN 'EQUITY'      THEN 'Equity Bank'
      WHEN 'MHASIBU'     THEN 'Mhasibu Sacco'
      WHEN 'NRS'         THEN 'NRS Sacco'
      WHEN 'MUUNGANO'    THEN 'Muungano Sacco'
      WHEN 'NATIONAL'    THEN 'National Sacco'
      WHEN 'VERONA'      THEN 'Verona Sacco'
      WHEN 'Others'      THEN 'Other / Not Listed'
      ELSE bank_name
    END
    WHERE full_name IS NULL
  `);
  await pgExec(`ALTER TABLE cert_bank_configs ALTER COLUMN full_name SET NOT NULL`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS sales_transactions (
      id TEXT PRIMARY KEY,
      sale_id TEXT UNIQUE NOT NULL,
      sale_date TEXT NOT NULL,
      sales_person TEXT NOT NULL,
      bank TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      vehicle_plate TEXT NOT NULL,
      vehicle_model TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KES',
      payment_status TEXT NOT NULL,
      invoice_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // ── HR Module ──────────────────────────────────────────────────────────────
  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_org_units (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_id TEXT,
      head_employee_id TEXT,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(parent_id) REFERENCES hr_org_units(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_org_units_parent ON hr_org_units(parent_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_job_roles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      responsibilities TEXT,
      grade_level TEXT,
      salary_band_min REAL,
      salary_band_max REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_cadres (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_benefit_plans (
      id TEXT PRIMARY KEY,
      cadre_id TEXT,
      name TEXT NOT NULL,
      annual_leave_days INTEGER NOT NULL DEFAULT 0,
      sick_leave_days INTEGER NOT NULL DEFAULT 0,
      medical_cover TEXT,
      pension TEXT,
      other_benefits TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(cadre_id) REFERENCES hr_cadres(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_benefit_plans_cadre ON hr_benefit_plans(cadre_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_employees (
      id TEXT PRIMARY KEY,
      employee_no TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      national_id TEXT,
      kra_pin TEXT,
      date_of_birth TEXT,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      residential_address TEXT,
      job_role_id TEXT,
      org_unit_id TEXT,
      manager_id TEXT,
      cadre_id TEXT,
      benefit_plan_id TEXT,
      employment_type TEXT NOT NULL,
      start_date TEXT NOT NULL,
      salary REAL,
      status TEXT NOT NULL DEFAULT 'Active',
      privacy_notice_acknowledged INTEGER NOT NULL DEFAULT 0,
      emergency_contact_consent INTEGER NOT NULL DEFAULT 0,
      user_account_id TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(job_role_id) REFERENCES hr_job_roles(id),
      FOREIGN KEY(org_unit_id) REFERENCES hr_org_units(id),
      FOREIGN KEY(manager_id) REFERENCES hr_employees(id),
      FOREIGN KEY(cadre_id) REFERENCES hr_cadres(id),
      FOREIGN KEY(benefit_plan_id) REFERENCES hr_benefit_plans(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_employees_status ON hr_employees(status)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_employees_org_unit ON hr_employees(org_unit_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_employees_manager ON hr_employees(manager_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_employees_created ON hr_employees(created_at)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_emergency_contacts (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      name TEXT NOT NULL,
      relationship TEXT NOT NULL,
      phone TEXT NOT NULL,
      consent_given INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(employee_id) REFERENCES hr_employees(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_emergency_contacts_emp ON hr_emergency_contacts(employee_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_documents (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      document_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_base64 TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(employee_id) REFERENCES hr_employees(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_documents_emp ON hr_documents(employee_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_promotion_history (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      from_role_id TEXT,
      to_role_id TEXT NOT NULL,
      from_cadre_id TEXT,
      to_cadre_id TEXT,
      effective_date TEXT NOT NULL,
      notes TEXT,
      recorded_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(employee_id) REFERENCES hr_employees(id),
      FOREIGN KEY(to_role_id) REFERENCES hr_job_roles(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_promotion_emp ON hr_promotion_history(employee_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_training_records (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      course_name TEXT NOT NULL,
      provider TEXT,
      completion_date TEXT NOT NULL,
      certification_no TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(employee_id) REFERENCES hr_employees(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_training_emp ON hr_training_records(employee_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_performance_records (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      review_cycle TEXT NOT NULL,
      review_date TEXT NOT NULL,
      rating TEXT NOT NULL,
      goals TEXT,
      comments TEXT,
      outcomes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(employee_id) REFERENCES hr_employees(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_performance_emp ON hr_performance_records(employee_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_performance_reviewer ON hr_performance_records(reviewer_id)`);

  // ── LEAVE MANAGEMENT ──────────────────────────────────────────────────────
  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_leave_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      statutory INTEGER NOT NULL DEFAULT 0,
      gender_restricted TEXT,
      max_days_per_year REAL,
      entitlement_model TEXT NOT NULL DEFAULT 'fixed',
      carry_forward_allowed INTEGER NOT NULL DEFAULT 0,
      carry_forward_cap REAL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_leave_entitlements (
      id TEXT PRIMARY KEY,
      leave_type_id TEXT NOT NULL,
      cadre_id TEXT,
      days_per_year REAL NOT NULL,
      accrual_rate REAL,
      min_service_days INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(leave_type_id) REFERENCES hr_leave_types(id),
      FOREIGN KEY(cadre_id) REFERENCES hr_cadres(id)
    )
  `);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_leave_balances (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      leave_type_id TEXT NOT NULL,
      balance_year INTEGER NOT NULL,
      entitled_days REAL NOT NULL DEFAULT 0,
      accrued_days REAL NOT NULL DEFAULT 0,
      used_days REAL NOT NULL DEFAULT 0,
      pending_days REAL NOT NULL DEFAULT 0,
      carried_forward REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(employee_id, leave_type_id, balance_year),
      FOREIGN KEY(employee_id) REFERENCES hr_employees(id),
      FOREIGN KEY(leave_type_id) REFERENCES hr_leave_types(id)
    )
  `);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_leave_applications (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      leave_type_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      total_days REAL NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      applied_date TEXT NOT NULL,
      level1_approver_id TEXT,
      level1_action TEXT,
      level1_date TEXT,
      level2_approver_id TEXT,
      level2_action TEXT,
      level2_date TEXT,
      hr_override_by TEXT,
      hr_override_date TEXT,
      rejection_reason TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(employee_id) REFERENCES hr_employees(id),
      FOREIGN KEY(leave_type_id) REFERENCES hr_leave_types(id)
    )
  `);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS hr_leave_approval_log (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      action TEXT NOT NULL,
      by_user_id TEXT NOT NULL,
      actor_name TEXT,
      approval_level INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(application_id) REFERENCES hr_leave_applications(id)
    )
  `);

  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_leave_balances_emp ON hr_leave_balances(employee_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_leave_balances_year ON hr_leave_balances(balance_year)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_leave_apps_emp ON hr_leave_applications(employee_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_leave_apps_status ON hr_leave_applications(status)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_leave_apps_dates ON hr_leave_applications(start_date, end_date)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_hr_leave_approval_log_app ON hr_leave_approval_log(application_id)`);
  // ── Migrations: add segments column if missing ─────────────────────────────
  await pgExec(`ALTER TABLE hr_leave_applications ADD COLUMN IF NOT EXISTS segments TEXT`);

  // ── CRM CUSTOMERS ──────────────────────────────────────────────────────────
  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_customers (
      id TEXT PRIMARY KEY,
      account_no TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('individual','corporate')),
      status TEXT NOT NULL DEFAULT 'Active',
      account_manager_id TEXT,
      region TEXT,
      source TEXT,
      notes TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_customers_type ON crm_customers(type)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_customers_status ON crm_customers(status)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_customers_account_manager ON crm_customers(account_manager_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_customers_created ON crm_customers(created_at)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_individual_profiles (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      full_name_enc TEXT,
      national_id_enc TEXT,
      passport_no_enc TEXT,
      kra_pin_enc TEXT,
      phone_enc TEXT NOT NULL,
      email_enc TEXT,
      address_enc TEXT,
      industry TEXT,
      date_of_birth TEXT,
      gender TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES crm_customers(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_individual_customer ON crm_individual_profiles(customer_id)`);
  // phone_enc was NOT NULL — broke converting any lead captured with email only
  // (no phone), a case the corporate lead redesign explicitly needs to support.
  // Live-tested and confirmed via POST /crm/leads/:id/convert before this fix.
  await pgExec(`ALTER TABLE crm_individual_profiles ALTER COLUMN phone_enc DROP NOT NULL`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_corporate_profiles (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      reg_number_enc TEXT,
      kra_pin_enc TEXT,
      industry TEXT,
      physical_address TEXT,
      website TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES crm_customers(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_corporate_customer ON crm_corporate_profiles(customer_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_contact_persons (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role_label TEXT,
      phone_enc TEXT,
      email_enc TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      is_billing INTEGER NOT NULL DEFAULT 0,
      is_operations INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES crm_customers(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_contacts_customer ON crm_contact_persons(customer_id)`);
  // ── Migrations: add concierge columns to contact persons ─────────────────
  await pgExec(`ALTER TABLE crm_contact_persons ADD COLUMN IF NOT EXISTS is_concierge INTEGER NOT NULL DEFAULT 0`);
  await pgExec(`ALTER TABLE crm_contact_persons ADD COLUMN IF NOT EXISTS self_nominated_at TEXT`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_subscriptions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      start_date TEXT NOT NULL,
      end_date TEXT,
      monthly_fee REAL,
      currency TEXT NOT NULL DEFAULT 'KES',
      linked_installation_id TEXT,
      linked_certificate_id TEXT,
      renewal_reminder_days INTEGER NOT NULL DEFAULT 30,
      notes TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES crm_customers(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_subs_customer ON crm_subscriptions(customer_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_subs_status ON crm_subscriptions(status)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_subs_end_date ON crm_subscriptions(end_date)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_devices (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      imei TEXT,
      serial_no TEXT,
      device_type TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      linked_certificate_id TEXT,
      linked_installation_id TEXT,
      installed_at TEXT,
      location TEXT,
      notes TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES crm_customers(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_devices_customer ON crm_devices(customer_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_devices_imei ON crm_devices(imei)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_devices_status ON crm_devices(status)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_tickets (
      id TEXT PRIMARY KEY,
      ticket_no TEXT UNIQUE NOT NULL,
      customer_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'General',
      priority TEXT NOT NULL DEFAULT 'Normal',
      status TEXT NOT NULL DEFAULT 'Open',
      assigned_to_user_id TEXT,
      sla_hours INTEGER NOT NULL DEFAULT 24,
      sla_breach_at TEXT,
      opened_at TEXT NOT NULL,
      resolved_at TEXT,
      closed_at TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES crm_customers(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_tickets_customer ON crm_tickets(customer_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_tickets_status ON crm_tickets(status)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_tickets_assigned ON crm_tickets(assigned_to_user_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_tickets_opened ON crm_tickets(opened_at)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_ticket_actions (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      comment TEXT,
      new_status TEXT,
      by_user_id TEXT NOT NULL,
      by_user_email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(ticket_id) REFERENCES crm_tickets(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_ticket_actions_ticket ON crm_ticket_actions(ticket_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_communication_logs (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'Outbound',
      subject TEXT,
      body_enc TEXT,
      by_user_id TEXT NOT NULL,
      by_user_email TEXT NOT NULL,
      contact_name TEXT,
      contacted_at TEXT NOT NULL,
      linked_ticket_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES crm_customers(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_comms_customer ON crm_communication_logs(customer_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_comms_contacted ON crm_communication_logs(contacted_at)`);
  // ── Add columns introduced in later migrations ──────────────────────────────
  await pgExec(`ALTER TABLE crm_communication_logs ADD COLUMN IF NOT EXISTS external_id TEXT`);
  await pgExec(`ALTER TABLE crm_communication_logs ADD COLUMN IF NOT EXISTS mailbox TEXT`);
  await pgExec(`ALTER TABLE crm_communication_logs ADD COLUMN IF NOT EXISTS metadata_json TEXT`);
  await pgExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_comms_external ON crm_communication_logs(external_id) WHERE external_id IS NOT NULL`);

  // ── Email sync state ─────────────────────────────────────────────────────────
  await pgExec(`
    CREATE TABLE IF NOT EXISTS email_sync_state (
      mailbox TEXT PRIMARY KEY,
      last_synced_at TEXT,
      last_delta_link TEXT
    )
  `);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'Upsell',
      segment_criteria_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'Draft',
      start_date TEXT,
      end_date TEXT,
      target_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_campaigns_status ON crm_campaigns(status)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_campaigns_type ON crm_campaigns(type)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_campaign_members (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      sent_at TEXT,
      outcome TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(campaign_id, customer_id),
      FOREIGN KEY(campaign_id) REFERENCES crm_campaigns(id),
      FOREIGN KEY(customer_id) REFERENCES crm_customers(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_campaign_members_campaign ON crm_campaign_members(campaign_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_campaign_members_customer ON crm_campaign_members(customer_id)`);

  await pgExec(`
    CREATE TABLE IF NOT EXISTS crm_customer_users (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'Individual',
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES crm_customers(id)
    )
  `);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_cust_users_customer ON crm_customer_users(customer_id)`);
  await pgExec(`CREATE INDEX IF NOT EXISTS idx_crm_cust_users_email ON crm_customer_users(email)`);

  // ── Late-added columns ────────────────────────────────────────────────────────
  await pgExec(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS work_email TEXT`);
  await pgExec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_employees_work_email ON hr_employees(work_email) WHERE work_email IS NOT NULL`);

  // ── Technical Team Roster ────────────────────────────────────────────────────
  await pgExec(`
    CREATE TABLE IF NOT EXISTS technical_team_roster (
      id               TEXT PRIMARY KEY,
      member_type      TEXT NOT NULL DEFAULT 'Technician',
      display_name     TEXT NOT NULL,
      email            TEXT,
      phone            TEXT,
      user_account_id  TEXT,
      hr_employee_id   TEXT,
      duty_status      TEXT NOT NULL DEFAULT 'Active',
      notes            TEXT,
      added_by         TEXT,
      added_at         TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      updated_at       TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )
  `);
  await pgExec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_user   ON technical_team_roster(user_account_id) WHERE user_account_id IS NOT NULL`);
  await pgExec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_hr_emp ON technical_team_roster(hr_employee_id)   WHERE hr_employee_id  IS NOT NULL`);

  // ── v_person_identity view ──────────────────────────────────────────────────
  // Unified read-only view mapping every ERP user to their HR record and roster
  // entry. Always grounded in users.id as the canonical identifier.
  // Use this view in queries that need cross-space identity resolution.
  await pgExec(`
    CREATE OR REPLACE VIEW v_person_identity AS
    SELECT
      u.id                                              AS user_id,
      COALESCE(u.name, e.full_name)                     AS display_name,
      u.email                                           AS login_email,
      u.role                                            AS erp_role,
      u.status                                          AS account_status,
      e.id                                              AS hr_employee_id,
      e.employee_no,
      e.full_name                                       AS hr_full_name,
      r.id                                              AS roster_id,
      r.member_type                                     AS roster_member_type,
      r.duty_status                                     AS roster_duty_status
    FROM users u
    LEFT JOIN hr_employees          e ON e.user_account_id = u.id
    LEFT JOIN technical_team_roster r ON r.user_account_id = u.id
                                      OR (r.hr_employee_id = e.id AND r.user_account_id IS NULL)
  `);

  // Run idempotent identity reconciliation on every startup
  await syncRosterUserAccountIds().catch(() => {});

  // ── bank_accounts ────────────────────────────────────────────────────────────
  await pgExec(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      account_name    TEXT NOT NULL,
      bank_name       TEXT NOT NULL,
      account_number  TEXT UNIQUE NOT NULL,
      branch          TEXT,
      account_type    TEXT NOT NULL DEFAULT 'Current',
      currency        TEXT NOT NULL DEFAULT 'KES',
      opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
      current_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
      is_active       BOOLEAN NOT NULL DEFAULT true,
      notes           TEXT,
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // ── db_backup_logs ───────────────────────────────────────────────────────────
  await pgExec(`
    CREATE TABLE IF NOT EXISTS db_backup_logs (
      id              TEXT PRIMARY KEY,
      env             TEXT NOT NULL CHECK (env IN ('prod','dev')),
      status          TEXT NOT NULL CHECK (status IN ('success','failed')),
      filename        TEXT NOT NULL,
      sharepoint_url  TEXT,
      error_message   TEXT,
      triggered_by    TEXT NOT NULL DEFAULT 'system',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // ── db_backup_schedule ───────────────────────────────────────────────────────
  await pgExec(`
    CREATE TABLE IF NOT EXISTS db_backup_schedule (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      enabled     INTEGER NOT NULL DEFAULT 0,
      cron_expr   TEXT    NOT NULL DEFAULT '0 2 * * *',
      label       TEXT    NOT NULL DEFAULT 'Daily at 2:00 AM',
      updated_at  TEXT    NOT NULL DEFAULT now()::text,
      updated_by  TEXT    NOT NULL DEFAULT 'system'
    )
  `);

  // ── session_timeout_settings ─────────────────────────────────────────────────
  // Single-row config: idle timeout (minutes) enforced per sign-in method.
  await pgExec(`
    CREATE TABLE IF NOT EXISTS session_timeout_settings (
      id                    INTEGER PRIMARY KEY DEFAULT 1,
      password_idle_minutes INTEGER NOT NULL DEFAULT 30,
      otp_idle_minutes      INTEGER NOT NULL DEFAULT 30,
      azure_idle_minutes    INTEGER NOT NULL DEFAULT 30,
      updated_at            TEXT    NOT NULL DEFAULT now()::text,
      updated_by            TEXT    NOT NULL DEFAULT 'system'
    )
  `);

  console.log("PostgreSQL schema initialised");
};
