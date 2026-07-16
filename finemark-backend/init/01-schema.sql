--
-- PostgreSQL database dump
--

\restrict m8pjcpO9DbXnwY4bSgxxEd56TNVR28u5HRK5L3HLN4qLmLM9embY7utReH4kQFe

-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_notifications (
    id text NOT NULL,
    target_role text,
    target_user_id text,
    type text DEFAULT 'info'::text NOT NULL,
    title text NOT NULL,
    body text,
    link text,
    read boolean DEFAULT false NOT NULL,
    created_at text NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id text NOT NULL,
    "timestamp" text NOT NULL,
    user_id text,
    user_email text,
    role text,
    action text NOT NULL,
    target text NOT NULL,
    severity text NOT NULL,
    ip_address text,
    user_agent text,
    details_json text,
    created_at text NOT NULL
);


--
-- Name: certificates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.certificates (
    id text NOT NULL,
    serial_no text NOT NULL,
    system_type text NOT NULL,
    car_registration text NOT NULL,
    model text NOT NULL,
    date text NOT NULL,
    name text NOT NULL,
    color text,
    phone text NOT NULL,
    start_date text NOT NULL,
    end_date text NOT NULL,
    loan_duration_years double precision NOT NULL,
    imei_1 text NOT NULL,
    imei_2 text,
    tracker_no_1 text NOT NULL,
    tracker_no_2 text,
    pdf_base64 text NOT NULL,
    created_by_user_id text NOT NULL,
    created_by_email text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_campaign_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_campaign_members (
    id text NOT NULL,
    campaign_id text NOT NULL,
    customer_id text NOT NULL,
    status text DEFAULT 'Pending'::text NOT NULL,
    sent_at text,
    outcome text,
    notes text,
    created_at text NOT NULL
);


--
-- Name: crm_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_campaigns (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    type text DEFAULT 'Upsell'::text NOT NULL,
    segment_criteria_json text DEFAULT '{}'::text NOT NULL,
    status text DEFAULT 'Draft'::text NOT NULL,
    start_date text,
    end_date text,
    target_count integer DEFAULT 0 NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    created_by_user_id text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_communication_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_communication_logs (
    id text NOT NULL,
    customer_id text NOT NULL,
    channel text NOT NULL,
    direction text DEFAULT 'Outbound'::text NOT NULL,
    subject text,
    body_enc text,
    by_user_id text NOT NULL,
    by_user_email text NOT NULL,
    contact_name text,
    contacted_at text NOT NULL,
    linked_ticket_id text,
    created_at text NOT NULL,
    external_id text,
    mailbox text,
    metadata_json text
);


--
-- Name: crm_contact_persons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_contact_persons (
    id text NOT NULL,
    customer_id text NOT NULL,
    name text NOT NULL,
    role_label text,
    phone_enc text,
    email_enc text,
    is_primary integer DEFAULT 0 NOT NULL,
    is_billing integer DEFAULT 0 NOT NULL,
    is_operations integer DEFAULT 0 NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    is_concierge integer DEFAULT 0 NOT NULL,
    self_nominated_at text
);


--
-- Name: crm_corporate_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_corporate_profiles (
    id text NOT NULL,
    customer_id text NOT NULL,
    company_name text NOT NULL,
    reg_number_enc text,
    kra_pin_enc text,
    industry text,
    physical_address text,
    website text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_customer_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_customer_users (
    id text NOT NULL,
    customer_id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'Individual'::text NOT NULL,
    password_hash text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    last_login_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_customer_vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_customer_vehicles (
    id text DEFAULT gen_random_uuid() NOT NULL,
    customer_id text NOT NULL,
    registration character varying(50) NOT NULL,
    make character varying(100),
    model character varying(200),
    model_number character varying(100),
    body_type character varying(50),
    color character varying(50),
    year_of_manufacture integer,
    chassis_number character varying(100),
    engine_number character varying(100),
    notes text,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    loan_tenure_months integer,
    loan_start_date date,
    partner_id uuid
);


--
-- Name: crm_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_customers (
    id text NOT NULL,
    account_no text NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    account_manager_id text,
    region text,
    source text,
    notes text,
    created_by_user_id text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text,
    deleted_by text,
    affiliate_partner_id text,
    affiliate_partner_name text,
    CONSTRAINT crm_customers_type_check CHECK ((type = ANY (ARRAY['individual'::text, 'corporate'::text])))
);


--
-- Name: crm_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_devices (
    id text NOT NULL,
    customer_id text NOT NULL,
    imei text,
    serial_no text,
    device_type text NOT NULL,
    model text,
    status text DEFAULT 'Active'::text NOT NULL,
    linked_certificate_id text,
    linked_installation_id text,
    installed_at text,
    location text,
    notes text,
    created_by_user_id text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_gadget_stock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_gadget_stock (
    id text NOT NULL,
    device_model text NOT NULL,
    device_type text NOT NULL,
    serial_number text,
    imei text,
    sim_phone text,
    sim_serial text,
    warehouse_location text,
    status text DEFAULT 'Available'::text NOT NULL,
    reserved_for_quote_id text,
    assigned_to_installation_id text,
    assigned_by_user_id text,
    assigned_at text,
    issued_by_user_id text,
    issued_at text,
    received_at text,
    received_by_user_id text,
    notes text,
    batch_no text,
    deleted_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_individual_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_individual_profiles (
    id text NOT NULL,
    customer_id text NOT NULL,
    full_name text NOT NULL,
    full_name_enc text,
    national_id_enc text,
    passport_no_enc text,
    kra_pin_enc text,
    phone_enc text NOT NULL,
    email_enc text,
    address_enc text,
    industry text,
    date_of_birth text,
    gender text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_installation_surveys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_installation_surveys (
    id text NOT NULL,
    installation_id text NOT NULL,
    customer_id text NOT NULL,
    technician_id text,
    sales_rep_id text,
    survey_token text,
    survey_link_sent_at text,
    installation_rating integer,
    technician_rating integer,
    service_quality_rating integer,
    comments text,
    submitted_at text,
    submitted_channel text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text
);


--
-- Name: crm_lead_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_lead_conversations (
    id text NOT NULL,
    lead_id text NOT NULL,
    notes text NOT NULL,
    channel text DEFAULT 'Phone call'::text NOT NULL,
    interaction_date text NOT NULL,
    created_by_user_id text NOT NULL,
    created_by_name text,
    attachments text DEFAULT '[]'::text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_leads (
    id text NOT NULL,
    lead_no text NOT NULL,
    lead_source text NOT NULL,
    customer_type text DEFAULT 'new_customer'::text NOT NULL,
    service_requested text DEFAULT '[]'::text NOT NULL,
    sales_rep_id text NOT NULL,
    sales_rep_email text,
    lead_date text NOT NULL,
    lead_notes text,
    status text DEFAULT 'New'::text NOT NULL,
    customer_id text,
    customer_name text,
    email text,
    phone text,
    id_number text,
    company_name text,
    address text,
    account_manager_id text,
    converted_at text,
    converted_to_quote_id text,
    disqualified_reason text,
    created_by_user_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text,
    product_category_id text,
    product_category_name text,
    products_interested text DEFAULT '[]'::text NOT NULL,
    partner_id uuid,
    partner_name text,
    assigned_to_id text,
    assigned_to_email text,
    lead_owner_role text
);


--
-- Name: crm_proforma_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_proforma_invoices (
    id text NOT NULL,
    proforma_no text NOT NULL,
    customer_id text NOT NULL,
    quote_id text,
    lead_id text,
    sales_rep_id text,
    status text DEFAULT 'Draft'::text NOT NULL,
    installation_cost real DEFAULT 0 NOT NULL,
    subscription_fee real DEFAULT 0 NOT NULL,
    tax_rate real DEFAULT 0 NOT NULL,
    discount_amount real DEFAULT 0 NOT NULL,
    total_amount real DEFAULT 0 NOT NULL,
    notes text,
    approved_by text,
    approved_at text,
    rejected_by text,
    rejected_at text,
    rejected_reason text,
    converted_to_installation_id text,
    created_by_user_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text,
    invoice_id text
);


--
-- Name: crm_proforma_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_proforma_items (
    id text NOT NULL,
    proforma_id text NOT NULL,
    device_model text NOT NULL,
    device_type text,
    description text,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price real DEFAULT 0 NOT NULL,
    total_price real DEFAULT 0 NOT NULL,
    stock_item_id text,
    created_at text NOT NULL,
    stock_item_ids text DEFAULT '[]'::text NOT NULL,
    serial_numbers text DEFAULT '[]'::text NOT NULL,
    imei_numbers text DEFAULT '[]'::text NOT NULL
);


--
-- Name: crm_quote_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_quote_items (
    id text NOT NULL,
    quote_id text NOT NULL,
    device_model text NOT NULL,
    device_type text,
    description text,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price real DEFAULT 0 NOT NULL,
    total_price real DEFAULT 0 NOT NULL,
    stock_item_id text,
    created_at text NOT NULL,
    stock_item_ids text DEFAULT '[]'::text NOT NULL,
    serial_numbers text DEFAULT '[]'::text NOT NULL,
    imei_numbers text DEFAULT '[]'::text NOT NULL,
    product_id text
);


--
-- Name: crm_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_quotes (
    id text NOT NULL,
    quote_no text NOT NULL,
    customer_id text NOT NULL,
    lead_id text,
    sales_rep_id text NOT NULL,
    sales_rep_email text,
    service_type text,
    status text DEFAULT 'Draft'::text NOT NULL,
    revision_no integer DEFAULT 1 NOT NULL,
    parent_quote_id text,
    installation_cost real DEFAULT 0 NOT NULL,
    subscription_fee real DEFAULT 0 NOT NULL,
    tax_rate real DEFAULT 0 NOT NULL,
    discount_amount real DEFAULT 0 NOT NULL,
    total_amount real DEFAULT 0 NOT NULL,
    expiry_date text,
    notes text,
    approved_at text,
    approved_by text,
    rejected_reason text,
    created_by_user_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text
);


--
-- Name: crm_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_records (
    id text NOT NULL,
    type text NOT NULL,
    customer text NOT NULL,
    location text NOT NULL,
    status text NOT NULL,
    owner_email text NOT NULL,
    created_by_user_id text NOT NULL,
    customer_phone text,
    customer_email text,
    details_json text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_subscriptions (
    id text NOT NULL,
    customer_id text NOT NULL,
    service_type text NOT NULL,
    plan_name text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    start_date text NOT NULL,
    end_date text,
    monthly_fee real,
    currency text DEFAULT 'KES'::text NOT NULL,
    linked_installation_id text,
    linked_certificate_id text,
    renewal_reminder_days integer DEFAULT 30 NOT NULL,
    notes text,
    created_by_user_id text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: crm_ticket_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_ticket_actions (
    id text NOT NULL,
    ticket_id text NOT NULL,
    action_type text NOT NULL,
    comment text,
    new_status text,
    by_user_id text NOT NULL,
    by_user_email text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: crm_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_tickets (
    id text NOT NULL,
    ticket_no text NOT NULL,
    customer_id text NOT NULL,
    subject text NOT NULL,
    description text,
    category text DEFAULT 'General'::text NOT NULL,
    priority text DEFAULT 'Normal'::text NOT NULL,
    status text DEFAULT 'Open'::text NOT NULL,
    assigned_to_user_id text,
    sla_hours integer DEFAULT 24 NOT NULL,
    sla_breach_at text,
    opened_at text NOT NULL,
    resolved_at text,
    closed_at text,
    created_by_user_id text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    assigned_at text
);


--
-- Name: di_device_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.di_device_transfers (
    id text NOT NULL,
    device_id text NOT NULL,
    device_serial text,
    from_technician_id text NOT NULL,
    from_technician_email text,
    to_technician_id text NOT NULL,
    to_technician_email text,
    transfer_reason text,
    status text DEFAULT 'Pending'::text NOT NULL,
    initiated_by_user_id text NOT NULL,
    acknowledged_at text,
    rejection_reason text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: di_issuance_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.di_issuance_batches (
    id text NOT NULL,
    batch_ref text NOT NULL,
    technician_id text NOT NULL,
    technician_email text,
    clerk_user_id text NOT NULL,
    clerk_email text,
    device_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'Pending'::text NOT NULL,
    acknowledged_at text,
    rejection_reason text,
    notes text,
    issued_at text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: di_receive_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.di_receive_batches (
    id text NOT NULL,
    batch_ref text NOT NULL,
    supplier_name text,
    device_count integer DEFAULT 0 NOT NULL,
    received_by_user_id text NOT NULL,
    received_at text NOT NULL,
    notes text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: di_technician_custody_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.di_technician_custody_config (
    id text NOT NULL,
    technician_id text NOT NULL,
    technician_email text,
    region text,
    max_stock_level integer DEFAULT 10 NOT NULL,
    min_stock_level integer DEFAULT 2 NOT NULL,
    reorder_level integer DEFAULT 3 NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: di_tracker_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.di_tracker_devices (
    id text NOT NULL,
    receive_batch_id text,
    serial_number text NOT NULL,
    imei_enc text,
    sim_iccid_enc text,
    device_model text,
    inventory_status text DEFAULT 'InInventory'::text NOT NULL,
    inventory_location text,
    custodian_technician_id text,
    custodian_technician_email text,
    custodian_assigned_at text,
    issuance_batch_id text,
    job_id text,
    vehicle_id text,
    vehicle_registration text,
    notes text,
    created_by_user_id text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text
);


--
-- Name: email_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_sync_state (
    mailbox text NOT NULL,
    last_synced_at text,
    last_delta_link text
);


--
-- Name: hr_benefit_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_benefit_plans (
    id text NOT NULL,
    cadre_id text,
    name text NOT NULL,
    annual_leave_days integer DEFAULT 0 NOT NULL,
    sick_leave_days integer DEFAULT 0 NOT NULL,
    medical_cover text,
    pension text,
    other_benefits text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: hr_cadres; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_cadres (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    created_at text NOT NULL
);


--
-- Name: hr_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_documents (
    id text NOT NULL,
    employee_id text NOT NULL,
    document_type text NOT NULL,
    file_name text NOT NULL,
    file_base64 text NOT NULL,
    uploaded_by text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: hr_emergency_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_emergency_contacts (
    id text NOT NULL,
    employee_id text NOT NULL,
    name text NOT NULL,
    relationship text NOT NULL,
    phone text NOT NULL,
    consent_given integer DEFAULT 0 NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: hr_emp_no_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_emp_no_config (
    employment_type text NOT NULL,
    prefix text DEFAULT 'FM'::text NOT NULL,
    type_code text NOT NULL,
    padding integer DEFAULT 4 NOT NULL,
    updated_at text
);


--
-- Name: hr_employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_employees (
    id text NOT NULL,
    employee_no text NOT NULL,
    full_name text NOT NULL,
    national_id text,
    kra_pin text,
    date_of_birth text,
    phone text NOT NULL,
    email text NOT NULL,
    residential_address text,
    job_role_id text,
    org_unit_id text,
    manager_id text,
    cadre_id text,
    benefit_plan_id text,
    employment_type text NOT NULL,
    start_date text NOT NULL,
    salary real,
    status text DEFAULT 'Active'::text NOT NULL,
    privacy_notice_acknowledged integer DEFAULT 0 NOT NULL,
    emergency_contact_consent integer DEFAULT 0 NOT NULL,
    user_account_id text,
    created_by_user_id text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    personal_file_no text,
    work_email text
);


--
-- Name: hr_job_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_job_roles (
    id text NOT NULL,
    title text NOT NULL,
    description text,
    responsibilities text,
    grade_level text,
    salary_band_min real,
    salary_band_max real,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: hr_leave_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_leave_applications (
    id text NOT NULL,
    employee_id text NOT NULL,
    leave_type_id text NOT NULL,
    start_date text NOT NULL,
    end_date text NOT NULL,
    total_days real NOT NULL,
    reason text,
    status text DEFAULT 'Pending'::text NOT NULL,
    applied_date text NOT NULL,
    level1_approver_id text,
    level1_action text,
    level1_date text,
    level2_approver_id text,
    level2_action text,
    level2_date text,
    hr_override_by text,
    hr_override_date text,
    rejection_reason text,
    notes text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    segments text
);


--
-- Name: hr_leave_approval_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_leave_approval_log (
    id text NOT NULL,
    application_id text NOT NULL,
    action text NOT NULL,
    by_user_id text NOT NULL,
    actor_name text,
    approval_level integer DEFAULT 1 NOT NULL,
    notes text,
    created_at text NOT NULL
);


--
-- Name: hr_leave_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_leave_balances (
    id text NOT NULL,
    employee_id text NOT NULL,
    leave_type_id text NOT NULL,
    balance_year integer NOT NULL,
    entitled_days real DEFAULT 0 NOT NULL,
    accrued_days real DEFAULT 0 NOT NULL,
    used_days real DEFAULT 0 NOT NULL,
    pending_days real DEFAULT 0 NOT NULL,
    carried_forward real DEFAULT 0 NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: hr_leave_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_leave_entitlements (
    id text NOT NULL,
    leave_type_id text NOT NULL,
    cadre_id text,
    days_per_year real NOT NULL,
    accrual_rate real,
    min_service_days integer DEFAULT 0 NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: hr_leave_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_leave_types (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    statutory integer DEFAULT 0 NOT NULL,
    gender_restricted text,
    max_days_per_year real,
    entitlement_model text DEFAULT 'fixed'::text NOT NULL,
    carry_forward_allowed integer DEFAULT 0 NOT NULL,
    carry_forward_cap real,
    is_active integer DEFAULT 1 NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: hr_m365_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_m365_accounts (
    id text NOT NULL,
    employee_id text NOT NULL,
    upn text,
    entra_object_id text,
    account_status text DEFAULT 'Not Provisioned'::text NOT NULL,
    license_status text DEFAULT 'None'::text NOT NULL,
    license_sku text,
    provisioned_by text,
    provisioned_at text,
    graph_transaction_id text,
    last_synced_at text,
    notes text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: hr_org_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_org_units (
    id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    parent_id text,
    head_employee_id text,
    description text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: hr_performance_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_performance_records (
    id text NOT NULL,
    employee_id text NOT NULL,
    reviewer_id text NOT NULL,
    review_cycle text NOT NULL,
    review_date text NOT NULL,
    rating text NOT NULL,
    goals text,
    comments text,
    outcomes text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: hr_promotion_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_promotion_history (
    id text NOT NULL,
    employee_id text NOT NULL,
    from_role_id text,
    to_role_id text NOT NULL,
    from_cadre_id text,
    to_cadre_id text,
    effective_date text NOT NULL,
    notes text,
    recorded_by text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: hr_training_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_training_records (
    id text NOT NULL,
    employee_id text NOT NULL,
    course_name text NOT NULL,
    provider text,
    completion_date text NOT NULL,
    certification_no text,
    notes text,
    created_at text NOT NULL
);


--
-- Name: installation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.installation_jobs (
    id text NOT NULL,
    request_id text NOT NULL,
    customer_name text NOT NULL,
    customer_phone text,
    location text NOT NULL,
    scheduled_date text,
    assigned_technician_id text,
    assigned_technician_email text,
    status text NOT NULL,
    job_details_json text DEFAULT '{}'::text NOT NULL,
    job_card_json text DEFAULT '{}'::text NOT NULL,
    confirmation_json text DEFAULT '{}'::text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: installation_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.installation_tickets (
    id text NOT NULL,
    ticket_no text NOT NULL,
    invoice_id text,
    proforma_id text,
    customer_id text,
    customer_name text,
    vehicle_id text,
    vehicle_registration text,
    notes text,
    devices_json text DEFAULT '[]'::text NOT NULL,
    assigned_to_user_id text,
    assigned_to_email text,
    assigned_at text,
    status text DEFAULT 'Pending'::text NOT NULL,
    stage integer DEFAULT 0 NOT NULL,
    vi_installation_id text,
    created_by_user_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text,
    checklist_json text DEFAULT '[]'::text NOT NULL,
    assigned_device_id text,
    vehicle_details_json text,
    pre_install_checklist_json text DEFAULT '[]'::text NOT NULL,
    electrical_checklist_json text DEFAULT '[]'::text NOT NULL,
    device_install_json text,
    post_install_checklist_json text DEFAULT '[]'::text NOT NULL,
    site_photos_json text DEFAULT '[]'::text NOT NULL,
    activation_json text,
    technician_signed_off_at text,
    engineer_signed_off_at text,
    engineer_signed_off_by text,
    customer_otp text,
    customer_otp_verified_at text,
    csat_score integer,
    csat_comment text,
    co_technician_user_id text,
    co_technician_email text,
    co_technician_name text,
    iso_email text,
    iso_name text,
    iso_user_id text,
    iso_assigned_at text,
    crm_ticket_id text
);


--
-- Name: inv_checkout_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_checkout_records (
    id text NOT NULL,
    item_id text NOT NULL,
    installation_ticket_id text,
    technician_id text,
    technician_email text,
    sim_phone text,
    checkout_by_user_id text,
    checkout_at text NOT NULL,
    checkin_at text,
    checkin_by_user_id text,
    return_reason text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: inv_defect_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_defect_records (
    id text NOT NULL,
    item_id text NOT NULL,
    warranty_ticket_id text,
    defect_type text,
    severity text DEFAULT 'Medium'::text,
    description text NOT NULL,
    logged_by_user_id text,
    logged_at text NOT NULL,
    inspection_notes text,
    action_taken text,
    created_at text NOT NULL
);


--
-- Name: inv_issuance_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_issuance_batches (
    id text NOT NULL,
    batch_ref text NOT NULL,
    technician_id text NOT NULL,
    technician_name text,
    clerk_user_id text NOT NULL,
    clerk_email text,
    device_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'Pending'::text NOT NULL,
    acknowledged_at text,
    rejection_reason text,
    notes text,
    issued_at text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: inv_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_items (
    id text NOT NULL,
    product_id text NOT NULL,
    serial_number text,
    imei text,
    mac_address text,
    supplier_id text,
    supplier_ref text,
    batch_id text,
    purchase_date text,
    purchase_price real,
    warehouse_location text,
    status text DEFAULT 'In Stock'::text NOT NULL,
    installation_id text,
    customer_id text,
    sim_phone text,
    sim_serial text,
    activated_at text,
    deployed_at text,
    warranty_expires_at text,
    defect_ticket_id text,
    replaced_by_item_id text,
    notes text,
    created_by_user_id text,
    received_by_user_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text,
    reserved_until text,
    reservation_quote_id text,
    issued_to_id text,
    issued_to_name text,
    issued_at text,
    issuance_batch_id text,
    acknowledged_at text
);


--
-- Name: inv_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_movements (
    id text NOT NULL,
    item_id text NOT NULL,
    product_id text,
    action text NOT NULL,
    from_status text,
    to_status text,
    from_location text,
    to_location text,
    installation_id text,
    batch_id text,
    performed_by_user_id text NOT NULL,
    performed_by_email text,
    notes text,
    created_at text NOT NULL
);


--
-- Name: inv_procurement_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_procurement_batches (
    id text NOT NULL,
    batch_number text NOT NULL,
    po_id text,
    supplier_id text NOT NULL,
    received_by_user_id text,
    received_at text,
    notes text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: inv_procurement_requisitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_procurement_requisitions (
    id text NOT NULL,
    req_no text NOT NULL,
    product_id text NOT NULL,
    quantity integer NOT NULL,
    supplier_id text,
    requested_by_user_id text NOT NULL,
    requested_by_email text,
    justification text,
    status text DEFAULT 'Pending'::text NOT NULL,
    approved_by text,
    approved_at text,
    rejected_by text,
    rejected_at text,
    rejection_reason text,
    purchase_order_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text
);


--
-- Name: inv_product_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_product_catalog (
    id text NOT NULL,
    category_id text NOT NULL,
    product_code text NOT NULL,
    product_name text NOT NULL,
    device_model text NOT NULL,
    manufacturer text,
    vendor text,
    supplier_id text,
    country_of_origin text,
    description text,
    warranty_months integer DEFAULT 12 NOT NULL,
    installation_notes text,
    purchase_price real,
    sale_price real,
    installation_price real,
    subscription_price real,
    max_discount_pct real DEFAULT 10 NOT NULL,
    min_margin_pct real DEFAULT 20 NOT NULL,
    reorder_level integer DEFAULT 5 NOT NULL,
    max_stock_level integer DEFAULT 100 NOT NULL,
    active integer DEFAULT 1 NOT NULL,
    created_by_user_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text,
    key_features text,
    talking_points text,
    tech_specs text,
    target_segment text
);


--
-- Name: inv_product_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_product_categories (
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    description text,
    active integer DEFAULT 1 NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: inv_purchase_order_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_purchase_order_lines (
    id text NOT NULL,
    po_id text NOT NULL,
    product_id text NOT NULL,
    quantity integer NOT NULL,
    unit_price real,
    total_price real,
    quantity_received integer DEFAULT 0 NOT NULL,
    created_at text NOT NULL
);


--
-- Name: inv_purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_purchase_orders (
    id text NOT NULL,
    po_no text NOT NULL,
    supplier_id text NOT NULL,
    requisition_ids text,
    status text DEFAULT 'Draft'::text NOT NULL,
    total_amount real,
    delivery_date text,
    notes text,
    created_by_user_id text,
    approved_by text,
    approved_at text,
    received_at text,
    received_by text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text
);


--
-- Name: inv_suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_suppliers (
    id text NOT NULL,
    supplier_name text NOT NULL,
    contact_person text,
    email text,
    phone text,
    country text,
    distributor_level text,
    contract_reference text,
    notes text,
    active integer DEFAULT 1 NOT NULL,
    created_by_user_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text,
    business_reg_no text,
    tax_id text,
    supplier_category text,
    head_office_address text,
    website text,
    job_title text,
    alt_phone text,
    finance_contact_person text,
    finance_email text,
    finance_phone text,
    bank_name text,
    account_name text,
    account_number text,
    swift_code text,
    currency text,
    advance_payment_pct real,
    credit_period_days integer,
    payment_method text,
    shipping_origin text,
    lead_time_days integer,
    shipping_methods text,
    preferred_freight_forwarder text,
    min_order_quantity integer,
    product_categories_supplied text,
    certifications text,
    warranty_terms text,
    return_policy text,
    defective_unit_procedure text,
    contract_start_date text,
    contract_expiry_date text,
    sla_response_time text,
    sla_replacement_time text,
    blacklist_status integer DEFAULT 0,
    approved_vendor integer DEFAULT 1,
    compliance_documents text,
    procurement_rating integer,
    quality_rating integer,
    delivery_rating integer,
    pricing_rating integer,
    preferred_products text,
    batch_numbers_info text,
    serial_range_info text,
    last_purchase_date text,
    total_purchase_value real,
    outstanding_balance real,
    credit_limit real,
    avg_delivery_days real,
    fulfillment_rate real,
    defective_rate real,
    warranty_claim_rate real
);


--
-- Name: inv_warranty_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inv_warranty_tickets (
    id text NOT NULL,
    ticket_no text NOT NULL,
    item_id text NOT NULL,
    product_id text,
    customer_id text,
    installation_id text,
    direction text DEFAULT 'Inbound'::text NOT NULL,
    issue_description text,
    reported_by text,
    status text DEFAULT 'Open'::text NOT NULL,
    defect_confirmed integer DEFAULT 0,
    defect_confirmed_by text,
    defect_confirmed_at text,
    supplier_claim_ref text,
    supplier_claim_sent_at text,
    replacement_item_id text,
    replacement_received_at text,
    resolved_at text,
    resolved_by text,
    notes text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text
);


--
-- Name: invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_items (
    id text NOT NULL,
    invoice_id text NOT NULL,
    item text NOT NULL,
    description text,
    qty double precision NOT NULL,
    rate double precision NOT NULL,
    amount double precision NOT NULL,
    vat double precision NOT NULL
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id text NOT NULL,
    invoice_number text NOT NULL,
    crm_record_id text,
    customer text NOT NULL,
    representative text,
    vat_mode text,
    tax_date text,
    job_card_no text,
    pin_no text,
    subtotal double precision,
    vat_total double precision,
    total double precision,
    payment_paybill text,
    payment_account_hint text,
    bank_name text,
    bank_account_no text,
    amount double precision NOT NULL,
    currency text DEFAULT 'KES'::text NOT NULL,
    status text NOT NULL,
    issued_on text NOT NULL,
    due_on text NOT NULL,
    bank text,
    sales_person text,
    details_json text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    etr_receipt_no text,
    proforma_id text,
    etims_signed_at text,
    etims_control_no text,
    sent_email_at text,
    etims_signed boolean DEFAULT false,
    sent_whatsapp_at text,
    etims_signed_by text,
    customer_id text,
    quote_id text,
    etims_receipt_no text
);


--
-- Name: otp_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_verifications (
    id text NOT NULL,
    installation_id text NOT NULL,
    otp_hash text NOT NULL,
    expires_at text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    verified_at text,
    created_at text NOT NULL
);


--
-- Name: partner_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id text DEFAULT (gen_random_uuid())::text NOT NULL,
    event_type text NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    user_id text,
    user_role text,
    partner_id uuid,
    source_ip text,
    device_agent text,
    module text,
    record_id text,
    action text,
    previous_value text,
    new_value text
);


--
-- Name: partner_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_id uuid NOT NULL,
    file_name text NOT NULL,
    file_path text NOT NULL,
    file_size integer,
    mime_type text,
    uploaded_by text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_otp; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_otp (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_user_id uuid NOT NULL,
    otp_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_password_reset_tokens (
    id text NOT NULL,
    partner_user_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at text NOT NULL,
    used_at text,
    created_at text NOT NULL
);


--
-- Name: partner_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_id uuid NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    phone text,
    role text DEFAULT 'PartnerUser'::text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    notify_email boolean DEFAULT true NOT NULL,
    notify_sms boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone,
    login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    business_reg_no text,
    regions jsonb DEFAULT '["All"]'::jsonb NOT NULL,
    primary_contact_name text,
    contact_email text,
    contact_phone text,
    tier text DEFAULT 'Standard'::text NOT NULL,
    key_account_manager_id text,
    contract_ref text,
    contract_scope text,
    contract_start date,
    contract_expiry date,
    notes text,
    status text DEFAULT 'Active'::text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    portal_logo_url text,
    portal_primary_color text,
    portal_theme_json text
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id text NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at text NOT NULL,
    used_at text,
    created_at text NOT NULL
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id text NOT NULL,
    payment_ref text NOT NULL,
    invoice_id text NOT NULL,
    customer text NOT NULL,
    amount double precision NOT NULL,
    currency text DEFAULT 'KES'::text NOT NULL,
    method text NOT NULL,
    bank text,
    status text NOT NULL,
    paid_at text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id text NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: sales_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_transactions (
    id text NOT NULL,
    sale_id text NOT NULL,
    sale_date text NOT NULL,
    sales_person text NOT NULL,
    bank text NOT NULL,
    vehicle_id text NOT NULL,
    vehicle_plate text NOT NULL,
    vehicle_model text NOT NULL,
    customer_name text NOT NULL,
    amount double precision NOT NULL,
    currency text DEFAULT 'KES'::text NOT NULL,
    payment_status text NOT NULL,
    invoice_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: speed_governors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.speed_governors (
    id text NOT NULL,
    customer_name text NOT NULL,
    phone_number text NOT NULL,
    registration_number text NOT NULL,
    model text NOT NULL,
    device_type text NOT NULL,
    technician_id text NOT NULL,
    technician_name text NOT NULL,
    technician_email text NOT NULL,
    sales_person_id text NOT NULL,
    sales_person_name text NOT NULL,
    sales_person_email text NOT NULL,
    comments text,
    created_by_user_id text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: technical_team_roster; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.technical_team_roster (
    id text NOT NULL,
    member_type text DEFAULT 'Technician'::text NOT NULL,
    display_name text NOT NULL,
    email text,
    phone text,
    user_account_id text,
    hr_employee_id text,
    duty_status text DEFAULT 'Active'::text NOT NULL,
    notes text,
    added_by text,
    added_at text DEFAULT to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text) NOT NULL,
    updated_at text DEFAULT to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text) NOT NULL,
    CONSTRAINT technical_team_roster_duty_status_check CHECK ((duty_status = ANY (ARRAY['Active'::text, 'Inactive'::text, 'On Leave'::text]))),
    CONSTRAINT technical_team_roster_member_type_check CHECK ((member_type = ANY (ARRAY['Technician'::text, 'ISO'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    password_hash text NOT NULL,
    force_password_reset integer DEFAULT 0 NOT NULL,
    last_login_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: v_person_identity; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_person_identity AS
 SELECT u.id AS user_id,
    COALESCE(u.name, e.full_name) AS display_name,
    u.email AS login_email,
    u.role AS erp_role,
    u.status AS account_status,
    e.id AS hr_employee_id,
    e.employee_no,
    e.full_name AS hr_full_name,
    r.id AS roster_id,
    r.member_type AS roster_member_type,
    r.duty_status AS roster_duty_status
   FROM ((public.users u
     LEFT JOIN public.hr_employees e ON ((e.user_account_id = u.id)))
     LEFT JOIN public.technical_team_roster r ON (((r.user_account_id = u.id) OR ((r.hr_employee_id = e.id) AND (r.user_account_id IS NULL)))));


--
-- Name: vi_gadgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_gadgets (
    id text NOT NULL,
    installation_id text NOT NULL,
    device_type text NOT NULL,
    device_model text,
    imei_enc text,
    sim_number_enc text,
    serial_number text,
    activation_status text DEFAULT 'Inactive'::text NOT NULL,
    installation_status text DEFAULT 'Pending'::text NOT NULL,
    assigned_by_user_id text,
    notes text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: vi_inspections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_inspections (
    id text NOT NULL,
    installation_id text NOT NULL,
    type text NOT NULL,
    items_json text DEFAULT '[]'::text NOT NULL,
    technician_id text,
    technician_notes text,
    customer_confirmed_at text,
    customer_confirmed_by text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);


--
-- Name: vi_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_installations (
    id text NOT NULL,
    vehicle_id text,
    customer_id text NOT NULL,
    ticket_ref text,
    assigned_technician_id text,
    assigned_technician_email text,
    assigned_at text,
    status text DEFAULT 'Pending'::text NOT NULL,
    stage integer DEFAULT 0 NOT NULL,
    vin_enc text,
    engine_number_enc text,
    fuel_type text,
    dashboard_config_json text,
    electrical_notes text,
    post_install_notes text,
    completed_at text,
    created_by_user_id text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    deleted_at text
);


--
-- Name: vi_otp; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_otp (
    id text NOT NULL,
    installation_id text NOT NULL,
    otp_hash text NOT NULL,
    channel text DEFAULT 'SMS'::text NOT NULL,
    expires_at text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    verified_at text,
    created_at text NOT NULL
);


--
-- Name: vi_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_photos (
    id text NOT NULL,
    installation_id text NOT NULL,
    photo_type text NOT NULL,
    label text,
    data_url text NOT NULL,
    uploaded_by_user_id text,
    uploaded_at text NOT NULL
);


--
-- Name: vi_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vi_stages (
    id text NOT NULL,
    installation_id text NOT NULL,
    stage integer NOT NULL,
    stage_name text NOT NULL,
    completed_at text NOT NULL,
    technician_id text,
    notes text
);


--
-- Name: app_notifications app_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_notifications
    ADD CONSTRAINT app_notifications_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: certificates certificates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_pkey PRIMARY KEY (id);


--
-- Name: certificates certificates_serial_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_serial_no_key UNIQUE (serial_no);


--
-- Name: crm_campaign_members crm_campaign_members_campaign_id_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_campaign_members
    ADD CONSTRAINT crm_campaign_members_campaign_id_customer_id_key UNIQUE (campaign_id, customer_id);


--
-- Name: crm_campaign_members crm_campaign_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_campaign_members
    ADD CONSTRAINT crm_campaign_members_pkey PRIMARY KEY (id);


--
-- Name: crm_campaigns crm_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_campaigns
    ADD CONSTRAINT crm_campaigns_pkey PRIMARY KEY (id);


--
-- Name: crm_communication_logs crm_communication_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_communication_logs
    ADD CONSTRAINT crm_communication_logs_pkey PRIMARY KEY (id);


--
-- Name: crm_contact_persons crm_contact_persons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_persons
    ADD CONSTRAINT crm_contact_persons_pkey PRIMARY KEY (id);


--
-- Name: crm_corporate_profiles crm_corporate_profiles_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_corporate_profiles
    ADD CONSTRAINT crm_corporate_profiles_customer_id_key UNIQUE (customer_id);


--
-- Name: crm_corporate_profiles crm_corporate_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_corporate_profiles
    ADD CONSTRAINT crm_corporate_profiles_pkey PRIMARY KEY (id);


--
-- Name: crm_customer_users crm_customer_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_customer_users
    ADD CONSTRAINT crm_customer_users_email_key UNIQUE (email);


--
-- Name: crm_customer_users crm_customer_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_customer_users
    ADD CONSTRAINT crm_customer_users_pkey PRIMARY KEY (id);


--
-- Name: crm_customer_vehicles crm_customer_vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_customer_vehicles
    ADD CONSTRAINT crm_customer_vehicles_pkey PRIMARY KEY (id);


--
-- Name: crm_customers crm_customers_account_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_customers
    ADD CONSTRAINT crm_customers_account_no_key UNIQUE (account_no);


--
-- Name: crm_customers crm_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_customers
    ADD CONSTRAINT crm_customers_pkey PRIMARY KEY (id);


--
-- Name: crm_devices crm_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_devices
    ADD CONSTRAINT crm_devices_pkey PRIMARY KEY (id);


--
-- Name: crm_gadget_stock crm_gadget_stock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_gadget_stock
    ADD CONSTRAINT crm_gadget_stock_pkey PRIMARY KEY (id);


--
-- Name: crm_individual_profiles crm_individual_profiles_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_individual_profiles
    ADD CONSTRAINT crm_individual_profiles_customer_id_key UNIQUE (customer_id);


--
-- Name: crm_individual_profiles crm_individual_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_individual_profiles
    ADD CONSTRAINT crm_individual_profiles_pkey PRIMARY KEY (id);


--
-- Name: crm_installation_surveys crm_installation_surveys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_installation_surveys
    ADD CONSTRAINT crm_installation_surveys_pkey PRIMARY KEY (id);


--
-- Name: crm_installation_surveys crm_installation_surveys_survey_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_installation_surveys
    ADD CONSTRAINT crm_installation_surveys_survey_token_key UNIQUE (survey_token);


--
-- Name: crm_lead_conversations crm_lead_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_conversations
    ADD CONSTRAINT crm_lead_conversations_pkey PRIMARY KEY (id);


--
-- Name: crm_leads crm_leads_lead_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_lead_no_key UNIQUE (lead_no);


--
-- Name: crm_leads crm_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_pkey PRIMARY KEY (id);


--
-- Name: crm_proforma_invoices crm_proforma_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_proforma_invoices
    ADD CONSTRAINT crm_proforma_invoices_pkey PRIMARY KEY (id);


--
-- Name: crm_proforma_invoices crm_proforma_invoices_proforma_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_proforma_invoices
    ADD CONSTRAINT crm_proforma_invoices_proforma_no_key UNIQUE (proforma_no);


--
-- Name: crm_proforma_items crm_proforma_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_proforma_items
    ADD CONSTRAINT crm_proforma_items_pkey PRIMARY KEY (id);


--
-- Name: crm_quote_items crm_quote_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_quote_items
    ADD CONSTRAINT crm_quote_items_pkey PRIMARY KEY (id);


--
-- Name: crm_quotes crm_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_quotes
    ADD CONSTRAINT crm_quotes_pkey PRIMARY KEY (id);


--
-- Name: crm_quotes crm_quotes_quote_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_quotes
    ADD CONSTRAINT crm_quotes_quote_no_key UNIQUE (quote_no);


--
-- Name: crm_records crm_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_pkey PRIMARY KEY (id);


--
-- Name: crm_subscriptions crm_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subscriptions
    ADD CONSTRAINT crm_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: crm_ticket_actions crm_ticket_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_ticket_actions
    ADD CONSTRAINT crm_ticket_actions_pkey PRIMARY KEY (id);


--
-- Name: crm_tickets crm_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tickets
    ADD CONSTRAINT crm_tickets_pkey PRIMARY KEY (id);


--
-- Name: crm_tickets crm_tickets_ticket_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tickets
    ADD CONSTRAINT crm_tickets_ticket_no_key UNIQUE (ticket_no);


--
-- Name: di_device_transfers di_device_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.di_device_transfers
    ADD CONSTRAINT di_device_transfers_pkey PRIMARY KEY (id);


--
-- Name: di_issuance_batches di_issuance_batches_batch_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.di_issuance_batches
    ADD CONSTRAINT di_issuance_batches_batch_ref_key UNIQUE (batch_ref);


--
-- Name: di_issuance_batches di_issuance_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.di_issuance_batches
    ADD CONSTRAINT di_issuance_batches_pkey PRIMARY KEY (id);


--
-- Name: di_receive_batches di_receive_batches_batch_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.di_receive_batches
    ADD CONSTRAINT di_receive_batches_batch_ref_key UNIQUE (batch_ref);


--
-- Name: di_receive_batches di_receive_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.di_receive_batches
    ADD CONSTRAINT di_receive_batches_pkey PRIMARY KEY (id);


--
-- Name: di_technician_custody_config di_technician_custody_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.di_technician_custody_config
    ADD CONSTRAINT di_technician_custody_config_pkey PRIMARY KEY (id);


--
-- Name: di_technician_custody_config di_technician_custody_config_technician_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.di_technician_custody_config
    ADD CONSTRAINT di_technician_custody_config_technician_id_key UNIQUE (technician_id);


--
-- Name: di_tracker_devices di_tracker_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.di_tracker_devices
    ADD CONSTRAINT di_tracker_devices_pkey PRIMARY KEY (id);


--
-- Name: email_sync_state email_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sync_state
    ADD CONSTRAINT email_sync_state_pkey PRIMARY KEY (mailbox);


--
-- Name: hr_benefit_plans hr_benefit_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_benefit_plans
    ADD CONSTRAINT hr_benefit_plans_pkey PRIMARY KEY (id);


--
-- Name: hr_cadres hr_cadres_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_cadres
    ADD CONSTRAINT hr_cadres_name_key UNIQUE (name);


--
-- Name: hr_cadres hr_cadres_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_cadres
    ADD CONSTRAINT hr_cadres_pkey PRIMARY KEY (id);


--
-- Name: hr_documents hr_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_documents
    ADD CONSTRAINT hr_documents_pkey PRIMARY KEY (id);


--
-- Name: hr_emergency_contacts hr_emergency_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_emergency_contacts
    ADD CONSTRAINT hr_emergency_contacts_pkey PRIMARY KEY (id);


--
-- Name: hr_emp_no_config hr_emp_no_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_emp_no_config
    ADD CONSTRAINT hr_emp_no_config_pkey PRIMARY KEY (employment_type);


--
-- Name: hr_employees hr_employees_employee_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_employee_no_key UNIQUE (employee_no);


--
-- Name: hr_employees hr_employees_personal_file_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_personal_file_no_key UNIQUE (personal_file_no);


--
-- Name: hr_employees hr_employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_pkey PRIMARY KEY (id);


--
-- Name: hr_job_roles hr_job_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_job_roles
    ADD CONSTRAINT hr_job_roles_pkey PRIMARY KEY (id);


--
-- Name: hr_leave_applications hr_leave_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_applications
    ADD CONSTRAINT hr_leave_applications_pkey PRIMARY KEY (id);


--
-- Name: hr_leave_approval_log hr_leave_approval_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_approval_log
    ADD CONSTRAINT hr_leave_approval_log_pkey PRIMARY KEY (id);


--
-- Name: hr_leave_balances hr_leave_balances_employee_id_leave_type_id_balance_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_balances
    ADD CONSTRAINT hr_leave_balances_employee_id_leave_type_id_balance_year_key UNIQUE (employee_id, leave_type_id, balance_year);


--
-- Name: hr_leave_balances hr_leave_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_balances
    ADD CONSTRAINT hr_leave_balances_pkey PRIMARY KEY (id);


--
-- Name: hr_leave_entitlements hr_leave_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_entitlements
    ADD CONSTRAINT hr_leave_entitlements_pkey PRIMARY KEY (id);


--
-- Name: hr_leave_types hr_leave_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_types
    ADD CONSTRAINT hr_leave_types_name_key UNIQUE (name);


--
-- Name: hr_leave_types hr_leave_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_types
    ADD CONSTRAINT hr_leave_types_pkey PRIMARY KEY (id);


--
-- Name: hr_m365_accounts hr_m365_accounts_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_m365_accounts
    ADD CONSTRAINT hr_m365_accounts_employee_id_key UNIQUE (employee_id);


--
-- Name: hr_m365_accounts hr_m365_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_m365_accounts
    ADD CONSTRAINT hr_m365_accounts_pkey PRIMARY KEY (id);


--
-- Name: hr_org_units hr_org_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_org_units
    ADD CONSTRAINT hr_org_units_pkey PRIMARY KEY (id);


--
-- Name: hr_performance_records hr_performance_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_performance_records
    ADD CONSTRAINT hr_performance_records_pkey PRIMARY KEY (id);


--
-- Name: hr_promotion_history hr_promotion_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_promotion_history
    ADD CONSTRAINT hr_promotion_history_pkey PRIMARY KEY (id);


--
-- Name: hr_training_records hr_training_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_training_records
    ADD CONSTRAINT hr_training_records_pkey PRIMARY KEY (id);


--
-- Name: installation_jobs installation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installation_jobs
    ADD CONSTRAINT installation_jobs_pkey PRIMARY KEY (id);


--
-- Name: installation_tickets installation_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installation_tickets
    ADD CONSTRAINT installation_tickets_pkey PRIMARY KEY (id);


--
-- Name: installation_tickets installation_tickets_ticket_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installation_tickets
    ADD CONSTRAINT installation_tickets_ticket_no_key UNIQUE (ticket_no);


--
-- Name: inv_checkout_records inv_checkout_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_checkout_records
    ADD CONSTRAINT inv_checkout_records_pkey PRIMARY KEY (id);


--
-- Name: inv_defect_records inv_defect_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_defect_records
    ADD CONSTRAINT inv_defect_records_pkey PRIMARY KEY (id);


--
-- Name: inv_issuance_batches inv_issuance_batches_batch_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_issuance_batches
    ADD CONSTRAINT inv_issuance_batches_batch_ref_key UNIQUE (batch_ref);


--
-- Name: inv_issuance_batches inv_issuance_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_issuance_batches
    ADD CONSTRAINT inv_issuance_batches_pkey PRIMARY KEY (id);


--
-- Name: inv_items inv_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_items
    ADD CONSTRAINT inv_items_pkey PRIMARY KEY (id);


--
-- Name: inv_movements inv_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_movements
    ADD CONSTRAINT inv_movements_pkey PRIMARY KEY (id);


--
-- Name: inv_procurement_batches inv_procurement_batches_batch_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_procurement_batches
    ADD CONSTRAINT inv_procurement_batches_batch_number_key UNIQUE (batch_number);


--
-- Name: inv_procurement_batches inv_procurement_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_procurement_batches
    ADD CONSTRAINT inv_procurement_batches_pkey PRIMARY KEY (id);


--
-- Name: inv_procurement_requisitions inv_procurement_requisitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_procurement_requisitions
    ADD CONSTRAINT inv_procurement_requisitions_pkey PRIMARY KEY (id);


--
-- Name: inv_procurement_requisitions inv_procurement_requisitions_req_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_procurement_requisitions
    ADD CONSTRAINT inv_procurement_requisitions_req_no_key UNIQUE (req_no);


--
-- Name: inv_product_catalog inv_product_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_product_catalog
    ADD CONSTRAINT inv_product_catalog_pkey PRIMARY KEY (id);


--
-- Name: inv_product_catalog inv_product_catalog_product_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_product_catalog
    ADD CONSTRAINT inv_product_catalog_product_code_key UNIQUE (product_code);


--
-- Name: inv_product_categories inv_product_categories_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_product_categories
    ADD CONSTRAINT inv_product_categories_code_key UNIQUE (code);


--
-- Name: inv_product_categories inv_product_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_product_categories
    ADD CONSTRAINT inv_product_categories_pkey PRIMARY KEY (id);


--
-- Name: inv_product_categories inv_product_categories_prefix_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_product_categories
    ADD CONSTRAINT inv_product_categories_prefix_key UNIQUE (prefix);


--
-- Name: inv_purchase_order_lines inv_purchase_order_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_purchase_order_lines
    ADD CONSTRAINT inv_purchase_order_lines_pkey PRIMARY KEY (id);


--
-- Name: inv_purchase_orders inv_purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_purchase_orders
    ADD CONSTRAINT inv_purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: inv_purchase_orders inv_purchase_orders_po_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_purchase_orders
    ADD CONSTRAINT inv_purchase_orders_po_no_key UNIQUE (po_no);


--
-- Name: inv_suppliers inv_suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_suppliers
    ADD CONSTRAINT inv_suppliers_pkey PRIMARY KEY (id);


--
-- Name: inv_warranty_tickets inv_warranty_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_warranty_tickets
    ADD CONSTRAINT inv_warranty_tickets_pkey PRIMARY KEY (id);


--
-- Name: inv_warranty_tickets inv_warranty_tickets_ticket_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inv_warranty_tickets
    ADD CONSTRAINT inv_warranty_tickets_ticket_no_key UNIQUE (ticket_no);


--
-- Name: invoice_items invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: otp_verifications otp_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_verifications
    ADD CONSTRAINT otp_verifications_pkey PRIMARY KEY (id);


--
-- Name: partner_audit_logs partner_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_audit_logs
    ADD CONSTRAINT partner_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: partner_contracts partner_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_contracts
    ADD CONSTRAINT partner_contracts_pkey PRIMARY KEY (id);


--
-- Name: partner_otp partner_otp_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_otp
    ADD CONSTRAINT partner_otp_pkey PRIMARY KEY (id);


--
-- Name: partner_password_reset_tokens partner_password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_password_reset_tokens
    ADD CONSTRAINT partner_password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: partner_password_reset_tokens partner_password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_password_reset_tokens
    ADD CONSTRAINT partner_password_reset_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: partner_sessions partner_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_sessions
    ADD CONSTRAINT partner_sessions_pkey PRIMARY KEY (id);


--
-- Name: partner_sessions partner_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_sessions
    ADD CONSTRAINT partner_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: partner_users partner_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_users
    ADD CONSTRAINT partner_users_email_key UNIQUE (email);


--
-- Name: partner_users partner_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_users
    ADD CONSTRAINT partner_users_pkey PRIMARY KEY (id);


--
-- Name: partners partners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: payments payments_payment_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_payment_ref_key UNIQUE (payment_ref);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: sales_transactions sales_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_transactions
    ADD CONSTRAINT sales_transactions_pkey PRIMARY KEY (id);


--
-- Name: sales_transactions sales_transactions_sale_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_transactions
    ADD CONSTRAINT sales_transactions_sale_id_key UNIQUE (sale_id);


--
-- Name: speed_governors speed_governors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.speed_governors
    ADD CONSTRAINT speed_governors_pkey PRIMARY KEY (id);


--
-- Name: technical_team_roster technical_team_roster_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.technical_team_roster
    ADD CONSTRAINT technical_team_roster_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vi_gadgets vi_gadgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_gadgets
    ADD CONSTRAINT vi_gadgets_pkey PRIMARY KEY (id);


--
-- Name: vi_inspections vi_inspections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_inspections
    ADD CONSTRAINT vi_inspections_pkey PRIMARY KEY (id);


--
-- Name: vi_installations vi_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_installations
    ADD CONSTRAINT vi_installations_pkey PRIMARY KEY (id);


--
-- Name: vi_otp vi_otp_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_otp
    ADD CONSTRAINT vi_otp_pkey PRIMARY KEY (id);


--
-- Name: vi_photos vi_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_photos
    ADD CONSTRAINT vi_photos_pkey PRIMARY KEY (id);


--
-- Name: vi_stages vi_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_stages
    ADD CONSTRAINT vi_stages_pkey PRIMARY KEY (id);


--
-- Name: idx_audit_logs_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_action ON public.audit_logs USING btree (action);


--
-- Name: idx_audit_logs_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_severity ON public.audit_logs USING btree (severity);


--
-- Name: idx_audit_logs_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_timestamp ON public.audit_logs USING btree ("timestamp");


--
-- Name: idx_audit_logs_user_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_user_email ON public.audit_logs USING btree (user_email);


--
-- Name: idx_certificates_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_certificates_created_at ON public.certificates USING btree (created_at);


--
-- Name: idx_certificates_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_certificates_name ON public.certificates USING btree (name);


--
-- Name: idx_certificates_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_certificates_phone ON public.certificates USING btree (phone);


--
-- Name: idx_certificates_registration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_certificates_registration ON public.certificates USING btree (car_registration);


--
-- Name: idx_certificates_serial_no; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_certificates_serial_no ON public.certificates USING btree (serial_no);


--
-- Name: idx_crm_campaign_members_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_campaign_members_campaign ON public.crm_campaign_members USING btree (campaign_id);


--
-- Name: idx_crm_campaign_members_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_campaign_members_customer ON public.crm_campaign_members USING btree (customer_id);


--
-- Name: idx_crm_campaigns_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_campaigns_status ON public.crm_campaigns USING btree (status);


--
-- Name: idx_crm_campaigns_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_campaigns_type ON public.crm_campaigns USING btree (type);


--
-- Name: idx_crm_comms_contacted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_comms_contacted ON public.crm_communication_logs USING btree (contacted_at);


--
-- Name: idx_crm_comms_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_comms_customer ON public.crm_communication_logs USING btree (customer_id);


--
-- Name: idx_crm_comms_external; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crm_comms_external ON public.crm_communication_logs USING btree (external_id) WHERE (external_id IS NOT NULL);


--
-- Name: idx_crm_contacts_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_contacts_customer ON public.crm_contact_persons USING btree (customer_id);


--
-- Name: idx_crm_corporate_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_corporate_customer ON public.crm_corporate_profiles USING btree (customer_id);


--
-- Name: idx_crm_cust_users_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_cust_users_customer ON public.crm_customer_users USING btree (customer_id);


--
-- Name: idx_crm_cust_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_cust_users_email ON public.crm_customer_users USING btree (email);


--
-- Name: idx_crm_customers_account_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_customers_account_manager ON public.crm_customers USING btree (account_manager_id);


--
-- Name: idx_crm_customers_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_customers_created ON public.crm_customers USING btree (created_at);


--
-- Name: idx_crm_customers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_customers_status ON public.crm_customers USING btree (status);


--
-- Name: idx_crm_customers_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_customers_type ON public.crm_customers USING btree (type);


--
-- Name: idx_crm_devices_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_devices_customer ON public.crm_devices USING btree (customer_id);


--
-- Name: idx_crm_devices_imei; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_devices_imei ON public.crm_devices USING btree (imei);


--
-- Name: idx_crm_devices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_devices_status ON public.crm_devices USING btree (status);


--
-- Name: idx_crm_individual_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_individual_customer ON public.crm_individual_profiles USING btree (customer_id);


--
-- Name: idx_crm_leads_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_customer ON public.crm_leads USING btree (customer_id);


--
-- Name: idx_crm_leads_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_partner ON public.crm_leads USING btree (partner_id);


--
-- Name: idx_crm_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_status ON public.crm_leads USING btree (status);


--
-- Name: idx_crm_pf_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_pf_customer ON public.crm_proforma_invoices USING btree (customer_id);


--
-- Name: idx_crm_pf_items; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_pf_items ON public.crm_proforma_items USING btree (proforma_id);


--
-- Name: idx_crm_quote_items_quote; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_quote_items_quote ON public.crm_quote_items USING btree (quote_id);


--
-- Name: idx_crm_quotes_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_quotes_customer ON public.crm_quotes USING btree (customer_id);


--
-- Name: idx_crm_records_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_records_created_at ON public.crm_records USING btree (created_at);


--
-- Name: idx_crm_records_owner_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_records_owner_email ON public.crm_records USING btree (owner_email);


--
-- Name: idx_crm_records_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_records_status ON public.crm_records USING btree (status);


--
-- Name: idx_crm_records_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_records_type ON public.crm_records USING btree (type);


--
-- Name: idx_crm_subs_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_subs_customer ON public.crm_subscriptions USING btree (customer_id);


--
-- Name: idx_crm_subs_end_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_subs_end_date ON public.crm_subscriptions USING btree (end_date);


--
-- Name: idx_crm_subs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_subs_status ON public.crm_subscriptions USING btree (status);


--
-- Name: idx_crm_ticket_actions_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_ticket_actions_ticket ON public.crm_ticket_actions USING btree (ticket_id);


--
-- Name: idx_crm_tickets_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_tickets_assigned ON public.crm_tickets USING btree (assigned_to_user_id);


--
-- Name: idx_crm_tickets_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_tickets_customer ON public.crm_tickets USING btree (customer_id);


--
-- Name: idx_crm_tickets_opened; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_tickets_opened ON public.crm_tickets USING btree (opened_at);


--
-- Name: idx_crm_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_tickets_status ON public.crm_tickets USING btree (status);


--
-- Name: idx_di_dev_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_dev_batch ON public.di_tracker_devices USING btree (receive_batch_id);


--
-- Name: idx_di_dev_custodian; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_dev_custodian ON public.di_tracker_devices USING btree (custodian_technician_id);


--
-- Name: idx_di_dev_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_dev_job ON public.di_tracker_devices USING btree (job_id);


--
-- Name: idx_di_dev_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_dev_status ON public.di_tracker_devices USING btree (inventory_status);


--
-- Name: idx_di_iss_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_iss_status ON public.di_issuance_batches USING btree (status);


--
-- Name: idx_di_iss_tech; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_iss_tech ON public.di_issuance_batches USING btree (technician_id);


--
-- Name: idx_di_xfer_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_xfer_device ON public.di_device_transfers USING btree (device_id);


--
-- Name: idx_di_xfer_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_xfer_from ON public.di_device_transfers USING btree (from_technician_id);


--
-- Name: idx_di_xfer_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_xfer_status ON public.di_device_transfers USING btree (status);


--
-- Name: idx_di_xfer_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_di_xfer_to ON public.di_device_transfers USING btree (to_technician_id);


--
-- Name: idx_gadget_stock_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gadget_stock_inst ON public.crm_gadget_stock USING btree (assigned_to_installation_id);


--
-- Name: idx_gadget_stock_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gadget_stock_model ON public.crm_gadget_stock USING btree (device_model);


--
-- Name: idx_gadget_stock_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gadget_stock_status ON public.crm_gadget_stock USING btree (status);


--
-- Name: idx_hr_benefit_plans_cadre; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_benefit_plans_cadre ON public.hr_benefit_plans USING btree (cadre_id);


--
-- Name: idx_hr_documents_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_documents_emp ON public.hr_documents USING btree (employee_id);


--
-- Name: idx_hr_emergency_contacts_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_emergency_contacts_emp ON public.hr_emergency_contacts USING btree (employee_id);


--
-- Name: idx_hr_employees_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_employees_created ON public.hr_employees USING btree (created_at);


--
-- Name: idx_hr_employees_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_employees_manager ON public.hr_employees USING btree (manager_id);


--
-- Name: idx_hr_employees_org_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_employees_org_unit ON public.hr_employees USING btree (org_unit_id);


--
-- Name: idx_hr_employees_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_employees_status ON public.hr_employees USING btree (status);


--
-- Name: idx_hr_employees_work_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_hr_employees_work_email ON public.hr_employees USING btree (work_email) WHERE (work_email IS NOT NULL);


--
-- Name: idx_hr_leave_approval_log_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_leave_approval_log_app ON public.hr_leave_approval_log USING btree (application_id);


--
-- Name: idx_hr_leave_apps_dates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_leave_apps_dates ON public.hr_leave_applications USING btree (start_date, end_date);


--
-- Name: idx_hr_leave_apps_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_leave_apps_emp ON public.hr_leave_applications USING btree (employee_id);


--
-- Name: idx_hr_leave_apps_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_leave_apps_status ON public.hr_leave_applications USING btree (status);


--
-- Name: idx_hr_leave_balances_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_leave_balances_emp ON public.hr_leave_balances USING btree (employee_id);


--
-- Name: idx_hr_leave_balances_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_leave_balances_year ON public.hr_leave_balances USING btree (balance_year);


--
-- Name: idx_hr_org_units_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_org_units_parent ON public.hr_org_units USING btree (parent_id);


--
-- Name: idx_hr_performance_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_performance_emp ON public.hr_performance_records USING btree (employee_id);


--
-- Name: idx_hr_performance_reviewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_performance_reviewer ON public.hr_performance_records USING btree (reviewer_id);


--
-- Name: idx_hr_promotion_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_promotion_emp ON public.hr_promotion_history USING btree (employee_id);


--
-- Name: idx_hr_training_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hr_training_emp ON public.hr_training_records USING btree (employee_id);


--
-- Name: idx_installation_jobs_assigned_technician_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installation_jobs_assigned_technician_id ON public.installation_jobs USING btree (assigned_technician_id);


--
-- Name: idx_installation_jobs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installation_jobs_created_at ON public.installation_jobs USING btree (created_at);


--
-- Name: idx_installation_jobs_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installation_jobs_request_id ON public.installation_jobs USING btree (request_id);


--
-- Name: idx_installation_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installation_jobs_status ON public.installation_jobs USING btree (status);


--
-- Name: idx_inv_catalog_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_catalog_category ON public.inv_product_catalog USING btree (category_id);


--
-- Name: idx_inv_catalog_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_catalog_code ON public.inv_product_catalog USING btree (product_code);


--
-- Name: idx_inv_iss_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_iss_status ON public.inv_issuance_batches USING btree (status);


--
-- Name: idx_inv_iss_tech; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_iss_tech ON public.inv_issuance_batches USING btree (technician_id);


--
-- Name: idx_inv_items_imei; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_items_imei ON public.inv_items USING btree (imei);


--
-- Name: idx_inv_items_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_items_product ON public.inv_items USING btree (product_id);


--
-- Name: idx_inv_items_serial; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_items_serial ON public.inv_items USING btree (serial_number);


--
-- Name: idx_inv_items_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_items_status ON public.inv_items USING btree (status);


--
-- Name: idx_inv_movements_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_movements_item ON public.inv_movements USING btree (item_id);


--
-- Name: idx_inv_po_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_po_supplier ON public.inv_purchase_orders USING btree (supplier_id);


--
-- Name: idx_inv_req_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_req_product ON public.inv_procurement_requisitions USING btree (product_id);


--
-- Name: idx_invoice_items_invoice_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_invoice_id ON public.invoice_items USING btree (invoice_id);


--
-- Name: idx_invoices_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_created_at ON public.invoices USING btree (created_at);


--
-- Name: idx_invoices_invoice_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_invoice_number ON public.invoices USING btree (invoice_number);


--
-- Name: idx_invoices_tax_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_tax_date ON public.invoices USING btree (tax_date);


--
-- Name: idx_lead_convs_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_convs_lead ON public.crm_lead_conversations USING btree (lead_id);


--
-- Name: idx_partner_audit_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_audit_partner ON public.partner_audit_logs USING btree (partner_id);


--
-- Name: idx_partner_prt_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_prt_user ON public.partner_password_reset_tokens USING btree (partner_user_id);


--
-- Name: idx_partner_sessions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_sessions_expiry ON public.partner_sessions USING btree (expires_at);


--
-- Name: idx_partner_sessions_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_sessions_token ON public.partner_sessions USING btree (token_hash);


--
-- Name: idx_partner_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_users_email ON public.partner_users USING btree (email);


--
-- Name: idx_partner_users_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_users_partner ON public.partner_users USING btree (partner_id);


--
-- Name: idx_partners_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partners_status ON public.partners USING btree (status) WHERE (deleted_at IS NULL);


--
-- Name: idx_prt_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prt_user ON public.password_reset_tokens USING btree (user_id);


--
-- Name: idx_speed_governors_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_speed_governors_created_at ON public.speed_governors USING btree (created_at);


--
-- Name: idx_speed_governors_device_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_speed_governors_device_type ON public.speed_governors USING btree (device_type);


--
-- Name: idx_speed_governors_registration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_speed_governors_registration ON public.speed_governors USING btree (registration_number);


--
-- Name: idx_speed_governors_sales_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_speed_governors_sales_person_id ON public.speed_governors USING btree (sales_person_id);


--
-- Name: idx_speed_governors_technician_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_speed_governors_technician_id ON public.speed_governors USING btree (technician_id);


--
-- Name: idx_surveys_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_surveys_customer ON public.crm_installation_surveys USING btree (customer_id);


--
-- Name: idx_surveys_install; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_surveys_install ON public.crm_installation_surveys USING btree (installation_id);


--
-- Name: idx_vehicles_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vehicles_partner ON public.crm_customer_vehicles USING btree (partner_id);


--
-- Name: idx_vi_gadgets_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_gadgets_inst ON public.vi_gadgets USING btree (installation_id);


--
-- Name: idx_vi_inspections_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_inspections_inst ON public.vi_inspections USING btree (installation_id);


--
-- Name: idx_vi_inst_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_inst_customer ON public.vi_installations USING btree (customer_id);


--
-- Name: idx_vi_inst_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_inst_status ON public.vi_installations USING btree (status);


--
-- Name: idx_vi_inst_technician; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_inst_technician ON public.vi_installations USING btree (assigned_technician_id);


--
-- Name: idx_vi_inst_vehicle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_inst_vehicle ON public.vi_installations USING btree (vehicle_id);


--
-- Name: idx_vi_otp_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_otp_inst ON public.vi_otp USING btree (installation_id);


--
-- Name: idx_vi_photos_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_photos_inst ON public.vi_photos USING btree (installation_id);


--
-- Name: idx_vi_stages_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vi_stages_inst ON public.vi_stages USING btree (installation_id);


--
-- Name: idx_warranty_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warranty_customer ON public.inv_warranty_tickets USING btree (customer_id);


--
-- Name: idx_warranty_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warranty_item ON public.inv_warranty_tickets USING btree (item_id);


--
-- Name: uq_roster_hr_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_roster_hr_emp ON public.technical_team_roster USING btree (hr_employee_id) WHERE (hr_employee_id IS NOT NULL);


--
-- Name: uq_roster_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_roster_user ON public.technical_team_roster USING btree (user_account_id) WHERE (user_account_id IS NOT NULL);


--
-- Name: crm_campaign_members crm_campaign_members_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_campaign_members
    ADD CONSTRAINT crm_campaign_members_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.crm_campaigns(id);


--
-- Name: crm_campaign_members crm_campaign_members_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_campaign_members
    ADD CONSTRAINT crm_campaign_members_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.crm_customers(id);


--
-- Name: crm_communication_logs crm_communication_logs_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_communication_logs
    ADD CONSTRAINT crm_communication_logs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.crm_customers(id);


--
-- Name: crm_contact_persons crm_contact_persons_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contact_persons
    ADD CONSTRAINT crm_contact_persons_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.crm_customers(id);


--
-- Name: crm_corporate_profiles crm_corporate_profiles_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_corporate_profiles
    ADD CONSTRAINT crm_corporate_profiles_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.crm_customers(id);


--
-- Name: crm_customer_users crm_customer_users_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_customer_users
    ADD CONSTRAINT crm_customer_users_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.crm_customers(id);


--
-- Name: crm_customer_vehicles crm_customer_vehicles_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_customer_vehicles
    ADD CONSTRAINT crm_customer_vehicles_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE SET NULL;


--
-- Name: crm_devices crm_devices_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_devices
    ADD CONSTRAINT crm_devices_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.crm_customers(id);


--
-- Name: crm_individual_profiles crm_individual_profiles_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_individual_profiles
    ADD CONSTRAINT crm_individual_profiles_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.crm_customers(id);


--
-- Name: crm_leads crm_leads_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE SET NULL;


--
-- Name: crm_subscriptions crm_subscriptions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subscriptions
    ADD CONSTRAINT crm_subscriptions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.crm_customers(id);


--
-- Name: crm_ticket_actions crm_ticket_actions_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_ticket_actions
    ADD CONSTRAINT crm_ticket_actions_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.crm_tickets(id);


--
-- Name: crm_tickets crm_tickets_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tickets
    ADD CONSTRAINT crm_tickets_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.crm_customers(id);


--
-- Name: hr_benefit_plans hr_benefit_plans_cadre_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_benefit_plans
    ADD CONSTRAINT hr_benefit_plans_cadre_id_fkey FOREIGN KEY (cadre_id) REFERENCES public.hr_cadres(id);


--
-- Name: hr_documents hr_documents_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_documents
    ADD CONSTRAINT hr_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_emergency_contacts hr_emergency_contacts_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_emergency_contacts
    ADD CONSTRAINT hr_emergency_contacts_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_employees hr_employees_benefit_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_benefit_plan_id_fkey FOREIGN KEY (benefit_plan_id) REFERENCES public.hr_benefit_plans(id);


--
-- Name: hr_employees hr_employees_cadre_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_cadre_id_fkey FOREIGN KEY (cadre_id) REFERENCES public.hr_cadres(id);


--
-- Name: hr_employees hr_employees_job_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_job_role_id_fkey FOREIGN KEY (job_role_id) REFERENCES public.hr_job_roles(id);


--
-- Name: hr_employees hr_employees_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_employees hr_employees_org_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_employees
    ADD CONSTRAINT hr_employees_org_unit_id_fkey FOREIGN KEY (org_unit_id) REFERENCES public.hr_org_units(id);


--
-- Name: hr_leave_applications hr_leave_applications_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_applications
    ADD CONSTRAINT hr_leave_applications_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_leave_applications hr_leave_applications_leave_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_applications
    ADD CONSTRAINT hr_leave_applications_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.hr_leave_types(id);


--
-- Name: hr_leave_approval_log hr_leave_approval_log_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_approval_log
    ADD CONSTRAINT hr_leave_approval_log_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.hr_leave_applications(id);


--
-- Name: hr_leave_balances hr_leave_balances_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_balances
    ADD CONSTRAINT hr_leave_balances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_leave_balances hr_leave_balances_leave_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_balances
    ADD CONSTRAINT hr_leave_balances_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.hr_leave_types(id);


--
-- Name: hr_leave_entitlements hr_leave_entitlements_cadre_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_entitlements
    ADD CONSTRAINT hr_leave_entitlements_cadre_id_fkey FOREIGN KEY (cadre_id) REFERENCES public.hr_cadres(id);


--
-- Name: hr_leave_entitlements hr_leave_entitlements_leave_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_leave_entitlements
    ADD CONSTRAINT hr_leave_entitlements_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES public.hr_leave_types(id);


--
-- Name: hr_org_units hr_org_units_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_org_units
    ADD CONSTRAINT hr_org_units_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.hr_org_units(id);


--
-- Name: hr_performance_records hr_performance_records_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_performance_records
    ADD CONSTRAINT hr_performance_records_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_promotion_history hr_promotion_history_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_promotion_history
    ADD CONSTRAINT hr_promotion_history_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: hr_promotion_history hr_promotion_history_to_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_promotion_history
    ADD CONSTRAINT hr_promotion_history_to_role_id_fkey FOREIGN KEY (to_role_id) REFERENCES public.hr_job_roles(id);


--
-- Name: hr_training_records hr_training_records_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_training_records
    ADD CONSTRAINT hr_training_records_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.hr_employees(id);


--
-- Name: invoice_items invoice_items_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id);


--
-- Name: partner_contracts partner_contracts_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_contracts
    ADD CONSTRAINT partner_contracts_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE CASCADE;


--
-- Name: partner_contracts partner_contracts_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_contracts
    ADD CONSTRAINT partner_contracts_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: partner_otp partner_otp_partner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_otp
    ADD CONSTRAINT partner_otp_partner_user_id_fkey FOREIGN KEY (partner_user_id) REFERENCES public.partner_users(id) ON DELETE CASCADE;


--
-- Name: partner_sessions partner_sessions_partner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_sessions
    ADD CONSTRAINT partner_sessions_partner_user_id_fkey FOREIGN KEY (partner_user_id) REFERENCES public.partner_users(id) ON DELETE CASCADE;


--
-- Name: partner_users partner_users_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_users
    ADD CONSTRAINT partner_users_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE CASCADE;


--
-- Name: partners partners_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: partners partners_key_account_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_key_account_manager_id_fkey FOREIGN KEY (key_account_manager_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: technical_team_roster technical_team_roster_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.technical_team_roster
    ADD CONSTRAINT technical_team_roster_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: technical_team_roster technical_team_roster_hr_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.technical_team_roster
    ADD CONSTRAINT technical_team_roster_hr_employee_id_fkey FOREIGN KEY (hr_employee_id) REFERENCES public.hr_employees(id) ON DELETE SET NULL;


--
-- Name: technical_team_roster technical_team_roster_user_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.technical_team_roster
    ADD CONSTRAINT technical_team_roster_user_account_id_fkey FOREIGN KEY (user_account_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vi_inspections vi_inspections_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_inspections
    ADD CONSTRAINT vi_inspections_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.vi_installations(id);


--
-- Name: vi_otp vi_otp_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_otp
    ADD CONSTRAINT vi_otp_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.vi_installations(id);


--
-- Name: vi_photos vi_photos_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_photos
    ADD CONSTRAINT vi_photos_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.vi_installations(id);


--
-- Name: vi_stages vi_stages_installation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vi_stages
    ADD CONSTRAINT vi_stages_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.vi_installations(id);


--
-- PostgreSQL database dump complete
--

\unrestrict m8pjcpO9DbXnwY4bSgxxEd56TNVR28u5HRK5L3HLN4qLmLM9embY7utReH4kQFe

