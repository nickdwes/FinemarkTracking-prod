import { pgAll } from "../db.js";

/**
 * Resolves which users' records a sales-intelligence viewer is allowed to see.
 * `userIds`/`emails` are both null when the role has unrestricted visibility
 * (Admin/Executive). Otherwise they list the viewer's own id/email plus,
 * for team-lead roles, their team's — mirroring crm-leads.ts's teamLeadScope()
 * but generalized across every table used by the sales dashboard/reports
 * (some are keyed by user id — crm_leads, crm_quotes, crm_customers,
 * crm_communication_logs — while invoices.sales_person is an email).
 */
export interface SalesScope {
  userIds: string[] | null;
  emails: string[] | null;
}

const CORP_LEAD_ROLES = ["CorporateSales", "BDMCorporate"];

export async function resolveSalesScope(role: string, userId: string): Promise<SalesScope> {
  if (["Admin", "Executive"].includes(role)) {
    return { userIds: null, emails: null };
  }

  let userIds: string[];

  if (role === "BDM") {
    // Retail team = this BDM's live direct reports via the org chart, same
    // subquery crm-leads.ts's RETAIL_TEAM_SUBQUERY uses — there can be
    // several regional BDMs, so this must reflect the real reporting line
    // rather than a fixed role list.
    const rows = await pgAll<{ user_account_id: string }>(
      `SELECT e.user_account_id FROM hr_employees e
       JOIN hr_employees mgr ON mgr.id = e.manager_id
       WHERE mgr.user_account_id = ? AND e.user_account_id IS NOT NULL AND e.status = 'Active'`,
      [userId]
    );
    userIds = [userId, ...rows.map((r) => r.user_account_id)];
  } else if (role === "BDMCorporate") {
    // Corporate team is scoped by role rather than org chart, matching
    // crm-leads.ts's CORP_LEAD_ROLES precedent — there's currently one
    // corporate manager, so a fixed role list is the simpler equivalent.
    const rows = await pgAll<{ id: string }>(
      `SELECT id FROM users WHERE role = ANY(?::text[])`,
      [CORP_LEAD_ROLES]
    );
    userIds = [...new Set([userId, ...rows.map((r) => r.id)])];
  } else {
    // Individual contributor (Sales, Telesales, FieldSales, CorporateSales, KAM) — self only.
    userIds = [userId];
  }

  const emailRows = userIds.length
    ? await pgAll<{ email: string }>(`SELECT email FROM users WHERE id = ANY(?::text[])`, [userIds])
    : [];
  return { userIds, emails: emailRows.map((r) => r.email) };
}
