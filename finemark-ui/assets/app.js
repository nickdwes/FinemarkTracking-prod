(() => {
  const CONFIG = {
    API_BASE_URL: `/api`,
    MOCK_MODE: false,
    ADMIN_CAN_ACCESS_ALL_DASHBOARDS: true,
    AUTH_LIVE: true,
    LIVE_AUTH_ONLY: true,
    LIVE_CRM_AND_FINANCE: true,
    LIVE_ENDPOINTS: [
      "/auth/",
      "/users",
      "/crm/",
      "/invoices",
      "/payments",
      "/finance/",
      "/audit-logs",
      "/me",
      "/speed-governors",
      "/certificates",
      "/vehicle-installations",
      "/inventory/",
      "/partners",
      "/partner-portal",
      "/partner-dashboards",
      "/installation-tickets",

      "/technical-team",
      "/sales-intelligence",
    ],
  };

  // CEO/DIRECTOR/EXEC_MGT below were invented placeholders that never matched
  // any real backend role — the actual canonical role for that whole tier is
  // just "Executive" (see rbac.ts's ROLES). Kept as deprecated aliases of
  // EXECUTIVE (rather than deleted outright) so any other file still
  // referencing them by name doesn't break; every RBAC_ROUTES/RBAC_NAV entry
  // in this file now uses ROLES.EXECUTIVE directly. HR/KAM/CORPORATE_SALES
  // were simply missing — real, assignable backend roles with no frontend
  // constant, so no RBAC_ROUTES entry could ever grant them page access.
  // PROCUREMENT/WAREHOUSE map to backend role strings that are real but
  // currently unassignable to any user (reserved, not deleted — see
  // vehicles.ts/inventory-procurement.ts) — kept for the same reason.
  const ROLES = Object.freeze({
    SALES: "Sales",
    TECHNICAL: "Technical",
    TECHNICIAN: "Technician",
    ADMIN: "Admin",
    FINANCE: "Finance",
    INVENTORY_MGR: "InventoryManager",
    PROCUREMENT: "Procurement",
    WAREHOUSE: "WarehouseOfficer",
    EXECUTIVE: "Executive",
    CEO: "Executive",
    DIRECTOR: "Executive",
    EXEC_MGT: "Executive",
    TEAM_LEAD: "TeamLead",
    TELESALES: "Telesales",
    FIELD_SALES: "FieldSales",
    BDM: "BDM",
    BDM_CORPORATE: "BDMCorporate",
    INSTALL_OFFICE: "InstallOffice",
    CERT_ADMIN: "CertAdmin",
    HR: "HR",
    KAM: "KAM",
    CORPORATE_SALES: "CorporateSales",
  });

  const RBAC_ROUTES = Object.freeze({
    "sales.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "create-request.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INSTALL_OFFICE],
    "create-invoice.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "finance-payment-reports.html": [ROLES.ADMIN, ROLES.FINANCE, ROLES.EXECUTIVE],
    "sales-commission.html": [ROLES.ADMIN, ROLES.FINANCE, ROLES.EXECUTIVE],
    "invoice-inventory.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-records.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-customers.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "crm-register.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "crm-customer-360.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "crm-campaigns.html": [ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.TELESALES],
    "crm-communications.html": [ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.TELESALES],
    "campaigns-mass-sms.html": [ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.TELESALES],
    "campaigns-mass-email.html": [ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.TELESALES],
    "crm-leads.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-lead-detail.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "retail-leads.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "retail-lead-new.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "retail-lead-detail.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-quotes.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-quote-detail.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.TECHNICAL, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-proforma.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-inventory-allocate.html": [ROLES.TECHNICAL, ROLES.ADMIN],
    "technical.html": [ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.ADMIN, ROLES.INSTALL_OFFICE],
    "installation-ticket.html": [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE],
    "crm-tickets.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.BDM_CORPORATE, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE, ROLES.ADMIN, ROLES.FINANCE, "Support", "Operations", "technical_manager"],
    "crm-ticket-new.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.BDM_CORPORATE, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE, ROLES.ADMIN, ROLES.FINANCE, "Support", "Operations", "technical_manager"],
    "crm-ticket-detail.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.BDM_CORPORATE, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE, ROLES.ADMIN, ROLES.FINANCE, "Support", "Operations", "technical_manager"],
    "gps-uninstall-queue.html": [ROLES.ADMIN, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE, ROLES.FINANCE, "technical_manager"],
    "support-dashboard.html": [ROLES.ADMIN, ROLES.TECHNICAL, ROLES.FINANCE, "Support", "Operations"],
    "admin-ticket-categories.html": [ROLES.ADMIN],
    "admin-vehicle-approvals.html": [ROLES.ADMIN],
    "admin-device-swap.html": [ROLES.ADMIN],
    "technician-jobs.html": [ROLES.TECHNICIAN, ROLES.ADMIN],
    "job-details.html": [ROLES.TECHNICIAN, ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE, ROLES.CERT_ADMIN],
    "job-card.html": [ROLES.TECHNICIAN, ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE],
    "confirmation.html": [ROLES.TECHNICIAN, ROLES.ADMIN],
    "signature.html": [ROLES.TECHNICIAN, ROLES.ADMIN],
    "otp.html": [ROLES.TECHNICIAN, ROLES.ADMIN],
    "admin.html": [ROLES.ADMIN],
    "admin-users.html": [ROLES.ADMIN],
    "certificate-dashboard.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "certificate-metrics.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "certificate-recyclebin.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "create-certificate.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "certificate-inventory.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "certificate-queue.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "certificate-package.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "certificate-printing.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "deliver-certificate.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "admin-audit-logs.html": [ROLES.ADMIN],
    "admin-access-control.html": [ROLES.ADMIN],
    "finance-dashboard.html": [ROLES.FINANCE, ROLES.ADMIN],
    "finance-invoice-dashboard.html": [ROLES.FINANCE, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES],
    "invoice-followup.html": [ROLES.FINANCE, ROLES.ADMIN],
    "financial-reports.html": [ROLES.FINANCE, ROLES.ADMIN],
    "payment-processing.html": [ROLES.FINANCE, ROLES.ADMIN],
    "invoice-follow-up.html": [ROLES.FINANCE, ROLES.ADMIN],
    "sales-performance.html": [ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.ADMIN, ROLES.CORPORATE_SALES],
    "sales-dashboard.html": [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.KAM, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES],
    "sales-reports.html": [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.KAM, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES],
    // Customer-service view of the post-sale journey — wider audience than the
    // sales reports (support + technical/installation need it too).
    "customer-service-reports.html": [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.HR, ROLES.FINANCE, ROLES.TECHNICAL, ROLES.INSTALL_OFFICE, ROLES.CERT_ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.KAM, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, "Support", "Operations", "technical_manager"],
    "customer-vehicle-report.html": [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.HR, ROLES.FINANCE, ROLES.TECHNICAL, ROLES.INSTALL_OFFICE, ROLES.CERT_ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.KAM, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, "Support", "Operations", "technical_manager"],
    "sales-report-by-bank.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "report-gadget-batches.html": [ROLES.ADMIN],
    "admin-add-gadgets.html": [ROLES.ADMIN],
    "admin-gadget-inventory.html": [ROLES.ADMIN],
    "admin-add-speed-governor.html": [ROLES.ADMIN],
    "admin-speed-governor-reports.html": [ROLES.ADMIN],
    "admin-assign-gadgets.html": [ROLES.ADMIN],
    "report-sales.html": [ROLES.ADMIN],
    "report-sim-cards.html": [ROLES.ADMIN],
    "report-technical.html": [ROLES.ADMIN],
    "report-used-gadgets.html": [ROLES.ADMIN],
    "profile.html": [ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.FINANCE, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT, ROLES.WAREHOUSE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INSTALL_OFFICE],
    "settings.html": [ROLES.ADMIN],
    "inventory-dashboard.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR, ROLES.WAREHOUSE, ROLES.PROCUREMENT],
    "inventory-reports.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR, ROLES.WAREHOUSE, ROLES.PROCUREMENT],
    "inventory-catalog.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT],
    "inventory-items.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR, ROLES.WAREHOUSE],
    "inventory-procurement.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT],
    "inventory-warranty.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR, ROLES.WAREHOUSE, ROLES.TECHNICAL],
    "vehicle-data-sync.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR],
    "vehicle-attribute-entries.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR],
    "technician-custody.html": [ROLES.TECHNICIAN, ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE, "technical_manager"],
    "executive-dashboard.html": [ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.ADMIN],
    "invoice-detail.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.TECHNICAL, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "vehicle-installation.html": [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.INSTALL_OFFICE],
    "technical-dashboard.html": [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE],
    "hr-employee-users.html": [ROLES.ADMIN],
    "hr-leave-apply.html": [ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.FINANCE, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT, ROLES.WAREHOUSE, ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INSTALL_OFFICE, ROLES.HR, ROLES.CERT_ADMIN, "Management", "technical_manager"],
    "hr-leave-calendar.html": [ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.FINANCE, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT, ROLES.WAREHOUSE, ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INSTALL_OFFICE, ROLES.HR, ROLES.CERT_ADMIN, "Management", "technical_manager"],
    "hr-manager-leave.html": [ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.FINANCE, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT, ROLES.WAREHOUSE, ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INSTALL_OFFICE, ROLES.HR, ROLES.CERT_ADMIN, "Management", "technical_manager"],
    "hr-leave-approvals.html": [ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.HR, ROLES.TECHNICAL, "technical_manager"],
    "certificate-validation.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "certificate-bank-settings.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "cert-extension.html": [ROLES.ADMIN, ROLES.CERT_ADMIN, ROLES.SALES, ROLES.CORPORATE_SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.BDM, ROLES.BDM_CORPORATE],
    "cert-extension-requests.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "doc-bank-settings.html": [ROLES.ADMIN, ROLES.FINANCE, ROLES.CERT_ADMIN],
    "status-remarks.html": [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE],
    "partners.html": [ROLES.SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE],
    "partner-detail.html": [ROLES.SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.TECHNICAL, ROLES.BDM, ROLES.BDM_CORPORATE],
    "admin-partner-pricing.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR],
    "inventory-recycle-bin.html": [ROLES.ADMIN],
    "inventory-mass-topup.html": [ROLES.ADMIN, ROLES.INVENTORY_MGR],
    "invoice-print.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.TECHNICAL, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "quote-print.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-quote-print.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.TECHNICAL, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "archive-installations.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-sales-by-bank.html": [ROLES.ADMIN, ROLES.EXECUTIVE],
    "archive-bank-report.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-technician-report.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-tickets.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-audit-log.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-removals-log.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-fuel-records.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-speed-governors.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-gadget-batch-report.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-gadgets-in-store.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-gadgets-at-hand.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-sim-inventory.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-certificates.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.CERT_ADMIN],
    "archive-retired-inventory.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INVENTORY_MGR, ROLES.CERT_ADMIN],
    "archive-retired-sims.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INVENTORY_MGR, ROLES.CERT_ADMIN],
  });

  const RBAC_NAV = Object.freeze({
    Dashboard: [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.INSTALL_OFFICE, ROLES.CERT_ADMIN],
    Sales: [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE],
    Technical: [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE],
    Technician: [ROLES.TECHNICIAN, ROLES.ADMIN],
    Finance: [ROLES.FINANCE, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES],
    Admin: [ROLES.ADMIN],
    Certificates: [ROLES.ADMIN, ROLES.CERT_ADMIN],
    Gadgets: [ROLES.ADMIN],
    Inventory: [ROLES.ADMIN, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT, ROLES.WAREHOUSE],
    Executive: [ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.ADMIN],
    Partners: [ROLES.SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.TECHNICAL, ROLES.BDM, ROLES.BDM_CORPORATE],
    Communication: [ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.TELESALES],
    AllStaff: [ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.FINANCE, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT, ROLES.WAREHOUSE, ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.INSTALL_OFFICE],
    TeamLead: [ROLES.TEAM_LEAD, ROLES.ADMIN],
    Archive: [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.INVENTORY_MGR, ROLES.CERT_ADMIN],
  });

  const PUBLIC_PAGES = Object.freeze([
    "login.html",
    "forgot-password.html",
    "reset-sent.html",
    "reset-password.html",
    "reset-success.html",
    "index.html",
    "unauthorized.html",
  ]);

  const STORAGE_KEYS = {
    SESSION: "finemark_session",
    USERS: "finemark_users",
    INSTALLATIONS: "finemark_installations",
    CRM_RECORDS: "finemark_crm_records",
    INVOICES: "finemark_invoices",
    PAYMENTS: "finemark_payments",
    AUDIT_LOGS: "finemark_audit_logs",
    REFRESH_TOKENS: "finemark_refresh_tokens",
    PASSWORD_RESETS: "finemark_password_resets",
  };

  const normalizeRole = (role) => {
    if (!role) return null;
    const lower = role.toLowerCase();
    if (lower === "sales") return ROLES.SALES;
    if (lower === "telesales") return ROLES.TELESALES;
    if (lower === "fieldsales" || lower === "field_sales" || lower === "field sales") return ROLES.FIELD_SALES;
    if (lower === "technical") return ROLES.TECHNICAL;
    if (lower === "technician") return ROLES.TECHNICIAN;
    if (lower === "admin") return ROLES.ADMIN;
    if (lower === "finance") return ROLES.FINANCE;
    return role;
  };

  const getSession = () => {
    try {
      const session = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION));
      if (session && session.user) {
        return {
          ...session,
          user: { ...session.user, role: normalizeRole(session.user.role) },
        };
      }
    } catch (error) {
      // ignore
    }
    try {
      const legacyUser = JSON.parse(localStorage.getItem("finemarkUser"));
      if (legacyUser && legacyUser.email && legacyUser.role) {
        return { user: { ...legacyUser, role: normalizeRole(legacyUser.role) } };
      }
    } catch (error) {
      // ignore
    }
    return null;
  };

  const setSession = (session) => {
    localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(session));
    if (session?.user?.email && session?.user?.role) {
      localStorage.setItem(
        "finemarkUser",
        JSON.stringify({ email: session.user.email, role: session.user.role.toLowerCase() })
      );
    }
  };

  const clearSession = () => {
    localStorage.removeItem(STORAGE_KEYS.SESSION);
    localStorage.removeItem("finemarkUser");
  };

  const showToast = (message, type = "success") => {
    let container = document.getElementById("fm-toast-root");
    if (!container) {
      container = document.createElement("div");
      container.id = "fm-toast-root";
      container.className = "fixed top-4 right-4 z-50 space-y-2";
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    const color =
      type === "error" ? "bg-rose-600" : type === "info" ? "bg-blue-600" : "bg-emerald-600";
    toast.className = `${color} text-white text-sm px-4 py-2 rounded-lg shadow-lg`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  };

  const formatKES = (amount) => {
    const value = Number(amount);
    const safeValue = Number.isFinite(value) ? value : 0;
    return `KES ${safeValue.toLocaleString("en-KE")}`;
  };

  // Label for a vehicle in a picker/dropdown. Registration is the natural
  // identifier, but ~16% of vehicles are recorded before they are registered
  // (registration_known = false) — for those the plate is blank and a label
  // built from make/model alone is ambiguous: a customer with two unregistered
  // FAWs got two identical "FAW" options, so a rep could quote against the
  // wrong vehicle. Fall back to the chassis number, which is what actually
  // distinguishes them. Accepts either the API's camelCase or a raw DB row.
  const vehicleLabel = (v) => {
    if (!v) return "";
    const reg = String(v.registration || "").trim();
    const chassis = String(v.chassisNumber ?? v.chassis_number ?? "").trim();
    const identity = reg || (chassis ? `Chassis ${chassis}` : "Unregistered");
    const makeModel = [v.make, v.model].filter(Boolean).join(" ");
    const year = v.yearOfManufacture ?? v.year_of_manufacture;
    return [identity, makeModel, year ? `(${year})` : ""].filter(Boolean).join(" — ");
  };

  // Shared across hr-leave-approvals.html / hr-manager-leave.html / hr-leave-apply.html
  // so the badge stays consistent everywhere a leave application status is shown.
  const HR_LEAVE_STATUS_LABEL = {
    Pending: "Pending",
    PendingL2: "Awaiting HR Countersign",
    Approved: "Approved",
    Rejected: "Rejected",
    Cancelled: "Cancelled",
  };
  const HR_LEAVE_STATUS_COLOR = {
    Pending: "bg-amber-50 text-amber-700 border-amber-200",
    PendingL2: "bg-sky-50 text-sky-700 border-sky-200",
    Approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    Rejected: "bg-rose-50 text-rose-700 border-rose-200",
    Cancelled: "bg-slate-100 text-slate-500 border-slate-200",
  };
  const renderLeaveStatusBadge = (status) => {
    const cls = HR_LEAVE_STATUS_COLOR[status] || "";
    const label = HR_LEAVE_STATUS_LABEL[status] || status;
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}">${label}</span>`;
  };

  const Validators = {
    required: (value, msg = "This field is required.") => (value ? null : msg),
    email: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "") ? null : "Enter a valid email."),
    minLen: (value, n) => (value && value.length >= n ? null : `Must be at least ${n} characters.`),
    passwordPolicy: (value) => {
      if (!value || value.length < 8) return "Password must be at least 8 characters.";
      if (!/[A-Z]/.test(value)) return "Password must include an uppercase letter.";
      if (!/[0-9]/.test(value)) return "Password must include a number.";
      return null;
    },
    dateRange: (start, end) => {
      if (!start || !end) return null;
      return new Date(start).getTime() <= new Date(end).getTime()
        ? null
        : "Start date must be before end date.";
    },
    phoneOptional: (value) => {
      if (!value) return null;
      return /^[0-9+\-()\\s]{7,20}$/.test(value) ? null : "Enter a valid phone number.";
    },
  };

  const setFieldError = (inputEl, message) => {
    if (!inputEl) return;
    inputEl.classList.add("border-red-500");
    inputEl.classList.add("focus:ring-red-500");
    inputEl.classList.remove("focus:ring-blue-500/40");
    const name = inputEl.name || inputEl.id || inputEl.dataset?.field;
    const errorEl =
      inputEl.closest("form")?.querySelector(`[data-error-for="${name}"]`) ||
      inputEl.parentElement?.querySelector(`[data-error="${name}"]`) ||
      inputEl.parentElement?.querySelector(".fm-error");
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove("hidden");
      errorEl.classList.add("text-red-600", "text-sm", "mt-1");
    }
  };

  const clearFieldError = (inputEl) => {
    if (!inputEl) return;
    inputEl.classList.remove("border-red-500");
    inputEl.classList.remove("focus:ring-red-500");
    inputEl.classList.add("focus:ring-blue-500/40");
    const name = inputEl.name || inputEl.id || inputEl.dataset?.field;
    const errorEl =
      inputEl.closest("form")?.querySelector(`[data-error-for="${name}"]`) ||
      inputEl.parentElement?.querySelector(`[data-error="${name}"]`) ||
      inputEl.parentElement?.querySelector(".fm-error");
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.classList.add("hidden");
    }
  };

  const clearFormErrors = (formEl) => {
    if (!formEl) return;
    formEl.querySelectorAll(".fm-error,[data-error-for]").forEach((el) => {
      el.textContent = "";
      el.classList.add("hidden");
    });
    formEl.querySelectorAll("input,select,textarea").forEach((input) => clearFieldError(input));
  };

  const applyFieldErrors = (formEl, details = {}) => {
    const fieldErrors = details.fieldErrors || details;
    if (!formEl || !fieldErrors) return;
    Object.entries(fieldErrors).forEach(([field, message]) => {
      const input = formEl.querySelector(`[name="${field}"],#${field},[data-field="${field}"]`);
      if (input) {
        setFieldError(input, Array.isArray(message) ? message[0] : message);
      }
    });
  };

  const showInlineError = (containerEl, message, options = {}) => {
    if (!containerEl) return;
    const { retryText = "Retry", onRetry } = options;
    containerEl.innerHTML = `
      <div class="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 flex items-center justify-between gap-4">
        <span>${message}</span>
        ${onRetry ? `<button class="fm-retry rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700">${retryText}</button>` : ""}
      </div>
    `;
    if (onRetry) {
      const btn = containerEl.querySelector(".fm-retry");
      if (btn) {
        btn.addEventListener("click", () => {
          onRetry();
        });
      }
    }
  };

  const setLoading = (buttonEl, isLoading, loadingText = "Loading...") => {
    if (!buttonEl) return;
    if (isLoading) {
      buttonEl.dataset.originalText = buttonEl.textContent;
      buttonEl.disabled = true;
      buttonEl.classList.add("opacity-70", "cursor-not-allowed");
      buttonEl.innerHTML = `
        <span class="inline-flex items-center gap-2">
          <span class="h-4 w-4 animate-spin rounded-full border-2 border-white/60 border-t-white"></span>
          ${loadingText}
        </span>
      `;
    } else {
      buttonEl.disabled = false;
      buttonEl.classList.remove("opacity-70", "cursor-not-allowed");
      const original = buttonEl.dataset.originalText;
      buttonEl.textContent = original || buttonEl.textContent;
    }
  };

  const renderSkeleton = (containerEl, type = "list") => {
    if (!containerEl) return;
    if (type === "table") {
      containerEl.innerHTML = `
        <div class="animate-pulse space-y-3">
          <div class="h-4 bg-slate-200 rounded w-2/3"></div>
          <div class="h-4 bg-slate-200 rounded w-1/2"></div>
          <div class="h-4 bg-slate-200 rounded w-5/6"></div>
        </div>
      `;
      return;
    }
    if (type === "cards") {
      containerEl.innerHTML = `
        <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          ${Array.from({ length: 3 })
            .map(
              () => `
            <div class="rounded-xl border border-slate-200 bg-white p-4 animate-pulse">
              <div class="h-4 bg-slate-200 rounded w-1/2 mb-3"></div>
              <div class="h-6 bg-slate-200 rounded w-2/3"></div>
            </div>
          `
            )
            .join("")}
        </div>
      `;
      return;
    }
    containerEl.innerHTML = `
      <div class="animate-pulse space-y-3">
        <div class="h-4 bg-slate-200 rounded w-3/4"></div>
        <div class="h-4 bg-slate-200 rounded w-2/3"></div>
        <div class="h-4 bg-slate-200 rounded w-1/2"></div>
      </div>
    `;
  };

  const toggleMockMode = (newValue) => {
    CONFIG.MOCK_MODE = Boolean(newValue);
    showToast(CONFIG.MOCK_MODE ? "MOCK mode enabled" : "LIVE mode enabled", "info");
  };

  const openModal = (id) => {
    const modal = typeof id === "string" ? document.getElementById(id) : id;
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  };

  const closeModal = (id) => {
    const modal = typeof id === "string" ? document.getElementById(id) : id;
    if (!modal) return;
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  };

  const getCurrentPageName = () => window.location.pathname.split("/").pop() || "index.html";

  const isPublicPage = (pageName) => PUBLIC_PAGES.includes(pageName);

  const isAuthorized = (pageName, role, allowedPages, effectiveRole) => {
    const normalizedRole = normalizeRole(role);
    // Admin hard override
    if (normalizedRole === ROLES.ADMIN) {
      if (!CONFIG.ADMIN_CAN_ACCESS_ALL_DASHBOARDS) {
        const adminOnlyPages = new Set(["admin.html", "admin-users.html", "admin-audit-logs.html", "admin-access-control.html"]);
        return adminOnlyPages.has(pageName) || !RBAC_ROUTES[pageName] || true;
      }
      return true;
    }
    // DB-driven page access (capabilities from /me)
    if (allowedPages && allowedPages.includes(pageName)) return true;
    // Fallback: hardcoded RBAC_ROUTES
    const allowedRoles = RBAC_ROUTES[pageName];
    if (!allowedRoles) return Boolean(normalizedRole);
    if (allowedRoles.includes(normalizedRole)) return true;
    if (effectiveRole && allowedRoles.includes(normalizeRole(effectiveRole))) return true;
    return false;
  };

  const requireAuth = (redirectTo = "login.html") => {
    const session = getSession();
    if (!session || !session.user) {
      window.location.href = redirectTo;
      return false;
    }
    return true;
  };

  const requireRole = (roles = [], redirectTo = "login.html") => {
    const session = getSession();
    if (!session || !session.user) {
      window.location.href = redirectTo;
      return false;
    }
    const role = normalizeRole(session.user.role);
    if (role === ROLES.ADMIN) return true;
    if (!roles.includes(role)) {
      window.location.href = redirectTo;
      return false;
    }
    return true;
  };

  // ── Idle session timeout ─────────────────────────────────────────────────────
  // The idle window (per sign-in method — password / OTP / Azure SSO) is set by
  // an admin under Settings and travels with the session as `idleTimeoutMinutes`.
  // Real user activity (mouse/keyboard/touch/scroll) resets a client-side timer;
  // when it elapses with no activity, the session is cleared and the user is sent
  // back to login. A throttled "heartbeat" call tells the server about that same
  // real activity so it can independently enforce the same timeout (the /me poll
  // in startSessionWatcher does NOT count as activity, so leaving a tab open and
  // idle still times out even though it's polling in the background).
  const IDLE_ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "wheel", "touchstart", "scroll"];
  const HEARTBEAT_MIN_INTERVAL_MS = 60000;
  let idleTimer = null;
  let lastHeartbeatAt = 0;
  let idleWatcherStarted = false;

  // requirePageAccess() previously called /me on every single page navigation,
  // on top of startSessionWatcher()'s independent 60s poll — meaning two page
  // loads a few seconds apart (very common: dashboard nav, back button, a
  // multi-tab workflow) each triggered a full /me round-trip. A short
  // client-side TTL lets rapid navigation reuse the capability data /me just
  // returned, without weakening the 60s watcher's job of catching a
  // disabled/idle/revoked session promptly even on an idle tab.
  const ME_CACHE_TTL_MS = 15000;
  let lastMeFetchAt = 0;

  const forceIdleLogout = () => {
    clearSession();
    window.location.href = "login.html?reason=idle_timeout";
  };

  const sendHeartbeat = () => {
    const now = Date.now();
    if (now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return;
    lastHeartbeatAt = now;
    apiFetch("/auth/heartbeat", { method: "POST", retry: { retries: 0 } }).catch(() => {});
  };

  const resetIdleTimer = () => {
    const session = getSession();
    const minutes = Number(session?.idleTimeoutMinutes);
    if (!session?.accessToken || !minutes || minutes <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(forceIdleLogout, minutes * 60000);
    sendHeartbeat();
  };

  const startIdleWatcher = () => {
    const session = getSession();
    if (!session?.accessToken || !session?.idleTimeoutMinutes) return;
    if (!idleWatcherStarted) {
      idleWatcherStarted = true;
      IDLE_ACTIVITY_EVENTS.forEach((evt) => document.addEventListener(evt, resetIdleTimer, { passive: true }));
    }
    resetIdleTimer();
  };

  const requirePageAccess = async () => {
    const pageName = getCurrentPageName();
    if (isPublicPage(pageName)) return true;
    const session = getSession();
    // Require an actual token, not just a {user} shim: the legacy `finemarkUser`
    // fallback in getSession() can return a token-less session that looks logged-in
    // but authenticates nothing — treat that as unauthenticated and re-login.
    if (!session || !session.user) {
      window.location.href = `login.html?reason=unauthorized&page=${encodeURIComponent(pageName)}`;
      return false;
    }
    if (!session.accessToken && !session.refreshToken) {
      clearSession();
      window.location.href = `login.html?reason=session_expired&page=${encodeURIComponent(pageName)}`;
      return false;
    }
    if (CONFIG.AUTH_LIVE) {
      const meIsFresh = Date.now() - lastMeFetchAt < ME_CACHE_TTL_MS;
      if (!meIsFresh) {
        try {
          const meData = await apiFetch("/me", { method: "GET" });
          lastMeFetchAt = Date.now();
          // Update session with dynamic capability data from the server
          if (meData?.user) {
            const updatedSession = getSession();
            if (updatedSession) {
              updatedSession.user.allowedPages = meData.user.allowedPages ?? null;
              updatedSession.user.effectiveRole = meData.user.effectiveRole ?? null;
              updatedSession.user.capabilities = meData.user.capabilities ?? null;
              // Keep the idle-timeout policy fresh so admin changes to Settings apply without re-login
              updatedSession.idleTimeoutMinutes = meData.idleTimeoutMinutes ?? updatedSession.idleTimeoutMinutes;
              updatedSession.loginMethod = meData.loginMethod ?? updatedSession.loginMethod;
              setSession(updatedSession);
            }
          }
        } catch (error) {
          const status = error?.status ?? 0;
          if (status === 401 || status === 403) {
            clearSession();
            const reason = error?.code === "IDLE_TIMEOUT" ? "idle_timeout" : "unauthorized";
            window.location.href = `login.html?reason=${reason}&page=${encodeURIComponent(pageName)}`;
            return false;
          }
          // Network error or server error — keep the session, let the user stay
        }
      }
      // Always start the watcher regardless of whether this call was skipped
      // as fresh — it's idempotent (no-ops if already running) and is the
      // thing that actually enforces idle/disabled/revoked on a static tab.
      startSessionWatcher();
    }
    const freshSession = getSession();
    if (!isAuthorized(pageName, freshSession?.user?.role, freshSession?.user?.allowedPages, freshSession?.user?.effectiveRole)) {
      window.location.href = `unauthorized.html?page=${encodeURIComponent(pageName)}`;
      return false;
    }
    startIdleWatcher();
    return true;
  };

  let sessionWatcher = null;
  const startSessionWatcher = () => {
    if (sessionWatcher) return;
    sessionWatcher = setInterval(async () => {
      try {
        await apiFetch("/me", { method: "GET", retry: { retries: 0 } });
        lastMeFetchAt = Date.now();
      } catch (error) {
        if (error?.code === "FORBIDDEN" && String(error.message || "").toLowerCase().includes("disabled")) {
          clearSession();
          window.location.href = "login.html?reason=disabled";
        } else if (error?.code === "IDLE_TIMEOUT" || error?.code === "SESSION_REVOKED") {
          clearSession();
          window.location.href = "login.html?reason=idle_timeout";
        }
      }
    }, 60000);
  };

  const delay = (min = 250, max = 600) => new Promise((resolve) => setTimeout(resolve, Math.random() * (max - min) + min));

  const createError = (status, code, message, details) => ({ status, code, message, details });

  const normalizeError = (err) => {
    if (!err) return { status: 0, code: "UNKNOWN", message: "Unexpected error." };
    if (err.status && err.code) return err;
    if (err.error?.code) {
      return {
        status: err.status || 0,
        code: err.error.code,
        message: err.error.message || "Request failed",
        details: err.error.details,
      };
    }
    if (err instanceof Error) {
      const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";
      return {
        status: err.status || 0,
        code: err.code || (isTimeout ? "TIMEOUT" : "ERROR"),
        message: isTimeout ? "Request timed out. Please check your connection and try again." : (err.message || "Request failed"),
        details: err.details,
      };
    }
    return { status: 0, code: "ERROR", message: "Request failed", details: err };
  };

  const loadStore = (key, fallback = []) => {
    try {
      const stored = JSON.parse(localStorage.getItem(key));
      return Array.isArray(stored) ? stored : fallback;
    } catch (error) {
      return fallback;
    }
  };

  const saveStore = (key, data) => {
    localStorage.setItem(key, JSON.stringify(data));
  };

  const nowIso = () => new Date().toISOString();

  // ── Mock/demo API layer removed 2026-08-07 (VAPT remediation) ──────────────
  // seedStores, mockHandlers and routeMock emulated the API against localStorage.
  // They were dead code (portal runs LIVE; CONFIG.MOCK_MODE = false) and shipped
  // internal business logic + sample data to the browser. Removed. All data now
  // comes exclusively from the authenticated /api via apiFetch below.

  const apiFetch = async (path, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(JSON.stringify(options.body)) : undefined;
    const retryConfig = options.retry || { retries: 0, delayMs: 0 };
    const formEl = options.formEl || null;

    const liveAuth = CONFIG.LIVE_AUTH_ONLY && path.startsWith("/auth/");
    const liveData =
      CONFIG.LIVE_CRM_AND_FINANCE &&
      (path.startsWith("/crm/") ||
        path.startsWith("/invoices") ||
        path.startsWith("/payments") ||
        path.startsWith("/finance/") ||
        path.startsWith("/audit-logs"));
    const forceLiveAuth = CONFIG.AUTH_LIVE && path.startsWith("/auth/");
    const forceLive = liveAuth || liveData || CONFIG.LIVE_ENDPOINTS?.some((prefix) => path.startsWith(prefix));
    // Mock request path removed (VAPT) — always use the live API below.
    const session = getSession();
    // A session with neither an access token nor a refresh token cannot authenticate
    // any /api call. This happens when the full SESSION entry was lost (expired /
    // evicted / corrupted localStorage) but the legacy `finemarkUser` key lingered —
    // getSession() then returns a token-less {user} shim that looks logged-in. Rather
    // than fire a doomed request that returns the cryptic "Missing or invalid
    // authorization header", clear the half-session and send the user to re-login once.
    if (!path.startsWith("/auth/") && !session?.accessToken && !session?.refreshToken) {
      clearSession();
      if (!window.__fmAuthRedirecting) {
        window.__fmAuthRedirecting = true;
        const pg = encodeURIComponent(getCurrentPageName());
        window.location.href = `login.html?reason=session_expired&page=${pg}`;
      }
      throw createError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
    }
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {},
      session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}
    );

    const doFetch = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
          response = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
        if (response.status === 401 && session?.refreshToken) {
          return null;
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw createError(
            response.status,
            payload?.error?.code || payload?.code || "ERROR",
            payload?.error?.message || payload?.message || "Request failed",
            payload?.error?.details || payload?.details
          );
        }
        return payload;
      } catch (error) {
        throw normalizeError(error);
      }
    };

    const transient = (status) => [0, 502, 503, 504].includes(status);
    let attempt = 0;
    let result;
    while (attempt <= (retryConfig.retries || 0)) {
      try {
        result = await doFetch();
        if (result === null && session?.refreshToken) {
          const refreshResponse = await fetch(`${CONFIG.API_BASE_URL}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken: session.refreshToken }),
          });
          if (!refreshResponse.ok) {
            clearSession();
            const failPayload = await refreshResponse.json().catch(() => ({}));
            const failCode = failPayload?.error?.code || failPayload?.code || "UNAUTHORIZED";
            const reason = failCode === "IDLE_TIMEOUT" ? "idle_timeout" : "session_expired";
            window.location.href = `login.html?reason=${reason}`;
            throw createError(401, failCode, "Session expired");
          }
          const refreshData = await refreshResponse.json();
          setSession({
            ...session,
            accessToken: refreshData.accessToken,
            refreshToken: refreshData.refreshToken || session.refreshToken,
            idleTimeoutMinutes: refreshData.idleTimeoutMinutes ?? session.idleTimeoutMinutes,
            loginMethod: refreshData.loginMethod ?? session.loginMethod,
          });
          // Update the closed-over headers so the retry uses the new token
          headers.Authorization = `Bearer ${refreshData.accessToken}`;
          result = await doFetch();
        }
        return result;
      } catch (error) {
        const normalized = normalizeError(error);
        if (
          normalized.code === "FORBIDDEN" &&
          String(normalized.message || "").toLowerCase().includes("disabled")
        ) {
          clearSession();
          window.location.href = "login.html?reason=disabled";
        }
        if (formEl && normalized.code === "VALIDATION_ERROR" && normalized.details) {
          applyFieldErrors(formEl, normalized.details);
        }
        if (attempt < (retryConfig.retries || 0) && transient(normalized.status)) {
          await delay(retryConfig.delayMs || 500, retryConfig.delayMs || 500);
          attempt += 1;
          continue;
        }
        throw normalized;
      }
    }
    return result;
  };

  const AuthService = {
    login: (payload) => apiFetch("/auth/login", { method: "POST", body: payload }),
    logout: () => apiFetch("/auth/logout", { method: "POST" }),
    refresh: (payload) => apiFetch("/auth/refresh", { method: "POST", body: payload }),
    forgotPassword: (payload) => apiFetch("/auth/forgot-password", { method: "POST", body: payload }),
    resetPassword: (payload) => apiFetch("/auth/reset-password", { method: "POST", body: payload }),
  };

  const MeService = {
    getProfile: () => apiFetch("/me", { method: "GET" }),
    changePassword: (payload, formEl) => apiFetch("/me/change-password", { method: "POST", body: payload, formEl }),
    updateProfile: (payload) => apiFetch("/me", { method: "PATCH", body: payload }),
    getEmployee: () => apiFetch("/me/employee", { method: "GET" }),
    updateEmployee: (payload) => apiFetch("/me/employee", { method: "PATCH", body: payload }),
  };

  const UserService = {
    list: (filters = {}) => {
      const query = new URLSearchParams(filters).toString();
      return apiFetch(`/users${query ? `?${query}` : ""}`);
    },
    create: (payload) => apiFetch("/users", { method: "POST", body: payload }),
    update: (id, payload) => apiFetch(`/users/${id}`, { method: "PATCH", body: payload }),
    resetPassword: (id) => apiFetch(`/users/${id}/reset-password`, { method: "POST" }),
  };

  // Shared role list — the single fetch path for every page that needs "what
  // roles exist" (admin-users.html, hr-employee-profile.html, hr-employee-users.html,
  // admin-access-control.html). Backed by role_configs — see role-configs.ts.
  const RoleConfigService = {
    list: () => apiFetch("/admin/role-configs"),
    capabilityDefinitions: () => apiFetch("/admin/role-configs/capability-definitions"),
    create: (payload) => apiFetch("/admin/role-configs", { method: "POST", body: payload }),
    update: (id, payload) => apiFetch(`/admin/role-configs/${id}`, { method: "PATCH", body: payload }),
    remove: (id) => apiFetch(`/admin/role-configs/${id}`, { method: "DELETE" }),
  };

  const InstallationService = {
    list: (filters = {}) => {
      const query = new URLSearchParams(filters).toString();
      return apiFetch(`/installations${query ? `?${query}` : ""}`);
    },
    create: (payload) => apiFetch("/installations", { method: "POST", body: payload }),
    assign: (id, payload) => apiFetch(`/installations/${id}/assign`, { method: "PATCH", body: payload }),
    updateStatus: (id, payload) => apiFetch(`/installations/${id}/status`, { method: "PATCH", body: payload }),
    updateJobCard: (id, payload) => apiFetch(`/installations/${id}/job-card`, { method: "PATCH", body: payload }),
    confirm: (id, payload) => apiFetch(`/installations/${id}/confirm`, { method: "PATCH", body: payload }),
  };

  const CRMService = {
    list: (filters = {}) => {
      const query = new URLSearchParams(filters).toString();
      return apiFetch(`/crm/records${query ? `?${query}` : ""}`);
    },
    create: (payload) => apiFetch("/crm/records", { method: "POST", body: payload }),
    update: (id, payload) => apiFetch(`/crm/records/${id}`, { method: "PATCH", body: payload }),
  };

  const InvoiceService = {
    list: (filters = {}) => {
      const query = new URLSearchParams(filters).toString();
      return apiFetch(`/invoices${query ? `?${query}` : ""}`);
    },
    get: (id) => apiFetch(`/invoices/${id}`),
    create: (payload) => apiFetch("/invoices", { method: "POST", body: payload }),
    update: (id, payload) => apiFetch(`/invoices/${id}`, { method: "PATCH", body: payload }),
    forCustomer: (customerId, filters = {}) => {
      const query = new URLSearchParams(filters).toString();
      return apiFetch(`/invoices/for-customer/${customerId}${query ? `?${query}` : ""}`);
    },
    forSales: (filters = {}) => {
      const query = new URLSearchParams(filters).toString();
      return apiFetch(`/invoices/for-sales${query ? `?${query}` : ""}`);
    },
    sendEmail: (id, body) => apiFetch(`/invoices/${id}/email`, { method: "POST", body }),
    sendWhatsApp: (id, body) => apiFetch(`/invoices/${id}/whatsapp`, { method: "POST", body }),
    etimsSign: (id, body) => apiFetch(`/invoices/${id}/etims-sign`, { method: "POST", body }),
  };

  const InstallationTicketService = {
    list: (filters = {}) => {
      const query = new URLSearchParams(filters).toString();
      return apiFetch(`/installation-tickets${query ? `?${query}` : ""}`);
    },
    get: (id) => apiFetch(`/installation-tickets/${id}`),
    create: (payload) => apiFetch("/installation-tickets", { method: "POST", body: payload }),
    assign: (id, payload) => apiFetch(`/installation-tickets/${id}/assign`, { method: "PATCH", body: payload }),
    updateStatus: (id, payload) => apiFetch(`/installation-tickets/${id}/status`, { method: "PATCH", body: payload }),
    forInvoice: (invoiceId) => apiFetch(`/installation-tickets/for-invoice/${invoiceId}`),
    forCustomer: (customerId) => apiFetch(`/installation-tickets/for-customer/${customerId}`),
  };

  const PaymentService = {
    list: (filters = {}) => {
      const query = new URLSearchParams(filters).toString();
      return apiFetch(`/payments${query ? `?${query}` : ""}`);
    },
    create: (payload) => apiFetch("/payments", { method: "POST", body: payload }),
  };

  const AuditService = {
    list: (filters = {}) => {
      const query = new URLSearchParams(filters).toString();
      return apiFetch(`/audit-logs${query ? `?${query}` : ""}`);
    },
  };

  /**
   * Parse an M-PESA confirmation SMS into { code, amount, payee, phone, date }.
   * Handles both Buy-Goods/Till ("... paid to HAIR CRAFT STYLISTS. on 18/8/26 ...")
   * and Send-Money ("... sent to ROSE MAINA 0721768050 on 18/8/26 ..."). Returns
   * null if the text isn't recognisable. `date` is normalised to YYYY-MM-DD.
   */
  const parseMpesa = (text) => {
    if (!text) return null;
    const t = String(text).replace(/ /g, " ").replace(/\s+/g, " ").trim();
    const out = { code: null, amount: null, payee: null, phone: null, date: null };
    // Transaction code: 10-char alphanumeric token, usually right before "Confirmed".
    let m = t.match(/\b([A-Z0-9]{10})\b(?=\s+Confirmed)/i) || t.match(/^([A-Z0-9]{10})\b/i) || t.match(/\bReference[:\s]+([A-Z0-9]{8,12})\b/i);
    if (m) out.code = m[1].toUpperCase();
    // Amount: the "Ksh…" figure immediately after "Confirmed" (the transaction amount,
    // not the balance / cost / daily-limit figures that follow).
    m = t.match(/Confirmed\.?\s*(?:Ksh|KES)\s*([\d,]+(?:\.\d{1,2})?)/i)
     || t.match(/\b(?:sent|paid|received)\b[^.]*?\b(?:Ksh|KES)\s*([\d,]+(?:\.\d{1,2})?)/i)
     || t.match(/\b(?:Ksh|KES)\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (m) out.amount = Number(m[1].replace(/,/g, ""));
    // Payee (+ optional phone).
    let pm = t.match(/\bpaid to\s+(.+?)\.?\s+on\b/i);
    if (pm) {
      out.payee = pm[1].trim();
    } else {
      pm = t.match(/\b(?:sent to|to)\s+(.+?)\s+on\b/i);
      if (pm) {
        let who = pm[1].trim().replace(/^[-–\s]+|[-–\s]+$/g, "");
        const lead = who.match(/^(\+?\d[\d\s]{6,})\s*[-–]?\s*(.+)$/);
        if (lead && /[A-Za-z]/.test(lead[2])) {
          out.phone = lead[1].replace(/\s+/g, ""); out.payee = lead[2].trim();
        } else {
          const tail = who.match(/(?:^|\s)(\+?\d[\d\s]{6,})$/);
          if (tail) { out.phone = tail[1].replace(/\s+/g, ""); who = who.slice(0, who.length - tail[1].length).trim(); }
          out.payee = who.replace(/[-–\s]+$/, "").trim();
        }
      }
    }
    // Date: "on DD/MM/YY at …" → YYYY-MM-DD.
    m = t.match(/\bon\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/i);
    if (m) {
      const y = m[3].length === 2 ? "20" + m[3] : m[3];
      out.date = y + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[1]).padStart(2, "0");
    } else {
      const md = t.match(/\bon\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/i);
      if (md) {
        const mo = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }[md[2].slice(0, 3).toLowerCase()];
        if (mo) out.date = md[3] + "-" + String(mo).padStart(2, "0") + "-" + String(md[1]).padStart(2, "0");
      }
    }
    return (out.code || out.amount || out.payee) ? out : null;
  };

  window.FINEMARK_APP = {
    CONFIG,
    API_BASE: CONFIG.API_BASE_URL,
    ROLES,
    RBAC_ROUTES,
    RBAC_NAV,
    PUBLIC_PAGES,
    apiFetch,
    normalizeError,
    Validators,
    formatKES,
    vehicleLabel,
    HR_LEAVE_STATUS_COLOR,
    HR_LEAVE_STATUS_LABEL,
    renderLeaveStatusBadge,
    setFieldError,
    clearFieldError,
    clearFormErrors,
    applyFieldErrors,
    showInlineError,
    setLoading,
    renderSkeleton,
    showToast,
    toggleMockMode,
    openModal,
    closeModal,
    setSession,
    getSession,
    clearSession,
    requireAuth,
    requireRole,
    requirePageAccess,
    startIdleWatcher,
    getCurrentPageName,
    isPublicPage,
    isAuthorized,
    STORAGE_KEYS,
    AuthService,
    MeService,
    UserService,
    RoleConfigService,
    InstallationService,
    CRMService,
    InvoiceService,
    InstallationTicketService,
    PaymentService,
    AuditService,
    parseMpesa,
  };
})();
