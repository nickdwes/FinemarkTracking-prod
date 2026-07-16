import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { pgGet } from "../db.js";

const router = Router();

/**
 * GET /api/admin/stats
 * Returns aggregated KPI counts for the Admin Landing Page.
 */
router.get(
  "/",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (_req, res) => {
    const [
      users, employees,
      installsTotal, installsMonth, openInstallTickets,
      customersActive, customersTotal,
      certsTotal, certsMonth, certsExpiring30d,
      invoices, leads, tickets, alerts,
    ] = await Promise.all([
      // Accounts
      pgGet(`SELECT COUNT(*) AS n FROM users WHERE status = 'Active'`, []),
      pgGet(`SELECT COUNT(*) AS n FROM hr_employees`, []),
      // Installations
      pgGet(`SELECT COUNT(*) AS n FROM vi_installations WHERE deleted_at IS NULL`, []),
      pgGet(`SELECT COUNT(*) AS n FROM vi_installations WHERE deleted_at IS NULL AND created_at::timestamptz >= date_trunc('month', CURRENT_DATE)`, []),
      pgGet(`SELECT COUNT(*) AS n FROM installation_tickets WHERE deleted_at IS NULL AND status NOT IN ('Completed','Cancelled')`, []),
      // Customers
      pgGet(`SELECT COUNT(*) AS n FROM crm_customers WHERE deleted_at IS NULL AND status = 'Active'`, []),
      pgGet(`SELECT COUNT(*) AS n FROM crm_customers WHERE deleted_at IS NULL`, []),
      // Certificates
      pgGet(`SELECT COUNT(*) AS n FROM certificates`, []),
      pgGet(`SELECT COUNT(*) AS n FROM certificates WHERE created_at::timestamptz >= date_trunc('month', CURRENT_DATE)`, []),
      pgGet(`SELECT COUNT(*) AS n FROM certificates WHERE end_date::date <= CURRENT_DATE + 30 AND end_date::date >= CURRENT_DATE`, []),
      // Finance / CRM / Audit
      pgGet(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'Unpaid'`, []),
      pgGet(`SELECT COUNT(*) AS n FROM crm_leads WHERE deleted_at IS NULL AND status NOT IN ('Converted','Lost','Closed','Cancelled')`, []),
      pgGet(`SELECT COUNT(*) AS n FROM crm_tickets WHERE status IN ('Open','In Progress')`, []),
      pgGet(`SELECT COUNT(*) AS n FROM audit_logs WHERE severity IN ('Warning','Critical') AND timestamp::timestamptz > NOW() - INTERVAL '7 days'`, []),
    ]);

    return res.json({
      // Accounts
      activeUsers:        Number(users?.n           ?? 0),
      totalEmployees:     Number(employees?.n        ?? 0),
      // Installations
      installsTotal:      Number(installsTotal?.n    ?? 0),
      installsThisMonth:  Number(installsMonth?.n    ?? 0),
      openInstallTickets: Number(openInstallTickets?.n ?? 0),
      // Customers
      customersActive:    Number(customersActive?.n  ?? 0),
      customersTotal:     Number(customersTotal?.n   ?? 0),
      // Certificates
      certsTotal:         Number(certsTotal?.n       ?? 0),
      certsThisMonth:     Number(certsMonth?.n       ?? 0),
      certsExpiring30d:   Number(certsExpiring30d?.n ?? 0),
      // Finance / CRM / Audit
      unpaidInvoices:     Number(invoices?.n         ?? 0),
      openLeads:          Number(leads?.n            ?? 0),
      openTickets:        Number(tickets?.n          ?? 0),
      auditAlerts:        Number(alerts?.n           ?? 0),
    });
  }
);

export default router;
