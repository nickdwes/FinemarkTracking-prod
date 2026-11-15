/**
 * Canonical roles — mirrors finemark-backend/src/middleware/rbac.ts ROLES enum.
 * Used to drive the role-adaptive navigation shell and home hub.
 */
export const ROLES = {
  ADMIN: 'Admin',
  EXECUTIVE: 'Executive',
  SALES: 'Sales', // retail sales team (the largest sales cohort)
  FIELD_SALES: 'FieldSales',
  BDM: 'BDM',
  BDM_CORPORATE: 'BDMCorporate',
  CORPORATE_SALES: 'CorporateSales',
  KAM: 'KAM',
  TELESALES: 'Telesales',
  INVENTORY_MGR: 'InventoryManager',
  TECHNICIAN: 'Technician',
  TECHNICAL: 'Technical', // ISO — Installation Support Officer
  INSTALL_OFFICE: 'InstallOffice',
  CERT_ADMIN: 'CertAdmin',
  FINANCE: 'Finance',
  HR: 'HR',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const TECHNICAL_ROLES: string[] = [
  ROLES.TECHNICIAN,
  ROLES.TECHNICAL,
  ROLES.INSTALL_OFFICE,
];

export const SALES_ROLES: string[] = [
  ROLES.SALES,
  ROLES.FIELD_SALES,
  ROLES.BDM,
  ROLES.BDM_CORPORATE,
  ROLES.CORPORATE_SALES,
  ROLES.KAM,
  ROLES.TELESALES,
];

export const FINANCE_ROLES: string[] = [ROLES.FINANCE];

// Roles that can act on the Approvals tab. Grounded in what its two backing
// endpoints actually allow (finemark-backend/src/routes/vehicles.ts GET
// /change-requests = ADMIN_ROLES = [Admin] only; crm-proforma.ts's approve/
// reject = ROLE_GROUPS.PROFORMA_APPROVE = [Admin, Finance, BDM, BDMCorporate])
// — NOT Technician/Technical/InstallOffice/Executive, none of whom the
// backend permits on either endpoint, however plausible it looks that an ISO
// or install office role "should" review something here.
export const VEHICLE_CHANGE_APPROVER_ROLES: string[] = [ROLES.ADMIN];
export const PROFORMA_APPROVER_ROLES: string[] = [ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE];
/** Anyone who can act on at least one of the Approvals tab's two sub-tabs. */
export const APPROVER_ROLES: string[] = [...new Set([...VEHICLE_CHANGE_APPROVER_ROLES, ...PROFORMA_APPROVER_ROLES])];

export interface SessionUser {
  id: string;
  name?: string;
  email: string;
  role: string;
  effectiveRole?: string;
  status?: string;
  forcePasswordReset?: boolean;
  employeeNo?: string | null;
  rosterMemberType?: string | null; // 'Technician' | 'ISO' | null
}

/** Resolve the base capability role (custom roles carry an effectiveRole). */
export function baseRole(user?: SessionUser | null): string {
  return (user?.effectiveRole || user?.role || '').trim();
}

export function hasAnyRole(user: SessionUser | null | undefined, allowed: string[]): boolean {
  const r = baseRole(user);
  return allowed.includes(r) || r === ROLES.ADMIN;
}

export type TabKey = 'home' | 'jobs' | 'custody' | 'leads' | 'customers' | 'quotations' | 'team' | 'invoices' | 'approvals' | 'reports' | 'me';

/** Sales-manager roles that see a team-performance view. */
export const SALES_MANAGER_ROLES: string[] = [ROLES.BDM, ROLES.BDM_CORPORATE];

/** Which tabs a given role sees. Admin sees the superset. */
export function tabsForRole(user: SessionUser | null | undefined): TabKey[] {
  const r = baseRole(user);
  const canApprove = APPROVER_ROLES.includes(r);
  if (r === ROLES.ADMIN || r === ROLES.EXECUTIVE) {
    // Executive has no approval authority on the backend either — only Admin does here.
    const base: TabKey[] = ['home', 'jobs', 'leads', 'reports', 'me'];
    return canApprove ? ['home', 'jobs', 'leads', 'approvals', 'reports', 'me'] : base;
  }
  if (TECHNICAL_ROLES.includes(r)) {
    // None of Technician/Technical(ISO)/InstallOffice have approval authority on
    // the backend — showing the tab anyway just sent them to a screen that 403s.
    const base: TabKey[] = ['home', 'jobs', 'custody', 'reports', 'me'];
    return canApprove ? ['home', 'jobs', 'custody', 'approvals', 'reports', 'me'] : base;
  }
  if (SALES_ROLES.includes(r)) {
    // Managers (BDM / BDMCorporate) additionally get Team performance + Approvals
    // (they're in PROFORMA_APPROVER_ROLES) — previously missing entirely.
    if (SALES_MANAGER_ROLES.includes(r)) {
      const base: TabKey[] = ['home', 'team', 'leads', 'customers', 'quotations', 'me'];
      return canApprove ? ['home', 'team', 'leads', 'customers', 'quotations', 'approvals', 'me'] : base;
    }
    return ['home', 'leads', 'customers', 'quotations', 'me'];
  }
  if (r === ROLES.FINANCE) {
    return ['home', 'invoices', 'approvals', 'reports', 'me'];
  }
  if (r === ROLES.INVENTORY_MGR) {
    return ['home', 'custody', 'reports', 'me'];
  }
  // Fallback: everyone at least gets home + reports + profile.
  return ['home', 'reports', 'me'];
}
