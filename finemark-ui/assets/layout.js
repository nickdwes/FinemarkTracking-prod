(() => {
  const headerRoot = document.getElementById("fm-header");
  const sidebarRoot = document.getElementById("fm-sidebar");
  const footerRoot = document.getElementById("fm-footer");
  if (!headerRoot || !sidebarRoot || !footerRoot) return;

  const ensureGlobalContainers = () => {
    if (!document.getElementById("fm-toast-root")) {
      const toastRoot = document.createElement("div");
      toastRoot.id = "fm-toast-root";
      toastRoot.className = "fixed top-4 right-4 z-50 space-y-2";
      document.body.appendChild(toastRoot);
    }
    if (!document.getElementById("fm-global-alert")) {
      const alertRoot = document.createElement("div");
      alertRoot.id = "fm-global-alert";
      alertRoot.className = "fixed top-16 left-1/2 z-40 w-full max-w-xl -translate-x-1/2 px-4";
      document.body.appendChild(alertRoot);
    }
  };

  ensureGlobalContainers();

  const session = window.FINEMARK_APP?.getSession?.();
  const user = session?.user || null;
  const role = user?.role || null;
  const ROLES = window.FINEMARK_APP?.ROLES || {};
  const filename = window.location.pathname.split("/").pop() || "index.html";
  const isFinancePage = window.location.pathname.includes("/pages/finance/");
  const basePath = isFinancePage ? "../../" : "";
  const financePrefix = isFinancePage ? "" : "pages/finance/";

  const linkTo = (path) => `${basePath}${path}`;
  const financeLink = (path) => (isFinancePage ? path : `${financePrefix}${path}`);

  const iconSvg = (name) => {
    const icons = {
      home: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>`,
      dashboard: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h7v7H4z"/><path d="M13 4h7v4h-7z"/><path d="M13 10h7v10h-7z"/><path d="M4 13h7v7H4z"/></svg>`,
      plus: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
      list: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>`,
      wrench: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 7l-6 6"/><path d="M7 22l6-6"/><path d="M16 2a5 5 0 01-5 5 5 5 0 01-4-2l-5 5 4 4 5-5a5 5 0 01-2-4 5 5 0 015-5z"/></svg>`,
      clipboard: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3h6l1 2h3v16H5V5h3z"/><path d="M9 7h6"/></svg>`,
      shield: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z"/></svg>`,
      users: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 11a4 4 0 10-8 0"/><path d="M2 21a7 7 0 0114 0"/><path d="M22 21a5 5 0 00-6-4.9"/></svg>`,
      certificate: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h10v12H7z"/><path d="M9 7h6"/><path d="M9 11h6"/><path d="M9 15l3 2 3-2v6l-3-2-3 2z"/></svg>`,
      audit: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/></svg>`,
      finance: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16"/><path d="M4 11h16"/><path d="M4 15h10"/><path d="M16 15h4v4h-4z"/></svg>`,
      report: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M7 14l3-3 3 2 4-5"/></svg>`,
      user: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 12a4 4 0 10-4-4 4 4 0 004 4z"/><path d="M4 20a8 8 0 0116 0"/></svg>`,
      bolt: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>`,
      hr: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>`,
      inventory: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 8h14"/><path d="M5 12h14"/><path d="M5 16h9"/><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v4"/><path d="M15 4v4"/></svg>`,
      executive: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 18l9-14 9 14H3z"/><path d="M9 18v-4h6v4"/></svg>`,
      partners: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 11l-3 3-1.5-1.5"/><path d="M20 8a4 4 0 010 6"/></svg>`,
      communication: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M8 10h8M8 14h5"/></svg>`,
      car: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 17H3a1 1 0 01-1-1v-4l2-5h12l2 5v4a1 1 0 01-1 1h-2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M5 12h14"/></svg>`,
      archive: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/><path d="M10 13h4"/></svg>`,
    };
    return icons[name] || icons.list;
  };

  const currentParams = new URLSearchParams(window.location.search);

  const navItem = (href, label, isActive) => {
    const baseClasses = "group relative flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition";
    const activeClasses = "bg-blue-50 text-blue-700 font-semibold";
    const inactiveClasses = "text-slate-600 hover:bg-slate-50 hover:text-slate-900";
    return `
      <a href="${href}" class="${baseClasses} ${isActive ? activeClasses : inactiveClasses}">
        <span class="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-blue-600 ${isActive ? "opacity-100" : "opacity-0"}"></span>
        <span class="ml-2">${label}</span>
      </a>
    `;
  };

  const headerUserLabel = user ? `User: ${user.email} (${user.role})` : "Guest";
  const logoutClasses = user ? "" : "hidden";
  const badgeText = user ? user.role : "Guest";
  const mockLabel = window.FINEMARK_APP?.CONFIG?.MOCK_MODE ? "MOCK" : "LIVE";
  const showMockToggle = false;

  const logoSrc = linkTo("assets/finemark-logo.svg");

  const RBAC_NAV = window.FINEMARK_APP?.RBAC_NAV || {};
  const RBAC_ROUTES = window.FINEMARK_APP?.RBAC_ROUTES || {};
  const getItemRoles = (href) => {
    const baseName = href.split("?")[0].split("/").pop();
    return RBAC_ROUTES[baseName] || null;
  };
  const NAV = [
    {
      key: "dashboard",
      section: "Dashboard",
      roles: RBAC_NAV.Dashboard,
      icon: "dashboard",
      items: [
        { label: "My Jobs",    href: "technician-jobs.html",    roles: RBAC_NAV.Technician, match: { path: "technician-jobs.html" } },
        { label: "My Custody", href: "technician-custody.html", roles: RBAC_NAV.Technician, match: { path: "technician-custody.html" } },
        { label: "Sales Dashboard", href: "sales.html", roles: RBAC_NAV.Sales, match: { path: "sales.html" } },
      ],
    },
    {
      key: "sales",
      section: "Sales",
      roles: RBAC_NAV.Sales,
      icon: "report",
      items: [
        { label: "Product Catalogue", href: "sales-catalogue.html", match: { path: "sales-catalogue.html" } },
        { label: "Sales Intelligence", href: "sales-dashboard.html", roles: [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.KAM, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES], match: { path: "sales-dashboard.html" } },
        { label: "Sales Reports", href: "sales-reports.html", roles: [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.CORPORATE_SALES, ROLES.KAM, ROLES.SALES, ROLES.TELESALES, ROLES.FIELD_SALES], match: { path: "sales-reports.html" } },
        { label: "Corporate Sales Leads", href: "crm-leads.html", match: { path: "crm-leads.html" } },
        { label: "Team Performance", href: "sales-performance.html", roles: [ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE], match: { path: "sales-performance.html" } },
        { subheader: "Retail Segment" },
        { label: "Retail Leads", href: "retail-leads.html", match: { path: "retail-leads.html" } },
        { label: "New Retail Lead", href: "retail-lead-new.html", match: { path: "retail-lead-new.html" } },
        { label: "CRM Customers", href: "crm-customers.html", roles: [RBAC_NAV.Admin[0], ROLES.BDM, ROLES.BDM_CORPORATE], match: { path: "crm-customers.html" } },
        { label: "Register Customer", href: "crm-register.html", roles: [RBAC_NAV.Admin[0], ROLES.BDM, ROLES.BDM_CORPORATE], match: { path: "crm-register.html" } },
        { label: "Customer 360°", href: "crm-customer-360.html", match: { path: "crm-customer-360.html" } },
      ],
    },
    {
      key: "support",
      section: "Support",
      roles: [ROLES.ADMIN, ROLES.TECHNICAL, ROLES.FINANCE, "Support", "Operations"],
      icon: "clipboard",
      items: [
        { label: "Support Dashboard", href: "support-dashboard.html", roles: [ROLES.ADMIN, ROLES.TECHNICAL, ROLES.FINANCE, "Support", "Operations"], match: { path: "support-dashboard.html" } },
        { label: "Support Tickets", href: "crm-tickets.html", roles: [...RBAC_NAV.Sales, ROLES.TECHNICAL, ROLES.INSTALL_OFFICE, ROLES.FINANCE, "Support", "Operations", "technical_manager"], match: { path: "crm-tickets.html" } },
      ],
    },
    {
      key: "communication",
      section: "Communication",
      roles: RBAC_NAV.Communication,
      icon: "communication",
      items: [
        { label: "Campaigns",          href: "crm-campaigns.html",        match: { path: "crm-campaigns.html" } },
        { label: "Mass SMS",           href: "campaigns-mass-sms.html",   match: { path: "campaigns-mass-sms.html" } },
        { label: "Mass Email",         href: "campaigns-mass-email.html", match: { path: "campaigns-mass-email.html" } },
        { label: "Communications Log", href: "crm-communications.html",   match: { path: "crm-communications.html" } },
      ],
    },
    {
      key: "vehicles",
      section: "Vehicles",
      roles: RBAC_NAV.All || null,
      icon: "car",
      items: [
        { label: "Dashboard",          href: "vehicles-dashboard.html",  match: { path: "vehicles-dashboard.html" } },
        { label: "Vehicle List",        href: "vehicles-list.html",        match: { path: "vehicles-list.html" } },
        { label: "Register Vehicle",    href: "vehicle-register.html",    match: { path: "vehicle-register.html" } },
        { label: "Vehicle 360°",        href: "vehicle-360.html",         match: { path: "vehicle-360.html" } },
        { label: "Vehicle Data Sync",   href: "vehicle-data-sync.html",   match: { path: "vehicle-data-sync.html" }, roles: [ROLES.ADMIN, ROLES.INVENTORY_MGR] },
      ],
    },
    {
      key: "technical",
      section: "Technical",
      roles: RBAC_NAV.Technical,
      icon: "wrench",
      items: [
        { label: "Pipeline",          href: "technical.html#pipeline",    match: { path: "technical.html", hash: "#pipeline", hashDefault: true } },
        { label: "Field Team",        href: "technical.html#team",        match: { path: "technical.html", hash: "#team" } },
        { label: "Installations",     href: "technical.html#chart",       match: { path: "technical.html", hash: "#chart" } },
        { label: "Competency",        href: "technical.html#competency",  match: { path: "technical.html", hash: "#competency" } },
        { label: "Device Allocation", href: "technical.html#devices",     match: { path: "technical.html", hash: "#devices" } },
        { label: "Job Execution",     href: "technical.html#job-exec",    match: { path: "technical.html", hash: "#job-exec" } },
        { label: "Performance",       href: "technical.html#performance", match: { path: "technical.html", hash: "#performance" }, roles: [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE] },
        { label: "Knowledge Base",    href: "technical.html#kb",          match: { path: "technical.html", hash: "#kb" } },
        { label: "Raise Installation Ticket", href: "installation-ticket.html", match: { path: "installation-ticket.html" }, roles: [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE] },
        { label: "Installation Dashboard", href: "technical-dashboard.html", match: { path: "technical-dashboard.html" } },
        { label: "Vehicle Installations", href: "vehicle-installation.html", match: { path: "vehicle-installation.html" } },
        { label: "Inventory Allocation", href: "crm-inventory-allocate.html", match: { path: "crm-inventory-allocate.html" }, roles: [ROLES.TECHNICAL, ROLES.ADMIN, ROLES.INSTALL_OFFICE] },
        { label: "Status Remarks", href: "status-remarks.html", match: { path: "status-remarks.html" } },
        { label: "GPS Uninstall Queue", href: "gps-uninstall-queue.html", roles: [ROLES.ADMIN, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE, ROLES.FINANCE], match: { path: "gps-uninstall-queue.html" } },
      ],
    },

    {
      key: "finance",
      section: "Finance",
      roles: RBAC_NAV.Finance,
      icon: "finance",
      items: [
        { label: "Finance Dashboard", href: "finance-dashboard.html", finance: true, match: { path: "finance-dashboard.html" }, roles: [RBAC_NAV.Finance[0], RBAC_NAV.Finance[1]] },
        { label: "Quotes", href: "crm-quotes.html", match: { path: "crm-quotes.html" } },
        { label: "Proforma Invoices", href: "crm-proforma.html", match: { path: "crm-proforma.html" } },
        { label: "Invoice Dashboard", href: "finance-invoice-dashboard.html", finance: true, match: { path: "finance-invoice-dashboard.html" } },
        { subheader: "Setup", roles: [RBAC_NAV.Finance[0], RBAC_NAV.Finance[1]] },
        { label: "Bank Accounts", href: "bank-accounts.html", finance: true, match: { path: "bank-accounts.html" }, roles: [RBAC_NAV.Finance[0], RBAC_NAV.Finance[1]] },
        { label: "Bank Transactions Report", href: "bank-transactions-report.html", finance: true, match: { path: "bank-transactions-report.html" }, roles: [RBAC_NAV.Finance[0], RBAC_NAV.Finance[1]] },
      ],
    },
    {
      key: "admin",
      section: "Admin",
      roles: RBAC_NAV.Admin,
      icon: "shield",
      items: [
        { label: "Control Centre", href: "admin.html", match: { path: "admin.html" } },
        { label: "Users", href: "admin-users.html", match: { path: "admin-users.html" } },
        { label: "Access Control", href: "admin-access-control.html", match: { path: "admin-access-control.html" } },
        { label: "Ticket Categories", href: "admin-ticket-categories.html", match: { path: "admin-ticket-categories.html" } },
        { label: "Profile", href: "profile.html", match: { path: "profile.html" } },
        { label: "Audit logs", href: "admin-audit-logs.html", match: { path: "admin-audit-logs.html" } },
        { label: "Settings", href: "settings.html", match: { path: "settings.html" } },
      ],
    },
    {
      key: "certificates",
      section: "Certificate Management",
      roles: RBAC_NAV.Certificates,
      icon: "certificate",
      items: [
        { label: "Dashboard",              href: "certificate-dashboard.html",    match: { path: "certificate-dashboard.html" } },
        { label: "Generate Manual Certificate", href: "create-certificate.html",  match: { path: "create-certificate.html" } },
        { label: "Certificate Inventory", href: "certificate-inventory.html",    match: { path: "certificate-inventory.html" } },
        { label: "Certificate Validation",href: "certificate-validation.html",   match: { path: "certificate-validation.html" } },
        { label: "Certificate Detail Configuration", href: "certificate-bank-settings.html", match: { path: "certificate-bank-settings.html" } },
      ],
    },
    {
      key: "inventory",
      section: "Inventory Management",
      roles: RBAC_NAV.Inventory,
      icon: "inventory",
      items: [
        { label: "Dashboard",       href: "inventory-dashboard.html",    match: { path: "inventory-dashboard.html" } },
        { label: "Product Catalog", href: "inventory-catalog.html",      match: { path: "inventory-catalog.html" } },
        { label: "Device Ledger",   href: "inventory-items.html",        match: { path: "inventory-items.html" } },
        { label: "SIM Cards",       href: "inventory-sims.html",         match: { path: "inventory-sims.html" } },
        { label: "SIM Issuance",    href: "inventory-sim-issuance.html", match: { path: "inventory-sim-issuance.html" } },
        { label: "Mass Top-Up",     href: "inventory-mass-topup.html",   match: { path: "inventory-mass-topup.html" }, roles: [ROLES.ADMIN, ROLES.INVENTORY_MGR] },
        { label: "Custody Report",  href: "inventory-custody-report.html", match: { path: "inventory-custody-report.html" } },
        { label: "Reports",         href: "inventory-reports.html",      match: { path: "inventory-reports.html" }, roles: [ROLES.ADMIN, ROLES.INVENTORY_MGR, ROLES.WAREHOUSE, ROLES.PROCUREMENT] },
        { label: "Procurement",     href: "inventory-procurement.html",  match: { path: "inventory-procurement.html" } },
        { label: "Warranty & Defects", href: "inventory-warranty.html", match: { path: "inventory-warranty.html" } },
        { label: "Recycle Bin",       href: "inventory-recycle-bin.html", match: { path: "inventory-recycle-bin.html" }, roles: [ROLES.ADMIN] },
        { label: "Partner Pricing",   href: "admin-partner-pricing.html", match: { path: "admin-partner-pricing.html" }, roles: [ROLES.ADMIN, ROLES.INVENTORY_MGR] },
      ],
    },
    {
      key: "hr",
      section: "HR",
      roles: RBAC_NAV.AllStaff,
      icon: "hr",
      items: [
        { label: "HR Dashboard",     href: "hr-dashboard.html",      roles: [ROLES.ADMIN], match: { path: "hr-dashboard.html" } },
        { label: "Employees",        href: "hr-employees.html",      roles: [ROLES.ADMIN], match: { path: "hr-employees.html" } },
        { label: "Onboarding",       href: "hr-onboarding.html",     roles: [ROLES.ADMIN], match: { path: "hr-onboarding.html" } },
        { label: "Org Structure",    href: "hr-org.html",            roles: [ROLES.ADMIN], match: { path: "hr-org.html" } },
        { label: "Emp No Config",    href: "hr-emp-no-config.html",  roles: [ROLES.ADMIN], match: { path: "hr-emp-no-config.html" } },
        { label: "Performance",      href: "hr-performance.html",    roles: [ROLES.ADMIN], match: { path: "hr-performance.html" } },
        { label: "Benefits",         href: "hr-benefits.html",       roles: [ROLES.ADMIN], match: { path: "hr-benefits.html" } },
        { label: "Reports",          href: "hr-reports.html",        roles: [ROLES.ADMIN], match: { path: "hr-reports.html" } },
        { label: "Leave Config",     href: "hr-leave-types.html",    roles: [ROLES.ADMIN], match: { path: "hr-leave-types.html" } },
        { label: "Leave Approvals",  href: "hr-leave-approvals.html",roles: [ROLES.ADMIN, ROLES.TEAM_LEAD, ROLES.BDM, ROLES.BDM_CORPORATE], match: { path: "hr-leave-approvals.html" } },
        { label: "Leave Balances",   href: "hr-leave-balances.html", roles: [ROLES.ADMIN], match: { path: "hr-leave-balances.html" } },
        { label: "Leave Reports",    href: "hr-leave-reports.html",  roles: [ROLES.ADMIN], match: { path: "hr-leave-reports.html" } },
        { label: "Employee Users",   href: "hr-employee-users.html", roles: [ROLES.ADMIN], match: { path: "hr-employee-users.html" } },
        { label: "My Leave",         href: "hr-leave-apply.html",    match: { path: "hr-leave-apply.html" } },
        { label: "Leave Calendar",   href: "hr-leave-calendar.html", match: { path: "hr-leave-calendar.html" } },
        { label: "Team Leave",       href: "hr-manager-leave.html",  match: { path: "hr-manager-leave.html" } },
      ],
    },
    {
      key: "executive",
      section: "Executive",
      roles: RBAC_NAV.Executive,
      icon: "executive",
      items: [
        { label: "Executive Dashboard", href: "executive-dashboard.html", match: { path: "executive-dashboard.html" } },
      ],
    },
    {
      key: "partners",
      section: "Partners",
      roles: RBAC_NAV.Partners,
      icon: "partners",
      items: [
        { label: "Partners List",    href: "partners.html",            match: { path: "partners.html" } },
        { label: "Partner Detail",   href: "partner-detail.html",      match: { path: "partner-detail.html" } },
        { label: "Partner Portal ↗", href: "partner-portal-login.html", match: { path: "partner-portal-login.html" } },
      ],
    },
    {
      key: "archive",
      section: "Archive",
      roles: RBAC_NAV.Archive,
      icon: "archive",
      items: [
        { label: "Search Tracker Record",        href: "archive-installations.html",       match: { path: "archive-installations.html" } },
        { label: "Sales Report",                 href: "archive-sales-by-bank.html",       match: { path: "archive-sales-by-bank.html" }, roles: [ROLES.ADMIN, ROLES.EXECUTIVE] },
        { label: "Bank Report",                  href: "archive-bank-report.html",         match: { path: "archive-bank-report.html" } },
        { label: "Technician Report",             href: "archive-technician-report.html",   match: { path: "archive-technician-report.html" } },
        { label: "Search Fuel Records",           href: "archive-fuel-records.html",        match: { path: "archive-fuel-records.html" } },
        { label: "Search Speed Governor Record",  href: "archive-speed-governors.html",     match: { path: "archive-speed-governors.html" } },
        { label: "Gadget Batch Report",           href: "archive-gadget-batch-report.html", match: { path: "archive-gadget-batch-report.html" } },
        { label: "Gadgets In Store",              href: "archive-gadgets-in-store.html",    match: { path: "archive-gadgets-in-store.html" } },
        { label: "Gadgets At Hand",               href: "archive-gadgets-at-hand.html",     match: { path: "archive-gadgets-at-hand.html" } },
        { label: "Retired Inventory",             href: "archive-retired-inventory.html",   match: { path: "archive-retired-inventory.html" } },
        { label: "Retired SIMs",                  href: "archive-retired-sims.html",        match: { path: "archive-retired-sims.html" } },
        { label: "SIM Cards Report",               href: "archive-sim-inventory.html",       match: { path: "archive-sim-inventory.html" } },
        { label: "Tickets Dashboard",              href: "archive-tickets.html",             match: { path: "archive-tickets.html" } },
        { label: "Audit Log",                      href: "archive-audit-log.html",           match: { path: "archive-audit-log.html" } },
        { label: "Removal Logs",                   href: "archive-removals-log.html",        match: { path: "archive-removals-log.html" } },
        { label: "Certificate Repository",         href: "archive-certificates.html",        match: { path: "archive-certificates.html" } },
      ],
    },
  ];

  const resolveHref = (item) => (item.finance ? financeLink(item.href) : linkTo(item.href));

  const canAccess = (roles) => {
    if (!roles) return Boolean(user);
    if (!user) return false;
    if (user.role === ROLES.ADMIN && window.FINEMARK_APP?.CONFIG?.ADMIN_CAN_ACCESS_ALL_DASHBOARDS) {
      return true;
    }
    return roles.includes(user.role);
  };

  // Nav items are gated by a static per-section role list by default, but a
  // role can also be granted individual pages dynamically via the capability
  // system (admin-access-control.html) without being added to that list —
  // matching app.js's isAuthorized(), which already accepts either. Without
  // this fallback, granting one report to a role either does nothing (item
  // stays hidden) or requires adding that role to the whole section's list,
  // which wrongly reveals every other report in the section too.
  const itemFilename = (item) => {
    const href = resolveHref(item);
    return (item.match && item.match.path) || href.split("?")[0].split("/").pop();
  };
  const canAccessItem = (item, sectionRoles) => {
    if (canAccess(item.roles || sectionRoles)) return true;
    const allowedPages = user?.allowedPages;
    return Boolean(allowedPages && allowedPages.includes(itemFilename(item)));
  };

  const isActiveLink = (item) => {
    const match = item.match || {};
    const href = resolveHref(item);
    const itemPath = (match.path || href.split("?")[0].split("/").pop());
    if (itemPath !== filename) return false;
    if (match.hash !== undefined) {
      const h = window.location.hash;
      return h === match.hash || (match.hashDefault && (h === "" || h === "#"));
    }
    if (match.query) {
      return Object.keys(match.query).every((key) => currentParams.get(key) === match.query[key]);
    }
    if (match.queryEmpty) {
      return currentParams.toString() === "";
    }
    if (href.includes("?")) {
      const url = new URL(href, window.location.origin);
      for (const [key, value] of url.searchParams.entries()) {
        if (currentParams.get(key) !== value) return false;
      }
      return true;
    }
    return true;
  };

  const getAllowedItems = (section) => {
    const sectionRoles = section.roles;
    // Subheaders are plain labels, not real pages — no href to check against
    // allowedPages, so they stay purely role-gated.
    return section.items.filter((item) => item.subheader ? canAccess(item.roles || sectionRoles) : canAccessItem(item, sectionRoles));
  };

  const renderNavItem = (item) => {
    if (item.subheader) {
      return `<p class="px-3 pt-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">${item.subheader}</p>`;
    }
    return navItem(resolveHref(item), item.label, isActiveLink(item));
  };

  const renderNav = () => {
    if (!user) {
      return `
        <div class="space-y-2 text-sm">
          ${navItem(linkTo("login.html"), "Sign in", false)}
        </div>
      `;
    }
    const activeSection = NAV.find((section) => getAllowedItems(section).some((item) => !item.subheader && isActiveLink(item)));
    const savedKey = sessionStorage.getItem("fm_sidebar_open");
    const openKey = activeSection?.key || savedKey;
    return NAV.map((section) => {
      // No early role-only gate here — a section is visible if it has at
      // least one visible item, whether that item's visibility came from
      // the section's role list or from a per-page capability grant (see
      // getAllowedItems/canAccessItem above).
      const allowedItems = getAllowedItems(section);
      if (!allowedItems.some((item) => !item.subheader)) return "";
      const isOpen = openKey === section.key;
      const itemsMarkup = allowedItems.map((item) => renderNavItem(item)).join("");
      return `
        <div class="space-y-2">
          <button
            type="button"
            class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            data-sidebar-toggle="${section.key}"
            aria-expanded="${isOpen ? "true" : "false"}"
          >
            <span class="inline-flex items-center gap-2">
              ${iconSvg(section.icon)}
              <span>${section.section}</span>
            </span>
            <span class="transition-transform ${isOpen ? "rotate-180" : ""}">
              <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </span>
          </button>
          <div
            class="ml-2 rounded-lg border-l border-slate-200 pl-2 transition-all duration-300 ${isOpen ? "max-h-[9999px] opacity-100" : "max-h-0 opacity-0 overflow-hidden"}"
            data-sidebar-menu="${section.key}"
          >
            <div class="space-y-1 py-1 overflow-y-auto" style="max-height:17rem;scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent">
              ${itemsMarkup}
            </div>
          </div>
        </div>
      `;
    }).join("");
  };

  const renderMenuNav = () => {
    if (!user) {
      return `
        <div class="space-y-1">
          ${navItem(linkTo("login.html"), "Sign in", false)}
        </div>
      `;
    }
    return NAV.map((section) => {
      // No early role-only gate here — a section is visible if it has at
      // least one visible item, whether that item's visibility came from
      // the section's role list or from a per-page capability grant (see
      // getAllowedItems/canAccessItem above).
      const allowedItems = getAllowedItems(section);
      if (!allowedItems.some((item) => !item.subheader)) return "";
      const itemsMarkup = allowedItems.map((item) => renderNavItem(item)).join("");
      return `
        <div class="space-y-1">
          <p class="px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">${section.section}</p>
          ${itemsMarkup}
        </div>
      `;
    }).join("");
  };

  headerRoot.innerHTML = `
    <header class="fixed top-0 left-0 right-0 h-16 bg-white border-b border-slate-200 z-20">
      <div class="px-6 h-full flex items-center justify-between">
        <div class="flex items-center gap-3">
          <button id="fm-hamburger" type="button" title="Toggle menu"
            style="display:none;padding:0.5rem;border-radius:0.5rem;border:1px solid #e2e8f0;background:transparent;cursor:pointer;color:#475569;">
            <svg viewBox="0 0 24 24" style="width:1.25rem;height:1.25rem;" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
          </button>
          <img src="${logoSrc}" alt="Finemark logo" class="h-9 w-9" />
          <span class="font-semibold text-lg">Finemark</span>
        </div>
        <div class="flex items-center gap-3 text-sm relative">
          <span id="user-info" class="text-slate-600">${headerUserLabel}</span>
          <span class="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 border border-blue-100">
            ${badgeText}
          </span>
          <button id="mock-toggle" class="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold border ${window.FINEMARK_APP?.CONFIG?.MOCK_MODE ? "bg-emerald-50 text-emerald-700 border-emerald-100" : "bg-slate-100 text-slate-700 border-slate-200"} ${showMockToggle ? "" : "hidden"}">
            ${mockLabel}
          </button>
          <!-- Bell notification button -->
          <div class="relative" id="notif-bell-wrap">
            <button id="notif-bell-btn" type="button" class="relative rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40" title="Notifications">
              <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
              <span id="notif-badge" class="hidden absolute -top-1 -right-1 flex items-center justify-center h-4 min-w-[1rem] rounded-full bg-red-500 text-white text-[10px] font-bold px-1">0</span>
            </button>
            <div id="notif-panel" class="hidden absolute right-0 top-11 w-80 rounded-xl border border-slate-200 bg-white shadow-lg z-40">
              <div class="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                <span class="font-semibold text-sm text-slate-800">Notifications</span>
                <button id="notif-read-all" class="text-xs text-blue-600 hover:underline">Mark all read</button>
              </div>
              <div id="notif-list" class="overflow-y-auto" style="max-height:360px;scrollbar-width:thin">
                <p class="text-xs text-slate-400 p-4">Loading…</p>
              </div>
            </div>
          </div>
          <button id="top-menu-toggle" type="button" class="rounded-lg border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40">
            Menu ▾
          </button>
          <!-- User / Logout dropdown -->
          <div class="relative" id="profile-btn-wrap">
            <button id="profile-menu-btn" type="button"
              class="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 text-sm font-medium ${logoutClasses}"
              title="Account">
              <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              </svg>
              <span class="hidden sm:inline max-w-[120px] truncate">${user ? (user.name || user.email.split('@')[0]) : 'Account'}</span>
              <svg viewBox="0 0 24 24" class="h-3 w-3 shrink-0 opacity-70" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div id="profile-menu-panel" class="hidden absolute right-0 top-11 w-56 rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-200/60 py-1.5 z-40">
              <div class="px-4 py-2.5 border-b border-slate-100 mb-1">
                <p class="text-xs font-semibold text-slate-800 truncate">${user ? (user.name || user.email) : ''}</p>
                <p class="text-xs text-slate-400 truncate">${user ? user.email : ''}</p>
              </div>
              <a href="${linkTo('profile.html')}" class="flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors">
                <svg viewBox="0 0 24 24" class="h-4 w-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                My Profile
              </a>
              <a href="${linkTo('profile.html')}?tab=security" class="flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors">
                <svg viewBox="0 0 24 24" class="h-4 w-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                Security
              </a>
              <div class="border-t border-slate-100 my-1"></div>
              <button id="logout" type="button" class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-rose-600 hover:bg-rose-50 transition-colors">
                <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                Logout
              </button>
            </div>
          </div>
          <div id="top-menu-panel" class="hidden absolute right-0 top-14 w-72 rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-200/60 p-3 z-30">
            <div class="overflow-y-auto space-y-3" style="max-height:80vh;scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent">
              ${renderMenuNav()}
            </div>
          </div>
        </div>
      </div>
    </header>
  `;


  // ── Sidebar ──────────────────────────────────────────────────────────────
  sidebarRoot.innerHTML = `
    <aside id="fm-sidebar-panel"
      style="display:flex;flex-direction:column;width:240px;min-width:240px;flex-shrink:0;
             background:#fff;border-right:1px solid #e2e8f0;
             position:sticky;top:4rem;height:calc(100vh - 4rem);overflow:hidden;
             transition:transform 0.25s ease,width 0.25s ease;z-index:19;"
    >
      <nav style="flex:1;min-height:0;overflow-y:auto;padding:0.5rem;scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent;">
        <div class="space-y-1 py-1">
          ${renderNav()}
        </div>
      </nav>
    </aside>
    <div id="fm-sidebar-overlay"
      style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:18;"
    ></div>
  `;

  const openSection = (key) => {
    document.querySelectorAll("[data-sidebar-toggle]").forEach((btn) => {
      const targetKey = btn.getAttribute("data-sidebar-toggle");
      const menu = document.querySelector(`[data-sidebar-menu="${targetKey}"]`);
      const chevron = btn.querySelector("span.transition-transform");
      const isMatch = targetKey === key;
      btn.setAttribute("aria-expanded", isMatch ? "true" : "false");
      if (menu) {
        menu.classList.toggle("max-h-[9999px]", isMatch);
        menu.classList.toggle("opacity-100", isMatch);
        menu.classList.toggle("max-h-0", !isMatch);
        menu.classList.toggle("opacity-0", !isMatch);
        menu.classList.toggle("overflow-hidden", !isMatch);
      }
      if (chevron) {
        chevron.classList.toggle("rotate-180", isMatch);
      }
    });
  };

  document.querySelectorAll("[data-sidebar-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-sidebar-toggle");
      const isOpen = btn.getAttribute("aria-expanded") === "true";
      const nextKey = isOpen ? "" : key;
      if (nextKey) {
        sessionStorage.setItem("fm_sidebar_open", nextKey);
      } else {
        sessionStorage.removeItem("fm_sidebar_open");
      }
      openSection(nextKey);
    });
  });

  // ── Mobile sidebar toggle ──────────────────────────────────────────────────
  const sidebarPanel   = document.getElementById("fm-sidebar-panel");
  const sidebarOverlay = document.getElementById("fm-sidebar-overlay");
  const hamburger      = document.getElementById("fm-hamburger");

  const mq = window.matchMedia("(max-width: 767px)");

  const applyMobileState = (isMobile) => {
    if (!sidebarPanel) return;
    if (isMobile) {
      // On mobile: collapse the sidebar off-screen by default
      sidebarPanel.style.position = "fixed";
      sidebarPanel.style.top      = "4rem";
      sidebarPanel.style.left     = "0";
      sidebarPanel.style.height   = "calc(100vh - 4rem)";
      sidebarPanel.style.zIndex   = "29";
      sidebarPanel.style.transform = "translateX(-100%)";
      if (hamburger) hamburger.style.display = "inline-flex";
    } else {
      // Desktop: sticky, always visible
      sidebarPanel.style.position  = "sticky";
      sidebarPanel.style.top       = "4rem";
      sidebarPanel.style.left      = "";
      sidebarPanel.style.height    = "calc(100vh - 4rem)";
      sidebarPanel.style.zIndex    = "19";
      sidebarPanel.style.transform = "";
      if (hamburger) hamburger.style.display = "none";
      if (sidebarOverlay) sidebarOverlay.style.display = "none";
    }
  };

  applyMobileState(mq.matches);
  mq.addEventListener("change", (e) => applyMobileState(e.matches));

  const openMobileSidebar = () => {
    if (!sidebarPanel) return;
    sidebarPanel.style.transform = "translateX(0)";
    if (sidebarOverlay) sidebarOverlay.style.display = "block";
  };
  const closeMobileSidebar = () => {
    if (!sidebarPanel) return;
    sidebarPanel.style.transform = "translateX(-100%)";
    if (sidebarOverlay) sidebarOverlay.style.display = "none";
  };

  if (hamburger) hamburger.addEventListener("click", openMobileSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener("click", closeMobileSidebar);
  // Close on nav link click on mobile
  sidebarPanel?.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => { if (mq.matches) closeMobileSidebar(); });
  });

  footerRoot.innerHTML = `
    <footer class="bg-white border-t border-slate-200 text-center text-xs text-slate-500 py-4">
      © 2026 Finemark. All rights reserved.
    </footer>
  `;

  const logoutBtn = document.getElementById("logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      window.FINEMARK_APP?.clearSession?.();
      window.location.href = linkTo("login.html");
    });
  }

  const mockToggle = document.getElementById("mock-toggle");
  if (mockToggle && window.FINEMARK_APP?.toggleMockMode) {
    mockToggle.addEventListener("click", () => {
      const next = !window.FINEMARK_APP.CONFIG.MOCK_MODE;
      window.FINEMARK_APP.toggleMockMode(next);
      window.location.reload();
    });
  }

  const menuToggle = document.getElementById("top-menu-toggle");
  const menuPanel = document.getElementById("top-menu-panel");
  const closeMenu = (event) => {
    if (!menuPanel || !menuToggle) return;
    const target = event.target;
    if (menuPanel.contains(target) || menuToggle.contains(target)) return;
    menuPanel.classList.add("hidden");
  };
  if (menuToggle && menuPanel) {
    menuToggle.addEventListener("click", () => {
      menuPanel.classList.toggle("hidden");
    });
    document.addEventListener("click", closeMenu);
  }

  // Profile dropdown
  const profileBtn = document.getElementById("profile-menu-btn");
  const profilePanel = document.getElementById("profile-menu-panel");
  if (profileBtn && profilePanel) {
    profileBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      profilePanel.classList.toggle("hidden");
      if (menuPanel) menuPanel.classList.add("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!profilePanel.contains(e.target) && !profileBtn.contains(e.target)) {
        profilePanel.classList.add("hidden");
      }
    });
  }

  if (window.FINEMARK_APP?.requirePageAccess) {
    window.FINEMARK_APP.requirePageAccess();
  }

  // ── Bell notification logic ──────────────────────────────────────────────
  const bellBtn = document.getElementById("notif-bell-btn");
  const bellPanel = document.getElementById("notif-panel");
  const bellBadge = document.getElementById("notif-badge");
  const notifList = document.getElementById("notif-list");
  const readAllBtn = document.getElementById("notif-read-all");

  let notifLoaded = false;

  const renderNotifications = (notifications) => {
    if (!notifications.length) {
      notifList.innerHTML = `<p class="text-xs text-slate-400 p-4 text-center">No new notifications</p>`;
      return;
    }
    notifList.innerHTML = notifications.map(n => {
      const typeColor = n.type === "invoice" ? "bg-blue-50 text-blue-700" : n.type === "error" ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-600";
      const ago = (() => {
        const ms = Date.now() - new Date(n.createdAt).getTime();
        if (ms < 60000) return "just now";
        if (ms < 3600000) return Math.floor(ms / 60000) + "m ago";
        if (ms < 86400000) return Math.floor(ms / 3600000) + "h ago";
        return Math.floor(ms / 86400000) + "d ago";
      })();
      const href = n.link ? (n.link.startsWith("http") ? n.link : (basePath + n.link)) : "#";
      return `<a href="${href}" data-notif-id="${n.id}" class="notif-item flex gap-3 px-4 py-3 hover:bg-slate-50 border-b border-slate-50 last:border-0 cursor-pointer no-underline">
        <span class="mt-0.5 flex-shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-full ${typeColor} text-xs font-bold">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-xs font-semibold text-slate-800 truncate">${n.title}</p>
          ${n.body ? `<p class="text-xs text-slate-500 mt-0.5 line-clamp-2">${n.body}</p>` : ""}
          <p class="text-[10px] text-slate-400 mt-1">${ago}</p>
        </div>
      </a>`;
    }).join("");

    // Mark read on click
    notifList.querySelectorAll(".notif-item").forEach(el => {
      el.addEventListener("click", async () => {
        const id = el.getAttribute("data-notif-id");
        if (id && window.FINEMARK_APP?.apiFetch) {
          await window.FINEMARK_APP.apiFetch(`/notifications/${id}/read`, { method: "PATCH" }).catch(() => {});
        }
      });
    });
  };

  const loadNotifications = async () => {
    if (!window.FINEMARK_APP?.apiFetch || !user) return;
    try {
      const data = await window.FINEMARK_APP.apiFetch("/notifications");
      const notifs = data?.notifications || [];
      const unread = data?.unread || 0;
      if (unread > 0) {
        bellBadge.textContent = unread > 9 ? "9+" : String(unread);
        bellBadge.classList.remove("hidden");
      } else {
        bellBadge.classList.add("hidden");
      }
      renderNotifications(notifs);
      notifLoaded = true;
    } catch (_) {
      if (notifList) notifList.innerHTML = `<p class="text-xs text-slate-400 p-4 text-center">Could not load notifications</p>`;
    }
  };

  if (bellBtn && bellPanel) {
    bellBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      bellPanel.classList.toggle("hidden");
      if (!bellPanel.classList.contains("hidden") && !notifLoaded) {
        loadNotifications();
      }
    });
    document.addEventListener("click", (e) => {
      if (!bellPanel.contains(e.target) && !bellBtn.contains(e.target)) {
        bellPanel.classList.add("hidden");
      }
    });
  }

  if (readAllBtn) {
    readAllBtn.addEventListener("click", async () => {
      if (!window.FINEMARK_APP?.apiFetch) return;
      await window.FINEMARK_APP.apiFetch("/notifications/read-all", { method: "PATCH" }).catch(() => {});
      bellBadge.classList.add("hidden");
      if (notifList) notifList.innerHTML = `<p class="text-xs text-slate-400 p-4 text-center">No new notifications</p>`;
    });
  }

  // Poll for new notifications every 60s
  if (user) {
    setTimeout(() => loadNotifications(), 2000);
    setInterval(() => loadNotifications(), 60000);
  }
})();
