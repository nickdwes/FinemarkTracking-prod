-- ============================================================
-- Migration 009: Partnership Module
-- ============================================================

-- Partner organizations
CREATE TABLE IF NOT EXISTS partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  business_reg_no TEXT,
  regions JSONB NOT NULL DEFAULT '["All"]',
  primary_contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  tier TEXT NOT NULL DEFAULT 'Standard',
  key_account_manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  contract_ref TEXT,
  contract_scope TEXT,
  contract_start DATE,
  contract_expiry DATE,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Partner contract documents
CREATE TABLE IF NOT EXISTS partner_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partner portal users (external, separate from system users)
CREATE TABLE IF NOT EXISTS partner_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'PartnerUser',
  status TEXT NOT NULL DEFAULT 'Active',
  notify_email BOOLEAN NOT NULL DEFAULT true,
  notify_sms BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(email)
);

-- Partner OTP for 2FA login
CREATE TABLE IF NOT EXISTS partner_otp (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_user_id UUID NOT NULL REFERENCES partner_users(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partner portal sessions
CREATE TABLE IF NOT EXISTS partner_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_user_id UUID NOT NULL REFERENCES partner_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partner-scoped audit log
CREATE TABLE IF NOT EXISTS partner_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT,
  user_role TEXT,
  partner_id UUID,
  source_ip TEXT,
  device_agent TEXT,
  module TEXT,
  record_id TEXT,
  action TEXT,
  previous_value TEXT,
  new_value TEXT
);

-- Extend vehicles: partner linkage + loan tenure
ALTER TABLE crm_customer_vehicles ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE SET NULL;
ALTER TABLE crm_customer_vehicles ADD COLUMN IF NOT EXISTS loan_tenure_months INTEGER;
ALTER TABLE crm_customer_vehicles ADD COLUMN IF NOT EXISTS loan_start_date DATE;

-- Extend leads: partner attribution
ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_partner_users_email ON partner_users(email);
CREATE INDEX IF NOT EXISTS idx_partner_users_partner ON partner_users(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_sessions_token ON partner_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_partner_sessions_expiry ON partner_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_partner_audit_partner ON partner_audit_logs(partner_id);
CREATE INDEX IF NOT EXISTS idx_crm_leads_partner ON crm_leads(partner_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_partner ON crm_customer_vehicles(partner_id);
