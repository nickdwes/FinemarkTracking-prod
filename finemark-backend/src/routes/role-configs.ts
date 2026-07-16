/**
 * Role Configs — Dynamic RBAC capability management
 *
 * Stores per-role capability sets in `role_configs`. System roles are seeded
 * on startup with sensible defaults; custom roles must specify a `base_role`
 * so that API-level `requireRole()` checks can still work via `effectiveRole`.
 */

import { Router } from "express";
import { pgAll, pgGet, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { errorResponse, ok, created } from "../utils/responses.js";
import { v4 as uuidv4 } from "uuid";
import { getRoleConfig, invalidateRoleCache } from "../services/roleConfigService.js";

export { getRoleConfig, invalidateRoleCache };

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY DEFINITIONS — single source of truth for all capability strings
//
// Convention for new modules/pages: add the capability key + its `pages` here
// first (a code change), then grant it to whichever roles need it from
// admin-access-control.html (a data change — no deploy required for that part).
// Do NOT also add a parallel static entry for the new page to
// finemark-ui/assets/app.js's RBAC_ROUTES/RBAC_NAV — that recreates the
// dual-source-of-truth drift this system exists to avoid. (Note: this only
// governs frontend page access via /me's allowedPages — it has no effect on
// backend API requireRole() checks, which remain static role arrays.)
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITY_DEFS: Record<string, { label: string; pages: string[] }> = {
  // CRM
  crm_customers_view:   { label: "View Customers", pages: ["crm-customers.html", "crm-customer-360.html", "crm-records.html"] },
  crm_customers_manage: { label: "Manage Customers", pages: ["crm-register.html"] },
  crm_leads_view:       { label: "View Leads", pages: ["crm-leads.html", "crm-lead-detail.html"] },
  crm_leads_manage:     { label: "Manage Leads", pages: ["crm-leads.html", "crm-lead-detail.html"] },
  crm_leads_convert:    { label: "Convert Leads", pages: ["crm-leads.html"] },
  crm_retail_leads:     { label: "Retail Leads (Booking & Demand Requests)", pages: ["retail-leads.html", "retail-lead-detail.html", "retail-lead-new.html"] },
  crm_quotes_view:      { label: "View Quotes", pages: ["crm-quotes.html", "crm-quote-detail.html"] },
  crm_quotes_manage:    { label: "Manage Quotes", pages: ["crm-quotes.html", "crm-quote-detail.html"] },
  crm_proforma_view:    { label: "View Proforma Invoices", pages: ["crm-proforma.html"] },
  crm_proforma_manage:  { label: "Manage Proforma Invoices", pages: ["crm-proforma.html"] },
  crm_proforma_approve: { label: "Approve Proforma Invoices", pages: ["crm-proforma.html", "crm-proforma-approve.html"] },
  crm_campaigns:        { label: "Campaigns & Communications", pages: ["crm-campaigns.html", "crm-communications.html", "campaigns-mass-sms.html", "campaigns-mass-email.html"] },
  crm_partners:         { label: "Partners", pages: ["partners.html", "partner-detail.html"] },
  crm_sales_catalogue:  { label: "Product Catalogue", pages: ["sales-catalogue.html"] },
  crm_inventory_allocate: { label: "Inventory Allocation", pages: ["crm-inventory-allocate.html"] },
  // Finance
  finance_invoices_view:   { label: "View Invoices", pages: ["sales.html", "invoice-detail.html", "create-invoice.html", "invoice-inventory.html"] },
  finance_invoices_create: { label: "Create Invoices", pages: ["create-invoice.html", "invoice-inventory.html"] },
  finance_invoices_amend:  { label: "Amend Invoices", pages: ["invoice-detail.html"] },
  finance_invoices_etims:  { label: "eTIMS Signing", pages: ["invoice-detail.html"] },
  finance_payments:        { label: "Payments & Bank Transactions", pages: ["bank-transactions-report.html"] },
  finance_dashboard:       { label: "Finance Dashboard", pages: ["finance-dashboard.html"] },
  finance_invoice_dashboard: { label: "Invoice Dashboard", pages: ["finance-invoice-dashboard.html"] },
  finance_reports:         { label: "Finance Reports", pages: ["financial-reports.html", "invoice-follow-up.html", "invoice-followup.html", "sales-report-by-bank.html", "sales-performance.html"] },
  // Installation
  install_tickets_raise:       { label: "Raise Installation Tickets", pages: ["create-request.html"] },
  install_tickets_view:        { label: "View Installation Pipeline", pages: ["technical.html", "installation-ticket.html", "crm-tickets.html", "vehicle-installation.html", "installation-complete.html", "vehicle-details-check.html"] },
  install_tickets_assign:      { label: "Assign & Manage Tickets", pages: ["status-remarks.html"] },
  install_job_card:            { label: "View/Update Job Cards", pages: ["job-card.html", "job-details.html"] },
  install_job_close:           { label: "Close Jobs", pages: ["installation-ticket.html", "installation-complete.html"] },
  install_technical_dashboard: { label: "Technical Dashboard", pages: ["technical-dashboard.html", "report-technical.html"] },
  install_technician:          { label: "Technician Workspace", pages: ["technician-jobs.html", "technician.html"] },
  // Inventory
  inv_view:           { label: "View Inventory", pages: ["inventory-dashboard.html", "inventory-catalog.html"] },
  inv_manage:         { label: "Manage Inventory Items", pages: ["inventory-items.html"] },
  inv_sim_manage:     { label: "Manage SIM Cards", pages: ["inventory-sims.html"] },
  inv_sim_issue:      { label: "Issue SIM Cards to Technicians", pages: ["inventory-sim-issuance.html"] },
  inv_custody_report: { label: "Technician Custody Report", pages: ["inventory-custody-report.html"] },
  inv_procurement:    { label: "Procurement", pages: ["inventory-procurement.html"] },
  inv_warranty:       { label: "Warranty Management", pages: ["inventory-warranty.html"] },
  inv_device_custody: { label: "Device Custody (Technician)", pages: ["technician-custody.html"] },
  inv_partner_pricing:{ label: "Partner Pricing Configuration", pages: ["admin-partner-pricing.html"] },
  inv_recycle_bin:    { label: "Inventory Recycle Bin", pages: ["inventory-recycle-bin.html"] },
  inv_gadgets:        { label: "Gadget Inventory & Management", pages: ["admin-gadget-inventory.html", "admin-add-gadgets.html", "admin-assign-gadgets.html", "report-gadget-batches.html", "report-used-gadgets.html"] },
  inv_speed_governor: { label: "Speed Governor Management", pages: ["admin-add-speed-governor.html", "admin-speed-governor-reports.html"] },
  veh_data_manage:    { label: "Vehicle Master Data Sync", pages: ["vehicle-data-sync.html"] },
  // Vehicle registry — previously governed by neither the capability system
  // nor app.js's static RBAC_ROUTES fallback, so every authenticated user of
  // any role could reach these pages regardless of the backend's own (broad
  // but not unlimited) role gate on vehicles.ts.
  veh_registry_view: { label: "Vehicle Registry (Browse, Register, 360 View)", pages: ["vehicle-register.html", "vehicles-list.html", "vehicle-360.html", "vehicles-dashboard.html"] },
  // Archive — read-only historical reports migrated from the legacy system.
  // Previously only reachable via a hardcoded role list in app.js's
  // RBAC_ROUTES, with no way to manage access from admin-access-control.html.
  // Split into one capability per report (was a single archive_view covering
  // all of them) so admin-access-control.html can grant/revoke each report
  // independently per role — like every capability here, this only governs
  // frontend page/nav visibility (see the note on backend enforcement above);
  // the underlying API routes are still gated by the broader ARCHIVE_ROLES
  // array in archive.ts, unchanged.
  archive_installations_view:      { label: "Archive: Search Tracker Record",        pages: ["archive-installations.html"] },
  archive_sales_by_bank_view:      { label: "Archive: Sales Report",                 pages: ["archive-sales-by-bank.html"] },
  archive_bank_report_view:        { label: "Archive: Bank Report",                  pages: ["archive-bank-report.html"] },
  archive_technician_report_view:  { label: "Archive: Technician Report",            pages: ["archive-technician-report.html"] },
  archive_tickets_view:            { label: "Archive: Tickets Dashboard",            pages: ["archive-tickets.html"] },
  archive_audit_log_view:          { label: "Archive: Audit Log",                    pages: ["archive-audit-log.html"] },
  archive_removals_log_view:       { label: "Archive: Removal Logs",                 pages: ["archive-removals-log.html"] },
  archive_fuel_records_view:       { label: "Archive: Fuel Records",                 pages: ["archive-fuel-records.html"] },
  archive_speed_governors_view:    { label: "Archive: Speed Governor Records",       pages: ["archive-speed-governors.html"] },
  archive_gadget_batch_report_view:{ label: "Archive: Gadget Batch Report",          pages: ["archive-gadget-batch-report.html"] },
  archive_gadgets_in_store_view:   { label: "Archive: Gadgets In Store",             pages: ["archive-gadgets-in-store.html"] },
  archive_gadgets_at_hand_view:    { label: "Archive: Gadgets At Hand",              pages: ["archive-gadgets-at-hand.html"] },
  archive_sim_inventory_view:      { label: "Archive: SIM Cards Report",             pages: ["archive-sim-inventory.html"] },
  archive_retired_inventory_view:  { label: "Archive: Retired Inventory",            pages: ["archive-retired-inventory.html"] },
  archive_retired_sims_view:       { label: "Archive: Retired SIMs",                 pages: ["archive-retired-sims.html"] },
  archive_certificates_view: { label: "Archive Certificates", pages: ["archive-certificates.html"] },
  // Certificates
  cert_generate:  { label: "Generate Certificates", pages: ["certificate-dashboard.html", "create-certificate.html", "certificate-queue.html", "certificate-package.html"] },
  cert_deliver:   { label: "Deliver Certificates", pages: ["certificate-printing.html", "deliver-certificate.html"] },
  cert_view_pdf:  { label: "View Certificate PDFs", pages: ["certificate-inventory.html", "certificate-validation.html"] },
  // Executive
  exec_dashboard: { label: "Executive Dashboard", pages: ["executive-dashboard.html"] },
  // HR
  hr_dashboard:    { label: "HR Dashboard", pages: ["hr-dashboard.html"] },
  hr_self_service: { label: "HR Self-Service (Leave)", pages: ["hr-leave-apply.html", "hr-leave-calendar.html", "hr-manager-leave.html"] },
  hr_leave_approve: { label: "Approve Leave Requests", pages: ["hr-leave-approvals.html"] },
  hr_leave_config: { label: "Leave Configuration", pages: ["hr-leave-types.html", "hr-leave-balances.html", "hr-leave-reports.html"] },
  hr_employees:    { label: "HR Employee Management", pages: ["hr-employees.html", "hr-employee-profile.html", "hr-onboarding.html", "hr-org.html", "hr-employee-users.html"] },
  hr_benefits:     { label: "Benefits Management", pages: ["hr-benefits.html"] },
  hr_performance:  { label: "Performance Reviews", pages: ["hr-performance.html"] },
  hr_emp_config:   { label: "Employee Number Config", pages: ["hr-emp-no-config.html"] },
  hr_reports:      { label: "HR Reports", pages: ["hr-reports.html"] },
  // Admin
  admin_users:        { label: "User Management", pages: ["admin-users.html"] },
  admin_audit:        { label: "Audit Logs", pages: ["admin-audit-logs.html"] },
  admin_settings:     { label: "System Settings", pages: ["settings.html"] },
  admin_access:       { label: "Access Control Management", pages: ["admin-access-control.html"] },
  admin_reports:      { label: "System Reports", pages: ["report-sales.html", "report-sim-cards.html"] },
  admin_verification: { label: "Admin Verification", pages: ["admin-verification.html"] },
  admin_maker_checker:{ label: "Maker-Checker Approvals", pages: ["maker-checker.html"] },
};

// Module groupings for UI display
export const CAPABILITY_MODULES: Record<string, { label: string; capabilities: string[] }> = {
  crm:     { label: "CRM & Sales", capabilities: ["crm_customers_view","crm_customers_manage","crm_leads_view","crm_leads_manage","crm_leads_convert","crm_retail_leads","crm_quotes_view","crm_quotes_manage","crm_proforma_view","crm_proforma_manage","crm_proforma_approve","crm_campaigns","crm_partners","crm_sales_catalogue","crm_inventory_allocate"] },
  finance: { label: "Finance", capabilities: ["finance_invoices_view","finance_invoices_create","finance_invoices_amend","finance_invoices_etims","finance_payments","finance_dashboard","finance_invoice_dashboard","finance_reports"] },
  install: { label: "Installation", capabilities: ["install_tickets_raise","install_tickets_view","install_tickets_assign","install_job_card","install_job_close","install_technical_dashboard","install_technician"] },
  inv:     { label: "Inventory", capabilities: ["inv_view","inv_manage","inv_sim_manage","inv_sim_issue","inv_custody_report","inv_procurement","inv_warranty","inv_device_custody","inv_partner_pricing","inv_recycle_bin","inv_gadgets","inv_speed_governor","veh_data_manage"] },
  vehicle: { label: "Vehicle Registry", capabilities: ["veh_registry_view"] },
  archive: { label: "Archive", capabilities: [
    "archive_installations_view","archive_sales_by_bank_view","archive_bank_report_view","archive_technician_report_view",
    "archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view",
    "archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view",
    "archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view","archive_certificates_view",
  ] },
  cert:    { label: "Certificates", capabilities: ["cert_generate","cert_deliver","cert_view_pdf"] },
  exec:    { label: "Executive", capabilities: ["exec_dashboard"] },
  hr:      { label: "HR", capabilities: ["hr_dashboard","hr_self_service","hr_leave_approve","hr_leave_config","hr_employees","hr_benefits","hr_performance","hr_emp_config","hr_reports"] },
  admin:   { label: "Administration", capabilities: ["admin_users","admin_audit","admin_settings","admin_access","admin_reports","admin_verification","admin_maker_checker"] },
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CAPABILITIES PER SYSTEM ROLE
// ─────────────────────────────────────────────────────────────────────────────

const ALL_CAPABILITIES = Object.keys(CAPABILITY_DEFS);

const SYSTEM_ROLE_CAPABILITIES: Record<string, string[]> = {
  Admin: ALL_CAPABILITIES,
  Executive: [
    "crm_customers_view","crm_leads_view","crm_retail_leads","crm_quotes_view","crm_proforma_view","crm_partners","crm_sales_catalogue",
    "finance_invoices_view","finance_dashboard","finance_invoice_dashboard","finance_reports",
    "install_tickets_view","install_technical_dashboard",
    "inv_view","inv_custody_report","veh_registry_view",
    "cert_view_pdf","archive_certificates_view","archive_sales_by_bank_view",
    "exec_dashboard",
    "hr_dashboard","hr_employees","hr_reports",
    "admin_audit",
  ],
  BDM: [
    "crm_customers_view","crm_customers_manage","crm_leads_view","crm_leads_manage","crm_leads_convert","crm_retail_leads",
    "crm_quotes_view","crm_quotes_manage","crm_proforma_view","crm_proforma_manage","crm_proforma_approve",
    "crm_campaigns","crm_partners","crm_sales_catalogue",
    "finance_invoices_view","finance_invoices_create","finance_invoice_dashboard",
    "install_tickets_raise","install_tickets_view","veh_registry_view",
    "archive_installations_view","archive_bank_report_view","archive_technician_report_view","archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view","archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view","archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view",
    "hr_self_service",
  ],
  BDMCorporate: [
    "crm_customers_view","crm_customers_manage","crm_leads_view","crm_leads_manage","crm_leads_convert","crm_retail_leads",
    "crm_quotes_view","crm_quotes_manage","crm_proforma_view","crm_proforma_manage","crm_proforma_approve",
    "crm_campaigns","crm_partners","crm_sales_catalogue",
    "finance_invoices_view","finance_invoices_create","finance_invoice_dashboard",
    "install_tickets_raise","install_tickets_view","veh_registry_view",
    "archive_installations_view","archive_bank_report_view","archive_technician_report_view","archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view","archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view","archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view",
    "hr_self_service",
  ],
  CorporateSales: [
    "crm_customers_view","crm_customers_manage","crm_leads_view","crm_leads_manage","crm_leads_convert","crm_retail_leads",
    "crm_quotes_view","crm_quotes_manage","crm_proforma_view","crm_proforma_manage",
    "crm_sales_catalogue",
    "finance_invoices_view","finance_invoices_create","finance_invoice_dashboard",
    "install_tickets_raise","install_tickets_view","veh_registry_view",
    "archive_installations_view","archive_bank_report_view","archive_technician_report_view","archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view","archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view","archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view",
    "hr_self_service",
  ],
  KAM: [
    "crm_customers_view","crm_leads_view","crm_leads_manage","crm_leads_convert","crm_retail_leads",
    "crm_quotes_view","crm_quotes_manage","crm_proforma_view","crm_proforma_manage","crm_partners",
    "crm_sales_catalogue",
    "finance_invoices_view",
    "install_tickets_raise","install_tickets_view","veh_registry_view",
    "archive_installations_view","archive_bank_report_view","archive_technician_report_view","archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view","archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view","archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view",
    "hr_self_service",
  ],
  Telesales: [
    "crm_customers_view","crm_leads_view","crm_leads_manage","crm_retail_leads",
    "crm_quotes_view","crm_quotes_manage","crm_proforma_view",
    "crm_campaigns","crm_sales_catalogue",
    "finance_invoices_view","finance_invoice_dashboard",
    "install_tickets_raise","veh_registry_view",
    "archive_installations_view","archive_bank_report_view","archive_technician_report_view","archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view","archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view","archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view",
    "hr_self_service",
  ],
  InventoryManager: [
    "crm_customers_view","crm_leads_view",
    "crm_inventory_allocate",
    "inv_view","inv_manage","inv_sim_manage","inv_sim_issue","inv_custody_report",
    "inv_procurement","inv_warranty","inv_device_custody","inv_partner_pricing","inv_recycle_bin",
    "inv_gadgets","inv_speed_governor","veh_data_manage","veh_registry_view",
    "archive_installations_view","archive_bank_report_view","archive_technician_report_view","archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view","archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view","archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view","archive_certificates_view",
    "hr_self_service",
  ],
  Technician: [
    "crm_customers_view","crm_leads_view",
    "install_tickets_view","install_job_card","install_technician","veh_registry_view",
    "inv_view","inv_device_custody",
    "archive_certificates_view",
    "hr_self_service",
  ],
  Technical: [
    "install_tickets_view","install_tickets_assign","install_job_card","install_job_close","install_technical_dashboard",
    "crm_inventory_allocate","veh_registry_view",
    "inv_view","inv_custody_report",
    "cert_view_pdf","archive_certificates_view",
    "hr_self_service",
  ],
  InstallOffice: [
    "crm_customers_view",
    "install_tickets_view","install_tickets_assign","install_job_close","install_technical_dashboard",
    "crm_inventory_allocate","veh_registry_view",
    "inv_view","inv_custody_report",
    "hr_self_service",
  ],
  CertAdmin: [
    "crm_customers_view",
    "install_tickets_view","veh_registry_view",
    "cert_generate","cert_deliver","cert_view_pdf","archive_installations_view","archive_bank_report_view","archive_technician_report_view","archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view","archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view","archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view","archive_certificates_view",
    "hr_self_service",
  ],
  Finance: [
    "crm_customers_view","crm_quotes_view","crm_proforma_view","crm_proforma_approve",
    "finance_invoices_view","finance_invoices_create","finance_invoices_amend","finance_invoices_etims",
    "finance_payments","finance_dashboard","finance_invoice_dashboard","finance_reports",
    "install_tickets_view","veh_registry_view",
    "inv_view","inv_procurement",
    "archive_installations_view","archive_bank_report_view","archive_technician_report_view","archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view","archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view","archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view","archive_certificates_view",
    "admin_maker_checker",
    "hr_self_service",
  ],
  HR: [
    "hr_dashboard","hr_self_service","hr_leave_approve","hr_leave_config",
    "hr_employees","hr_benefits","hr_performance","hr_emp_config","hr_reports",
    "veh_registry_view","archive_certificates_view",
  ],
};

// Role display metadata
const SYSTEM_ROLE_META: Record<string, { displayName: string; description: string; badgeColor: string }> = {
  Admin:           { displayName: "Administrator",         description: "Full system access — no route or data restrictions.",             badgeColor: "#dc2626" },
  Executive:       { displayName: "Executive",             description: "Full read + transaction; no system configuration.",              badgeColor: "#7c3aed" },
  BDM:             { displayName: "Business Dev. Manager (Retail)",  description: "Full CRM, partners, campaigns, and retail sales pipeline.",   badgeColor: "#0891b2" },
  BDMCorporate:    { displayName: "Business Dev. Manager (Corporate)", description: "Full CRM, partners, campaigns, and corporate sales pipeline.", badgeColor: "#0e7490" },
  CorporateSales:  { displayName: "Corporate Sales",       description: "Own customers & leads only (ABAC-scoped).",                     badgeColor: "#0891b2" },
  KAM:             { displayName: "Key Account Manager",   description: "Partner-scoped CRM visibility.",                               badgeColor: "#0891b2" },
  Telesales:       { displayName: "Telesales",             description: "Assigned leads, quotes, invoices, campaigns.",                  badgeColor: "#0891b2" },
  InventoryManager:{ displayName: "Inventory Manager",     description: "Full inventory module + device issuance.",                      badgeColor: "#ea580c" },
  Technician:      { displayName: "Technician",            description: "Field technician — leads up to qualification, assigned jobs.",  badgeColor: "#16a34a" },
  Technical:       { displayName: "ISO / Technical",       description: "Installation Support Officer — technical pipeline + certs.",    badgeColor: "#16a34a" },
  InstallOffice:   { displayName: "Install Office",        description: "Installation scheduling, ticket assignment, job closure.",      badgeColor: "#16a34a" },
  CertAdmin:       { displayName: "Certificate Admin",     description: "Certificate pipeline: generate, edit, deliver.",              badgeColor: "#d97706" },
  Finance:         { displayName: "Finance",               description: "Finance dashboards, invoice management, procurement.",         badgeColor: "#2563eb" },
  HR:              { displayName: "HR Manager",            description: "Full HR module administration.",                               badgeColor: "#db2777" },
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA INIT & SEED
// ─────────────────────────────────────────────────────────────────────────────

export async function initRoleConfigsSchema(): Promise<void> {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS role_configs (
      id              TEXT PRIMARY KEY,
      role_key        TEXT UNIQUE NOT NULL,
      display_name    TEXT NOT NULL,
      base_role       TEXT,
      is_system       INTEGER NOT NULL DEFAULT 0,
      description     TEXT,
      badge_color     TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
  `, []);

  // Seed system roles once. DO NOTHING on conflict — a role's row, once it exists,
  // is owned by admin-access-control.html from then on; an admin's capability edits
  // must survive restarts/deploys, not get silently reseeded back to code defaults.
  // (A new system role added to SYSTEM_ROLE_META in the future still inserts cleanly
  // since its row doesn't exist yet.)
  const now = new Date().toISOString();
  for (const [roleKey, meta] of Object.entries(SYSTEM_ROLE_META)) {
    const caps = SYSTEM_ROLE_CAPABILITIES[roleKey] ?? [];
    await pgRun(
      `INSERT INTO role_configs (id, role_key, display_name, base_role, is_system, description, badge_color, capabilities_json, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, 1, $4, $5, $6, $7, $7)
       ON CONFLICT (role_key) DO NOTHING`,
      [uuidv4(), roleKey, meta.displayName, meta.description, meta.badgeColor, JSON.stringify(caps), now],
    );
  }
}

// Capability keys added to CAPABILITY_DEFS after a role's row already existed
// (i.e. after the DB was first seeded) never reach that row — the INSERT
// above is ON CONFLICT DO NOTHING, by design, so an admin's later edits in
// admin-access-control.html always survive restarts. That means every new
// capability key needs one additive, idempotent backfill pass here: merge it
// into a role's stored capabilities_json only if that role's *current code*
// default (SYSTEM_ROLE_CAPABILITIES) includes it and the stored row doesn't
// have it yet. Never removes a key — an admin may have deliberately revoked
// a default capability, and this must not silently re-grant it.
const CAPABILITY_BACKFILL_KEYS = ["veh_registry_view", "archive_installations_view","archive_sales_by_bank_view","archive_bank_report_view","archive_technician_report_view","archive_tickets_view","archive_audit_log_view","archive_removals_log_view","archive_fuel_records_view","archive_speed_governors_view","archive_gadget_batch_report_view","archive_gadgets_in_store_view","archive_gadgets_at_hand_view","archive_sim_inventory_view","archive_retired_inventory_view","archive_retired_sims_view", "archive_certificates_view"];

export async function backfillNewRoleCapabilities(): Promise<void> {
  const rows = await pgAll(`SELECT role_key, capabilities_json FROM role_configs WHERE is_system = 1`, []);
  const now = new Date().toISOString();
  for (const row of rows as any[]) {
    const defaults = SYSTEM_ROLE_CAPABILITIES[row.role_key];
    if (!defaults) continue;
    const toGrant = defaults.filter((c) => CAPABILITY_BACKFILL_KEYS.includes(c));
    if (!toGrant.length) continue;
    const current: string[] = JSON.parse(row.capabilities_json ?? "[]");
    const merged = Array.from(new Set([...current, ...toGrant]));
    if (merged.length === current.length) continue;
    await pgRun(
      `UPDATE role_configs SET capabilities_json = $1, updated_at = $2 WHERE role_key = $3`,
      [JSON.stringify(merged), now, row.role_key],
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ONLY = requireRole(ROLE_GROUPS.ADMIN_ONLY);

/** GET /api/admin/role-configs — list all roles */
router.get("/", requireAuth, ADMIN_ONLY, async (_req, res) => {
  const rows = await pgAll(
    `SELECT id, role_key, display_name, base_role, is_system, description, badge_color, capabilities_json, created_at, updated_at
     FROM role_configs ORDER BY is_system DESC, display_name ASC`,
    [],
  );
  const data = rows.map((r: any) => ({
    ...r,
    is_system: Boolean(r.is_system),
    capabilities: JSON.parse(r.capabilities_json ?? "[]"),
  }));
  return ok(res, { roles: data });
});

/** GET /api/admin/role-configs/capability-definitions — module & capability manifest */
router.get("/capability-definitions", requireAuth, async (_req, res) => {
  return ok(res, { modules: CAPABILITY_MODULES, capabilities: CAPABILITY_DEFS });
});

/** POST /api/admin/role-configs — create a custom role */
router.post("/", requireAuth, ADMIN_ONLY, async (req: AuthRequest, res) => {
  const { roleKey, displayName, baseRole, description, badgeColor, capabilities } = req.body ?? {};

  if (!roleKey || !displayName || !baseRole) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "roleKey, displayName and baseRole are required.");
  }

  // base_role must be a system role
  const baseSystemRoles = Object.keys(SYSTEM_ROLE_META);
  if (!baseSystemRoles.includes(baseRole)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", `baseRole must be one of: ${baseSystemRoles.join(", ")}`);
  }

  // Validate roleKey format: lowercase alphanumeric + underscores only
  if (!/^[a-z][a-z0-9_]*$/.test(roleKey)) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "roleKey must be lowercase alphanumeric with underscores.");
  }

  // Check uniqueness
  const existing = await pgGet("SELECT id FROM role_configs WHERE role_key = $1", [roleKey]);
  if (existing) {
    return errorResponse(res, 409, "CONFLICT", "A role with that key already exists.");
  }

  const caps: string[] = Array.isArray(capabilities)
    ? capabilities.filter((c: string) => c in CAPABILITY_DEFS)
    : [];

  const now = new Date().toISOString();
  const id = uuidv4();
  await pgRun(
    `INSERT INTO role_configs (id, role_key, display_name, base_role, is_system, description, badge_color, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $8)`,
    [id, roleKey, displayName, baseRole, description ?? null, badgeColor ?? "#6b7280", JSON.stringify(caps), now],
  );

  const newRow = await pgGet("SELECT * FROM role_configs WHERE id = $1", [id]);
  return created(res, { role: { ...newRow, is_system: false, capabilities: caps } });
});

/** PATCH /api/admin/role-configs/:id — update a role's metadata/capabilities */
router.patch("/:id", requireAuth, ADMIN_ONLY, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const row = await pgGet("SELECT * FROM role_configs WHERE id = $1", [id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Role not found.");

  const { displayName, description, badgeColor, capabilities } = req.body ?? {};
  const updates: string[] = [];
  const params: any[] = [];

  if (displayName !== undefined) { updates.push(`display_name = $${params.length + 1}`); params.push(displayName); }
  if (description !== undefined) { updates.push(`description = $${params.length + 1}`); params.push(description); }
  if (badgeColor !== undefined)  { updates.push(`badge_color = $${params.length + 1}`); params.push(badgeColor); }
  if (Array.isArray(capabilities)) {
    const caps = capabilities.filter((c: string) => c in CAPABILITY_DEFS);
    updates.push(`capabilities_json = $${params.length + 1}`);
    params.push(JSON.stringify(caps));
  }

  if (updates.length === 0) return errorResponse(res, 400, "VALIDATION_ERROR", "Nothing to update.");

  const now = new Date().toISOString();
  updates.push(`updated_at = $${params.length + 1}`);
  params.push(now);
  params.push(id);

  await pgRun(`UPDATE role_configs SET ${updates.join(", ")} WHERE id = $${params.length}`, params);

  // Invalidate cache so auth middleware picks up new capabilities
  invalidateRoleCache(row.role_key);

  const updated = await pgGet("SELECT * FROM role_configs WHERE id = $1", [id]);
  return ok(res, {
    role: {
      ...updated,
      is_system: Boolean(updated.is_system),
      capabilities: JSON.parse(updated.capabilities_json ?? "[]"),
    },
  });
});

/** DELETE /api/admin/role-configs/:id — delete a custom role */
router.delete("/:id", requireAuth, ADMIN_ONLY, async (_req, res) => {
  const { id } = _req.params;
  const row = await pgGet("SELECT * FROM role_configs WHERE id = $1", [id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Role not found.");
  if (row.is_system) return errorResponse(res, 400, "VALIDATION_ERROR", "Cannot delete a system role.");

  await pgRun("DELETE FROM role_configs WHERE id = $1", [id]);
  invalidateRoleCache(row.role_key);
  return ok(res, { message: "Role deleted." });
});

export default router;
