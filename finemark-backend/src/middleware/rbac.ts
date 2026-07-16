/**
 * Finemark RBAC / ABAC Middleware & Helpers
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for:
 *   1. Canonical role constants  (ROLES)
 *   2. Role group aliases        (ROLE_GROUPS) — used in requireRole() calls
 *   3. requireRole()             — RBAC enforcement middleware
 *   4. ABAC helpers              — ownership / scope SQL-clause builders
 *
 * All route files MUST import from here rather than hard-coding role strings.
 * See finemark-backend/RBAC-ABAC-STRATEGY.md for full policy documentation.
 */

import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.js";
import { errorResponse } from "../utils/responses.js";
import { pgAll } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. CANONICAL ROLE CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const ROLES = {
  /** Full system access — no route or data restrictions. */
  ADMIN:           "Admin",

  /** Executive / Directors — full read + transaction; no system configuration. */
  EXECUTIVE:       "Executive",

  /** Business Development Manager (Retail) — full CRM, partners, campaigns; scoped to retail sales team leads. */
  BDM:             "BDM",

  /** Business Development Manager (Corporate) — full CRM, partners, campaigns; scoped to corporate sales team leads. */
  BDM_CORPORATE:   "BDMCorporate",

  /** Corporate Sales representative — own customers & leads only (ABAC). */
  CORPORATE_SALES: "CorporateSales",

  /** Key Account Manager — partner-scoped CRM visibility (ABAC). */
  KAM:             "KAM",

  /** Telesales agent — assigned leads, quotes, invoices, campaigns. */
  TELESALES:       "Telesales",

  /** Inventory Manager — full inventory module + device issuance + leads. */
  INVENTORY_MGR:   "InventoryManager",

  /** Field Technician — leads up to qualification stage + assigned tickets/jobs. */
  TECHNICIAN:      "Technician",

  /**
   * Installation Support Officer (ISO).
   * Stored as "Technical" in the DB for backward compatibility.
   * Can view the technical pipeline, assign tickets, and close jobs.
   */
  TECHNICAL:       "Technical",

  /**
   * Installation Office — manages installation scheduling, ticket assignment,
   * gadget activation and job closure ready for certification.
   */
  INSTALL_OFFICE:  "InstallOffice",

  /** Certificate Administrator — cert pipeline: generate, edit, deliver. */
  CERT_ADMIN:      "CertAdmin",

  /** Finance team member — dashboards, invoice amendment, procurement. */
  FINANCE:         "Finance",

  /** HR Manager — full HR module administration. */
  HR:              "HR",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// ─────────────────────────────────────────────────────────────────────────────
// 2. ROLE GROUPS  (pass directly to requireRole())
// ─────────────────────────────────────────────────────────────────────────────

export const ROLE_GROUPS = {

  /** System-level administration only. */
  ADMIN_ONLY: [ROLES.ADMIN],

  /** Admin + Executive: full operational read access. */
  MANAGEMENT: [ROLES.ADMIN, ROLES.EXECUTIVE],

  /** All roles with any CRM read access. */
  CRM_ACCESS: [
    ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.BDM, ROLES.BDM_CORPORATE,
    ROLES.CORPORATE_SALES, ROLES.KAM, ROLES.TELESALES,
    ROLES.FINANCE, ROLES.INVENTORY_MGR, ROLES.TECHNICIAN, ROLES.CERT_ADMIN,
  ],

  /** Roles that can approve / reject proforma invoices. */
  PROFORMA_APPROVE: [ROLES.ADMIN, ROLES.FINANCE, ROLES.BDM, ROLES.BDM_CORPORATE],

  /**
   * Roles that see ALL CRM records with no row-level filter.
   * All other CRM_ACCESS roles are subject to ABAC ownership filtering.
   * Note: BDM and BDMCorporate have additional team-scope filtering in crm-leads.ts.
   */
  CRM_FULL_VISIBILITY: [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.FINANCE],

  /** Roles that can create installation tickets. */
  CAN_RAISE_TICKETS: [
    ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.BDM, ROLES.BDM_CORPORATE,
    ROLES.CORPORATE_SALES, ROLES.KAM, ROLES.TELESALES,
  ],

  /** Partner list + Partner 360 access. */
  PARTNER_ACCESS: [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.KAM],

  /** Roles that can create and manage campaigns. */
  CAMPAIGNS: [ROLES.ADMIN, ROLES.BDM, ROLES.BDM_CORPORATE, ROLES.TELESALES],

  /** Full inventory management (all CRUD + device issuance). */
  INVENTORY_FULL: [ROLES.ADMIN, ROLES.INVENTORY_MGR],

  /** Read-only inventory visibility. */
  INVENTORY_VIEW: [
    ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.INVENTORY_MGR,
    ROLES.FINANCE, ROLES.TECHNICIAN, ROLES.TECHNICAL,
  ],

  /** Technical pipeline — dashboard, jobs, ticket view. */
  TECHNICAL_ACCESS: [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE],

  /** Can assign tickets to technicians and close jobs. */
  TICKET_MANAGEMENT: [ROLES.ADMIN, ROLES.TECHNICAL, ROLES.INSTALL_OFFICE],

  /** Certificate generation, editing, and delivery. */
  CERT_ACCESS: [ROLES.ADMIN, ROLES.CERT_ADMIN],

  /** Certificate read-only (dashboards, completed jobs awaiting cert). */
  CERT_VIEW: [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.CERT_ADMIN],

  /** Finance dashboards, invoice management, procurement. */
  FINANCE_ACCESS: [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.FINANCE],

  /** Can amend quotes, proforma invoices, and final invoices. */
  FINANCE_AMEND: [ROLES.ADMIN, ROLES.FINANCE],

  /** Can edit purchase / sales prices and purchase orders. */
  FINANCE_PRICING: [ROLES.ADMIN, ROLES.FINANCE],

  /** Full HR module administration. */
  HR_ADMIN: [ROLES.ADMIN, ROLES.HR],

  /**
   * Support-ticket team routing (crm-tickets.ts) — a category's configured
   * team decides who sees it in their "My Team" inbox. "Support"/"Operations"
   * aren't in ROLES (crm-tickets.ts has always used them as bare strings,
   * not part of the canonical role set), kept as-is for consistency with the
   * ticket system's existing convention rather than inventing new ROLES here.
   */
  TEAM_TECHNICAL: [ROLES.ADMIN, ROLES.TECHNICAL, ROLES.TECHNICIAN, ROLES.INSTALL_OFFICE],
  TEAM_FINANCE:   [ROLES.ADMIN, ROLES.FINANCE],
  TEAM_SUPPORT:   [ROLES.ADMIN, "Support", "Operations"],

  /** Every authenticated ERP role (used for self-service endpoints). */
  ALL_AUTHENTICATED: Object.values(ROLES) as string[],

} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 3. RBAC MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps legacy DB role strings (pre-migration) to their canonical equivalents.
 * When a user still carries an old role value, `requireRole` will accept gates
 * that list the canonical replacement, preventing silent lock-outs during the
 * transition period.
 */
export const LEGACY_ROLE_MAP: Record<string, string> = {
  Sales:       ROLES.CORPORATE_SALES,  // legacy "Sales" → CorporateSales
  FieldSales:  ROLES.CORPORATE_SALES,  // legacy "FieldSales" → CorporateSales
  TeamLead:    ROLES.BDM,              // legacy "TeamLead" → BDM (closest match)
  Inventory:   ROLES.INVENTORY_MGR,    // legacy "Inventory" → InventoryManager
  CRM:         ROLES.BDM,              // legacy "CRM" → BDM
  Manager:     ROLES.EXECUTIVE,        // legacy "Manager" → Executive
  Management:  ROLES.EXECUTIVE,        // legacy "Management" → Executive
};

export const requireRole = (roles: readonly string[] | string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    const effectiveRole = req.user?.effectiveRole;
    const allowed = roles as string[];
    // Resolve legacy role to its canonical equivalent for the check
    const canonicalRole = role ? (LEGACY_ROLE_MAP[role] ?? role) : undefined;
    if (
      !role ||
      (!allowed.includes(role) &&
       !(canonicalRole && allowed.includes(canonicalRole)) &&
       !(effectiveRole && allowed.includes(effectiveRole)))
    ) {
      return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this resource.");
    }
    return next();
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. ABAC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true when the role bypasses all row-level CRM filters. */
export function hasCrmFullVisibility(role: string): boolean {
  const canonical = LEGACY_ROLE_MAP[role] ?? role;
  return (ROLE_GROUPS.CRM_FULL_VISIBILITY as readonly string[]).includes(canonical);
}

/**
 * Builds a parameterised SQL WHERE-clause fragment that restricts CRM-ish
 * rows to the records the requesting user is permitted to see.
 *
 * Precedence:
 *   Admin / Executive / BDM / Finance → null (no filter)
 *   KAM        → partner_id IN (SELECT id FROM partners WHERE key_account_manager_id = ?)
 *   All others → (<ownerCol> = ? OR <creatorCol> = ?)
 *
 * @param role       - req.user.role
 * @param userId     - req.user.id
 * @param opts.alias      - optional table alias prefix e.g. "l." for the leads table
 * @param opts.ownerCol   - the "assigned to" column name for this table (default "assigned_to")
 * @param opts.creatorCol - the "created by" column name for this table (default "created_by")
 *
 * This was originally hardcoded to `assigned_to`/`created_by`, which no real
 * table actually used verbatim (crm-quotes.ts has `sales_rep_id`, others have
 * their own names) — every module ended up hand-rolling its own copy of this
 * exact clause instead of calling it. Column names are now configurable so
 * one shared implementation actually fits every caller's schema.
 */
export function crmOwnershipClause(
  role:   string,
  userId: string,
  opts: { alias?: string; ownerCol?: string; creatorCol?: string } = {},
): { clause: string | null; params: string[] } {
  const { alias = "", ownerCol = "assigned_to", creatorCol = "created_by" } = opts;
  const canonical = LEGACY_ROLE_MAP[role] ?? role;
  if (hasCrmFullVisibility(canonical)) {
    return { clause: null, params: [] };
  }

  if (canonical === ROLES.KAM) {
    return {
      clause: `${alias}partner_id IN (SELECT id FROM partners WHERE key_account_manager_id = ?)`,
      params: [userId],
    };
  }

  // Default: ownership by assignment or creation
  return {
    clause: `(${alias}${ownerCol} = ? OR ${alias}${creatorCol} = ?)`,
    params: [userId, userId],
  };
}

/**
 * ABAC record-level guard for single-record fetches.
 *
 * Returns false when the user has no right to access the specific record
 * and the caller should respond with 403.
 */
export function userCanAccessRecord(opts: {
  role:             string;
  userId:           string;
  recordOwnerId:    string | null;   // typically assigned_to
  recordCreatorId?: string | null;   // typically created_by
  kamId?:           string | null;   // partner.key_account_manager_id
}): boolean {
  const { role, userId, recordOwnerId, recordCreatorId, kamId } = opts;
  const canonical = LEGACY_ROLE_MAP[role] ?? role;

  // Full-visibility roles bypass record-level checks
  if (hasCrmFullVisibility(canonical)) return true;

  // KAM — check via KAM assignment on the linked partner
  if (canonical === ROLES.KAM) return kamId === userId;

  // All others: direct ownership
  return recordOwnerId === userId || (!!recordCreatorId && recordCreatorId === userId);
}

/**
 * Individual-contributor sales roles only see `crm_customers` rows (and
 * anything joined through them, e.g. vehicles) that they're the account
 * manager for, created, or introduced via a lead — scoped specifically to
 * these three roles, not "everyone lacking full CRM visibility": roles like
 * Technical/ISO have no account-manager/lead relationship to a customer at
 * all and legitimately need to look up any customer while servicing a job,
 * so scoping them down here would 404 every record for them instead.
 *
 * Was duplicated verbatim across crm-customers.ts and vehicles.ts (the
 * latter joins `crm_customers c` to reach a vehicle's owner) — both now call
 * this one copy instead. Requires the caller's query to alias
 * `crm_customers` as `c` (matching both current call sites).
 */
export const INDIVIDUAL_SALES_ROLES = new Set(["CorporateSales", "Telesales", "KAM"]);
export function isIndividualSalesRole(role: string): boolean {
  return INDIVIDUAL_SALES_ROLES.has(LEGACY_ROLE_MAP[role] ?? role);
}
export function buildCustomerOwnershipFilter(
  user: { id: string; role: string },
): { clause: string; params: string[] } {
  const canonicalRole = LEGACY_ROLE_MAP[user.role] ?? user.role;
  if (INDIVIDUAL_SALES_ROLES.has(canonicalRole)) {
    return {
      clause: `(c.account_manager_id = ? OR c.created_by_user_id = ? OR EXISTS (
        SELECT 1 FROM crm_leads l WHERE l.customer_id = c.id
          AND (l.sales_rep_id = ? OR l.assigned_to_id = ?)
          AND l.deleted_at IS NULL))`,
      params: [user.id, user.id, user.id, user.id],
    };
  }
  return { clause: "", params: [] };
}

/**
 * Resolves every ID a technician/ISO's own records might be filed under.
 *
 * `assigned_technician_id`/`custodian_technician_id`/`issued_to_id`-style
 * columns across the technical/install/custody domain may store either a
 * `users.id` or an `hr_employees.id` (for roster-unlinked accounts, resolved
 * by email match through `technical_team_roster`) — so a caller's own
 * `req.user.id` alone isn't always enough to find "their" rows.
 *
 * This exact query was duplicated 5+ times across `device-custody.ts`,
 * `inventory-sims.ts`, and `vehicle-installations.ts` before being
 * consolidated here — previously a roster-unlinked technician could see
 * their own job in one endpoint (which happened to do this resolution) and
 * get 403'd on another (which only compared the raw `user.id`).
 */
export async function resolveTechnicianIdSet(userId: string): Promise<Set<string>> {
  const rosterRows = await pgAll(
    `SELECT hr_employee_id, user_account_id FROM technical_team_roster
     WHERE user_account_id = ?
        OR (user_account_id IS NULL AND email IN (SELECT email FROM users WHERE id = ?))`,
    [userId, userId]
  );
  const ids = new Set<string>([userId]);
  for (const r of rosterRows as any[]) {
    if (r.hr_employee_id) ids.add(r.hr_employee_id);
    if (r.user_account_id) ids.add(r.user_account_id);
  }
  return ids;
}

/**
 * Lead stage restriction helper.
 *
 * Roles Technician, CertAdmin, and Finance may only create or edit leads
 * up to the "Qualified" stage.  Returns false when the given stage exceeds
 * what the role is permitted to set.
 */
export const LEAD_QUALIFICATION_STAGES = ["New", "Contacted", "Qualified"] as const;
export const LEAD_STAGE_RESTRICTED_ROLES: string[] = [
  ROLES.TECHNICIAN, ROLES.CERT_ADMIN, ROLES.FINANCE,
];

export function isLeadStageAllowed(role: string, stage: string): boolean {
  if (!LEAD_STAGE_RESTRICTED_ROLES.includes(role)) return true;
  return (LEAD_QUALIFICATION_STAGES as readonly string[]).includes(stage);
}

/**
 * Manager leave-approval ABAC.
 *
 * The leave-approval right is orthogonal to role — it is granted if the user
 * has direct reports in the HR org chart.  This helper confirms the role is a
 * valid ERP role; the route handler must still verify direct-report existence
 * via hr_employees.manager_id.
 */
export function canApproveLeave(role: string): boolean {
  return (ROLE_GROUPS.ALL_AUTHENTICATED as readonly string[]).includes(role);
}
