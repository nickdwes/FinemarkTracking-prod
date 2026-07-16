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
    "invoice-inventory.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-records.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-customers.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-register.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "crm-customer-360.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
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
    "crm-tickets.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE, ROLES.ADMIN, ROLES.FINANCE, "Support", "Operations", "technical_manager"],
    "crm-ticket-new.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE, ROLES.ADMIN, ROLES.FINANCE, "Support", "Operations", "technical_manager"],
    "crm-ticket-detail.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE, ROLES.ADMIN, ROLES.FINANCE, "Support", "Operations", "technical_manager"],
    "gps-uninstall-queue.html": [ROLES.ADMIN, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE, ROLES.FINANCE],
    "support-dashboard.html": [ROLES.ADMIN, ROLES.TECHNICAL, ROLES.FINANCE, "Support", "Operations"],
    "admin-ticket-categories.html": [ROLES.ADMIN],
    "technician-jobs.html": [ROLES.TECHNICIAN, ROLES.ADMIN],
    "job-details.html": [ROLES.TECHNICIAN, ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE, ROLES.CERT_ADMIN],
    "job-card.html": [ROLES.TECHNICIAN, ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE],
    "confirmation.html": [ROLES.TECHNICIAN, ROLES.ADMIN],
    "signature.html": [ROLES.TECHNICIAN, ROLES.ADMIN],
    "otp.html": [ROLES.TECHNICIAN, ROLES.ADMIN],
    "admin.html": [ROLES.ADMIN],
    "admin-users.html": [ROLES.ADMIN],
    "certificate-dashboard.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
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
    "technician-custody.html": [ROLES.TECHNICIAN, ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE],
    "executive-dashboard.html": [ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.ADMIN],
    "invoice-detail.html": [ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.ADMIN, ROLES.FINANCE, ROLES.TECHNICAL, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES],
    "vehicle-installation.html": [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.INSTALL_OFFICE],
    "technical-dashboard.html": [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE],
    "hr-employee-users.html": [ROLES.ADMIN],
    "hr-leave-apply.html": [ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.FINANCE, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT, ROLES.WAREHOUSE, ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INSTALL_OFFICE],
    "hr-leave-calendar.html": [ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.FINANCE, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT, ROLES.WAREHOUSE, ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INSTALL_OFFICE],
    "hr-manager-leave.html": [ROLES.ADMIN, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.FINANCE, ROLES.INVENTORY_MGR, ROLES.PROCUREMENT, ROLES.WAREHOUSE, ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.INSTALL_OFFICE],
    "hr-leave-approvals.html": [ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CEO, ROLES.DIRECTOR, ROLES.EXEC_MGT],
    "certificate-validation.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
    "certificate-bank-settings.html": [ROLES.ADMIN, ROLES.CERT_ADMIN],
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
    if (!session || !session.user) {
      window.location.href = `login.html?reason=unauthorized&page=${encodeURIComponent(pageName)}`;
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

  const seedStores = () => {
    if (!localStorage.getItem(STORAGE_KEYS.USERS)) {
      saveStore(STORAGE_KEYS.USERS, [
        {
          id: "USR-1",
          name: "Admin User",
          email: "adonijahjuma@gmail.com",
          role: ROLES.ADMIN,
          status: "Active",
          forcePasswordReset: false,
          password: "password123",
          lastLoginAt: nowIso(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        {
          id: "USR-2",
          name: "Sales User",
          email: "sales@finemark.com",
          role: ROLES.SALES,
          status: "Active",
          forcePasswordReset: false,
          password: "password123",
          lastLoginAt: nowIso(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        {
          id: "USR-3",
          name: "Technical User",
          email: "tech@finemark.com",
          role: ROLES.TECHNICAL,
          status: "Active",
          forcePasswordReset: false,
          password: "password123",
          lastLoginAt: nowIso(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        {
          id: "USR-4",
          name: "Finance User",
          email: "finance@finemark.com",
          role: ROLES.FINANCE,
          status: "Active",
          forcePasswordReset: false,
          password: "password123",
          lastLoginAt: nowIso(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      ]);
    }
    if (!localStorage.getItem(STORAGE_KEYS.INSTALLATIONS)) {
      saveStore(STORAGE_KEYS.INSTALLATIONS, [
        {
          id: "JOB-1001",
          requestId: "REQ-1001",
          customerName: "Atlas Corp",
          customerPhone: "+254700111222",
          location: "Nairobi, KE",
          scheduledDate: new Date(Date.now() + 86400000).toISOString(),
          assignedTechnician: "Mike Johnson",
          status: "Assigned",
          jobDetails: { products: ["FM-GPS-Tracker V3"], notes: "Install on unit 12" },
          jobCard: { checklist: [], photos: [] },
          confirmation: { method: "", verified: false },
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        {
          id: "JOB-1002",
          requestId: "REQ-1002",
          customerName: "Ridgeway Logistics",
          customerPhone: "+254700333444",
          location: "Mombasa, KE",
          scheduledDate: new Date(Date.now() + 2 * 86400000).toISOString(),
          assignedTechnician: "Sarah Williams",
          status: "In Progress",
          jobDetails: { products: ["FM-GPS-Tracker V2"], notes: "Fleet rollout" },
          jobCard: { checklist: [], photos: [] },
          confirmation: { method: "", verified: false },
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      ]);
    }
    if (!localStorage.getItem(STORAGE_KEYS.CRM_RECORDS)) {
      saveStore(STORAGE_KEYS.CRM_RECORDS, [
        {
          id: "REQ-1001",
          type: "installation",
          customer: "Atlas Corp",
          location: "Nairobi, KE",
          status: "Submitted",
          owner: "sales@finemark.com",
          createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
          updatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
          details: { notes: "Priority install" },
        },
        {
          id: "REQ-1002",
          type: "quotation",
          customer: "Ridgeway Logistics",
          location: "Mombasa, KE",
          status: "Approved",
          owner: "sales@finemark.com",
          createdAt: new Date(Date.now() - 6 * 86400000).toISOString(),
          updatedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
          details: { notes: "Fleet expansion" },
        },
        {
          id: "REQ-1003",
          type: "invoice",
          customer: "Northstar Freight",
          location: "Kisumu, KE",
          status: "Paid",
          owner: "sales@finemark.com",
          createdAt: new Date(Date.now() - 15 * 86400000).toISOString(),
          updatedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
          details: { notes: "Invoice settled" },
        },
      ]);
    }
    if (!localStorage.getItem(STORAGE_KEYS.INVOICES)) {
      saveStore(STORAGE_KEYS.INVOICES, []);
    }
    if (!localStorage.getItem(STORAGE_KEYS.PAYMENTS)) {
      saveStore(STORAGE_KEYS.PAYMENTS, []);
    }
    if (!localStorage.getItem(STORAGE_KEYS.AUDIT_LOGS)) {
      saveStore(STORAGE_KEYS.AUDIT_LOGS, []);
    }
  };

  const parseUrl = (path) => {
    const url = new URL(path, "http://localhost");
    return { pathname: url.pathname, searchParams: url.searchParams };
  };

  const applyFilters = (items, filters, mapper) => {
    return items.filter((item) => mapper(item, filters));
  };

  const mockHandlers = {
    "POST /auth/login": async ({ body }) => {
      const users = loadStore(STORAGE_KEYS.USERS, []);
      let user = users.find((entry) => entry.email === body.email);
      if (!user) {
        user = {
          id: `USR-${Date.now()}`,
          name: body.name || body.email.split("@")[0],
          email: body.email,
          role: normalizeRole(body.role) || ROLES.SALES,
          status: "Active",
          forcePasswordReset: false,
          password: body.password || "password123",
          lastLoginAt: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        users.push(user);
      }
      if (user.status === "Disabled") {
        throw createError(403, "FORBIDDEN", "User account is disabled.");
      }
      if (user.password && body.password && user.password !== body.password) {
        throw createError(401, "UNAUTHORIZED", "Invalid email or password.");
      }
      user.lastLoginAt = nowIso();
      user.updatedAt = nowIso();
      saveStore(STORAGE_KEYS.USERS, users);
      const response = {
        accessToken: "mock-access",
        refreshToken: "mock-refresh",
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          forcePasswordReset: user.forcePasswordReset,
          lastLoginAt: user.lastLoginAt,
        },
      };
      setSession(response);
      return response;
    },
    "POST /auth/logout": async () => {
      clearSession();
      return { data: { message: "Logged out" } };
    },
    "POST /auth/refresh": async () => {
      return { accessToken: "mock-access", refreshToken: "mock-refresh" };
    },
    "POST /auth/forgot-password": async () => {
      return { message: "If an account exists, you will receive a reset link shortly." };
    },
    "POST /auth/reset-password": async () => {
      return { message: "Password updated successfully." };
    },
    "GET /me": async () => {
      const session = getSession();
      const users = loadStore(STORAGE_KEYS.USERS, []);
      const user = users.find((entry) => entry.id === session?.user?.id) || session?.user;
      if (!user) {
        throw createError(404, "NOT_FOUND", "User not found.");
      }
      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status || "Active",
          forcePasswordReset: Boolean(user.forcePasswordReset),
          lastLoginAt: user.lastLoginAt || null,
        },
      };
    },
    "POST /me/change-password": async ({ body }) => {
      const session = getSession();
      const users = loadStore(STORAGE_KEYS.USERS, []);
      const userIndex = users.findIndex((entry) => entry.id === session?.user?.id);
      const user = userIndex >= 0 ? users[userIndex] : null;
      if (!user) {
        throw createError(404, "NOT_FOUND", "User not found.");
      }
      if (!body?.currentPassword || !body?.newPassword || !body?.confirmPassword) {
        throw createError(400, "VALIDATION_ERROR", "Invalid input", {
          fieldErrors: { currentPassword: ["All fields are required."] },
        });
      }
      if (body.newPassword !== body.confirmPassword) {
        throw createError(400, "VALIDATION_ERROR", "Invalid input", {
          fieldErrors: { confirmPassword: ["Passwords do not match."] },
        });
      }
      if (body.newPassword === body.currentPassword) {
        throw createError(400, "VALIDATION_ERROR", "Invalid input", {
          fieldErrors: { newPassword: ["New password must be different from current password."] },
        });
      }
      if (user.password && user.password !== body.currentPassword) {
        throw createError(400, "VALIDATION_ERROR", "Invalid input", {
          fieldErrors: { currentPassword: ["Current password is incorrect."] },
        });
      }
      const policyError = Validators.passwordPolicy(body.newPassword);
      if (policyError) {
        throw createError(400, "VALIDATION_ERROR", "Invalid input", {
          fieldErrors: { newPassword: [policyError] },
        });
      }
      users[userIndex] = {
        ...user,
        password: body.newPassword,
        forcePasswordReset: false,
        updatedAt: nowIso(),
      };
      saveStore(STORAGE_KEYS.USERS, users);
      saveStore(STORAGE_KEYS.REFRESH_TOKENS, []);
      return { message: "Password changed successfully" };
    },
    "GET /users": async ({ searchParams }) => {
      const users = loadStore(STORAGE_KEYS.USERS, []);
      const search = (searchParams.get("search") || "").toLowerCase();
      const role = searchParams.get("role") || "all";
      const status = searchParams.get("status") || "all";
      const filtered = applyFilters(users, { search, role, status }, (user, filters) => {
        const matchesSearch = !filters.search || `${user.name} ${user.email}`.toLowerCase().includes(filters.search);
        const matchesRole = filters.role === "all" || user.role === filters.role;
        const matchesStatus = filters.status === "all" || user.status === filters.status;
        return matchesSearch && matchesRole && matchesStatus;
      });
      return { data: filtered.map(({ password, ...rest }) => rest), meta: { total: filtered.length } };
    },
    "POST /users": async ({ body }) => {
      const users = loadStore(STORAGE_KEYS.USERS, []);
      const newUser = {
        id: `USR-${Date.now()}`,
        name: body.name,
        email: body.email,
        role: body.role,
        status: body.status || "Pending",
        forcePasswordReset: Boolean(body.forcePasswordReset),
        password: body.password || "password123",
        lastLoginAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      users.unshift(newUser);
      saveStore(STORAGE_KEYS.USERS, users);
      const { password, ...safeUser } = newUser;
      return { data: safeUser, message: "User created" };
    },
    "PATCH /users/:id": async ({ params, body }) => {
      const users = loadStore(STORAGE_KEYS.USERS, []);
      const user = users.find((entry) => entry.id === params.id);
      if (!user) throw createError(404, "NOT_FOUND", "User not found.");
      Object.assign(user, body, { updatedAt: nowIso() });
      saveStore(STORAGE_KEYS.USERS, users);
      const auditLogs = loadStore(STORAGE_KEYS.AUDIT_LOGS, []);
      const session = getSession();
      auditLogs.unshift({
        id: `AUD-${Date.now()}`,
        timestamp: nowIso(),
        userId: session?.user?.id || null,
        userEmail: session?.user?.email || "demo@finemark.com",
        action: "USER_UPDATED",
        target: `user:${user.id}`,
        severity: "Info",
        ipAddress: "127.0.0.1",
        userAgent: "ui-mock",
        details: body,
      });
      saveStore(STORAGE_KEYS.AUDIT_LOGS, auditLogs);
      const { password, ...safeUser } = user;
      return { data: safeUser, message: "User updated" };
    },
    "POST /users/:id/reset-password": async ({ params }) => {
      const users = loadStore(STORAGE_KEYS.USERS, []);
      const user = users.find((entry) => entry.id === params.id);
      if (!user) throw createError(404, "NOT_FOUND", "User not found.");
      user.forcePasswordReset = true;
      user.updatedAt = nowIso();
      saveStore(STORAGE_KEYS.USERS, users);
      const { password, ...safeUser } = user;
      return { data: safeUser, message: "Reset password triggered" };
    },
    "GET /installations": async ({ searchParams }) => {
      const items = loadStore(STORAGE_KEYS.INSTALLATIONS, []);
      const status = searchParams.get("status");
      const assigned = searchParams.get("assignedTechnician");
      const filtered = items.filter((item) => {
        const statusMatch = !status || item.status === status;
        const assignedMatch = !assigned || item.assignedTechnician === assigned;
        return statusMatch && assignedMatch;
      });
      return { data: filtered, meta: { total: filtered.length } };
    },
    "POST /installations": async ({ body }) => {
      const items = loadStore(STORAGE_KEYS.INSTALLATIONS, []);
      const newItem = { ...body, id: `JOB-${Date.now()}`, createdAt: nowIso(), updatedAt: nowIso() };
      items.unshift(newItem);
      saveStore(STORAGE_KEYS.INSTALLATIONS, items);
      return { data: newItem, message: "Installation created" };
    },
    "PATCH /installations/:id/assign": async ({ params, body }) => {
      const items = loadStore(STORAGE_KEYS.INSTALLATIONS, []);
      const job = items.find((item) => item.id === params.id);
      if (!job) throw createError(404, "NOT_FOUND", "Installation not found.");
      job.assignedTechnician = body.assignedTechnician;
      job.scheduledDate = body.scheduledDate || job.scheduledDate;
      job.status = "Assigned";
      job.updatedAt = nowIso();
      saveStore(STORAGE_KEYS.INSTALLATIONS, items);
      return { data: job, message: "Job assigned" };
    },
    "PATCH /installations/:id/status": async ({ params, body }) => {
      const items = loadStore(STORAGE_KEYS.INSTALLATIONS, []);
      const job = items.find((item) => item.id === params.id);
      if (!job) throw createError(404, "NOT_FOUND", "Installation not found.");
      if (window.FINEMARK_CONTRACTS) {
        window.FINEMARK_CONTRACTS.assertTransitionInstallation(job.status, body.status);
      }
      job.status = body.status;
      job.updatedAt = nowIso();
      saveStore(STORAGE_KEYS.INSTALLATIONS, items);
      return { data: job, message: "Status updated" };
    },
    "PATCH /installations/:id/job-card": async ({ params, body }) => {
      const items = loadStore(STORAGE_KEYS.INSTALLATIONS, []);
      const job = items.find((item) => item.id === params.id);
      if (!job) throw createError(404, "NOT_FOUND", "Installation not found.");
      job.jobCard = body.jobCard || job.jobCard;
      job.updatedAt = nowIso();
      saveStore(STORAGE_KEYS.INSTALLATIONS, items);
      return { data: job, message: "Job card saved" };
    },
    "PATCH /installations/:id/confirm": async ({ params, body }) => {
      const items = loadStore(STORAGE_KEYS.INSTALLATIONS, []);
      const job = items.find((item) => item.id === params.id);
      if (!job) throw createError(404, "NOT_FOUND", "Installation not found.");
      job.confirmation = body.confirmation || job.confirmation;
      job.updatedAt = nowIso();
      saveStore(STORAGE_KEYS.INSTALLATIONS, items);
      return { data: job, message: "Confirmation updated" };
    },
    "GET /crm/records": async ({ searchParams }) => {
      const items = loadStore(STORAGE_KEYS.CRM_RECORDS, []);
      const type = searchParams.get("type");
      const status = searchParams.get("status");
      const search = (searchParams.get("search") || "").toLowerCase();
      const from = searchParams.get("from");
      const to = searchParams.get("to");
      const range = searchParams.get("range");
      const resolvedFrom =
        range === "7d" ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() : from;
      const filtered = items.filter((item) => {
        const matchesType = !type || item.type === type;
        const matchesStatus = !status || item.status === status;
        const matchesSearch =
          !search ||
          (item.customer || "").toLowerCase().includes(search) ||
          (item.location || "").toLowerCase().includes(search) ||
          item.id.toLowerCase().includes(search);
        const recordDate = new Date(item.createdAt);
        const matchesFrom = !resolvedFrom || recordDate >= new Date(resolvedFrom);
        const matchesTo = !to || recordDate <= new Date(new Date(to).getTime() + 86400000 - 1);
        return matchesType && matchesStatus && matchesSearch && matchesFrom && matchesTo;
      });
      return { data: filtered, meta: { total: filtered.length } };
    },
    "POST /crm/records": async ({ body }) => {
      const items = loadStore(STORAGE_KEYS.CRM_RECORDS, []);
      if (!body?.type || !body?.customer || !body?.location) {
        throw createError(400, "VALIDATION_ERROR", "type, customer and location are required.");
      }
      const session = getSession();
      const newItem = {
        id: `REC-${new Date().getFullYear()}-${String(items.length + 1).padStart(4, "0")}`,
        type: body.type,
        customer: body.customer,
        location: body.location,
        status: body.status || "Submitted",
        owner: session?.user?.email || "demo@finemark.com",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        details: body.details || {},
      };
      items.unshift(newItem);
      saveStore(STORAGE_KEYS.CRM_RECORDS, items);
      const auditLogs = loadStore(STORAGE_KEYS.AUDIT_LOGS, []);
      auditLogs.unshift({
        id: `AUD-${Date.now()}`,
        timestamp: nowIso(),
        userId: session?.user?.id || null,
        userEmail: session?.user?.email || "demo@finemark.com",
        action: "CRM_RECORD_CREATED",
        target: `crm:${newItem.id}`,
        severity: "Info",
        ipAddress: "127.0.0.1",
        userAgent: "ui-mock",
        details: { type: newItem.type, customer: newItem.customer },
      });
      saveStore(STORAGE_KEYS.AUDIT_LOGS, auditLogs);
      return { data: newItem, message: "Request created" };
    },
    "PATCH /crm/records/:id": async ({ params, body }) => {
      const items = loadStore(STORAGE_KEYS.CRM_RECORDS, []);
      const record = items.find((item) => item.id === params.id);
      if (!record) throw createError(404, "NOT_FOUND", "Record not found.");
      Object.assign(record, body, { updatedAt: nowIso() });
      saveStore(STORAGE_KEYS.CRM_RECORDS, items);
      return { data: record, message: "Record updated" };
    },
    "GET /invoices": async ({ searchParams }) => {
      const items = loadStore(STORAGE_KEYS.INVOICES, []);
      const search = (searchParams.get("search") || "").toLowerCase();
      const status = searchParams.get("status");
      const from = searchParams.get("from");
      const to = searchParams.get("to");
      const filtered = items.filter((invoice) => {
        const matchesSearch =
          !search ||
          (invoice.invoiceNumber || "").toLowerCase().includes(search) ||
          (invoice.customer || "").toLowerCase().includes(search);
        const matchesStatus = !status || invoice.status === status;
        const issuedDate = invoice.issuedOn ? new Date(invoice.issuedOn) : null;
        const matchesFrom = !from || (issuedDate && issuedDate >= new Date(from));
        const matchesTo = !to || (issuedDate && issuedDate <= new Date(new Date(to).setHours(23, 59, 59, 999)));
        return matchesSearch && matchesStatus && matchesFrom && matchesTo;
      });
      const normalized = filtered.map((invoice) => ({
        ...invoice,
        currency: "KES",
      }));
      return { data: normalized, meta: { total: normalized.length } };
    },
    "POST /invoices": async ({ body }) => {
      const items = loadStore(STORAGE_KEYS.INVOICES, []);
      const invoiceNumber = body.invoiceNumber || `INV-${new Date().getFullYear()}-${String(items.length + 1).padStart(4, "0")}`;
      const newItem = {
        ...body,
        id: body.id || `INV-${Date.now()}`,
        invoiceNumber,
        currency: "KES",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      items.unshift(newItem);
      saveStore(STORAGE_KEYS.INVOICES, items);
      const crmRecords = loadStore(STORAGE_KEYS.CRM_RECORDS, []);
      const summary = {
        invoiceId: newItem.id,
        invoiceNumber: newItem.invoiceNumber,
        amount: newItem.amount,
        currency: "KES",
        status: newItem.status,
        issuedOn: newItem.issuedOn,
        dueOn: newItem.dueOn,
        bank: newItem.bank,
        salesPerson: newItem.salesPerson,
      };
      let crmRecordId = newItem.crmRecordId;
      if (crmRecordId) {
        const existing = crmRecords.find((record) => record.id === crmRecordId);
        if (existing) {
          existing.details = { ...(existing.details || {}), invoice: summary, ...(newItem.details || {}) };
          existing.status = "Submitted";
          existing.updatedAt = nowIso();
        } else {
          crmRecords.unshift({
            id: crmRecordId,
            type: "invoice",
            customer: newItem.customer,
            location: newItem.details?.location || "Unknown",
            status: "Submitted",
            owner: getSession()?.user?.email || "sales@finemark.com",
            createdAt: nowIso(),
            updatedAt: nowIso(),
            details: { invoice: summary, ...(newItem.details || {}) },
          });
        }
      } else {
        crmRecordId = `REQ-${Date.now()}`;
        newItem.crmRecordId = crmRecordId;
        crmRecords.unshift({
          id: crmRecordId,
          type: "invoice",
          customer: newItem.customer,
          location: newItem.details?.location || "Unknown",
          status: "Submitted",
          owner: getSession()?.user?.email || "sales@finemark.com",
          createdAt: nowIso(),
          updatedAt: nowIso(),
          details: { invoice: summary, ...(newItem.details || {}) },
        });
      }
      saveStore(STORAGE_KEYS.CRM_RECORDS, crmRecords);
      return { data: newItem, message: "Invoice created" };
    },
    "PATCH /invoices/:id": async ({ params, body }) => {
      const items = loadStore(STORAGE_KEYS.INVOICES, []);
      const invoice = items.find((item) => item.id === params.id);
      if (!invoice) throw createError(404, "NOT_FOUND", "Invoice not found.");
      Object.assign(invoice, body, { updatedAt: nowIso() });
      saveStore(STORAGE_KEYS.INVOICES, items);
      return { data: invoice, message: "Invoice updated" };
    },
    "GET /payments": async () => {
      const items = loadStore(STORAGE_KEYS.PAYMENTS, []);
      const normalized = items.map((payment) => ({ ...payment, currency: "KES" }));
      return { data: normalized, meta: { total: normalized.length } };
    },
    "POST /payments": async ({ body }) => {
      const items = loadStore(STORAGE_KEYS.PAYMENTS, []);
      const newItem = { ...body, id: `PAY-${Date.now()}`, currency: "KES", createdAt: nowIso() };
      items.unshift(newItem);
      saveStore(STORAGE_KEYS.PAYMENTS, items);
      return { data: newItem, message: "Payment recorded" };
    },
    "GET /audit-logs": async () => {
      const items = loadStore(STORAGE_KEYS.AUDIT_LOGS, []);
      const sorted = [...items].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      return { data: sorted, meta: { total: sorted.length } };
    },
  };

  const routeMock = async (method, path, body) => {
    seedStores();
    const { pathname, searchParams } = parseUrl(path);
    const handlerKey = `${method} ${pathname}`;

    if (handlerKey === "PATCH /users/:id" || handlerKey === "POST /users/:id/reset-password") {
      // placeholder for matching below
    }

    const matchParamRoute = (pattern) => {
      const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, "([^/]+)")}$`);
      const match = pathname.match(regex);
      if (!match) return null;
      const keys = (pattern.match(/:[^/]+/g) || []).map((key) => key.substring(1));
      const params = keys.reduce((acc, key, index) => {
        acc[key] = match[index + 1];
        return acc;
      }, {});
      return params;
    };

    const directHandler = mockHandlers[`${method} ${pathname}`];
    if (directHandler) {
      return directHandler({ body, searchParams });
    }

    const paramRoutes = [
      "PATCH /users/:id",
      "POST /users/:id/reset-password",
      "PATCH /installations/:id/assign",
      "PATCH /installations/:id/status",
      "PATCH /installations/:id/job-card",
      "PATCH /installations/:id/confirm",
      "PATCH /crm/records/:id",
      "PATCH /invoices/:id",
    ];

    for (const route of paramRoutes) {
      const [routeMethod, routePath] = route.split(" ");
      if (routeMethod !== method) continue;
      const params = matchParamRoute(routePath);
      if (params) {
        const handler = mockHandlers[`${method} ${routePath}`];
        if (handler) {
          return handler({ body, searchParams, params });
        }
      }
    }

    throw createError(404, "NOT_FOUND", "Mock route not found");
  };

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
    if (CONFIG.MOCK_MODE && !forceLiveAuth && !forceLive) {
      await delay();
      try {
        const data = await routeMock(method, path, body);
        return data;
      } catch (error) {
        const normalized = normalizeError(error);
        if (formEl && normalized.code === "VALIDATION_ERROR" && normalized.details) {
          applyFieldErrors(formEl, normalized.details);
        }
        throw normalized;
      }
    }

    const session = getSession();
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
  };
})();
