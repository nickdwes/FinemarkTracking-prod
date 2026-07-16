import { Router } from "express";
import { pgGet, pgAll } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok } from "../utils/responses.js";

const router = Router();

const daysBefore = (days: string | number) =>
  new Date(Date.now() - Number(days) * 86400000).toISOString();

// ─── Sales Dashboard ──────────────────────────────────────────────────────────

router.get(
  "/sales",
  requireAuth,
  requireRole(["Admin", "Sales", "Finance"]),
  async (req: AuthRequest, res) => {
    const { days = "30", partnerId = "" } = req.query as Record<string, string>;
    const since = daysBefore(days);

    const partnerFilter = partnerId ? " AND l.partner_id = ?" : "";
    const baseParams: any[] = [since];
    if (partnerId) baseParams.push(partnerId);

    const [
      totalLeads, convertedLeads, newLeads, qualifiedLeads,
      totalVehicles, partners, leaderboard, conversionBySource,
    ] = await Promise.all([
      pgGet(`SELECT count(*) AS n FROM crm_leads l WHERE l.created_at >= ?${partnerFilter}`, baseParams),
      pgGet(`SELECT count(*) AS n FROM crm_leads l WHERE l.status='Converted' AND l.created_at >= ?${partnerFilter}`, baseParams),
      pgGet(`SELECT count(*) AS n FROM crm_leads l WHERE l.status='New' AND l.created_at >= ?${partnerFilter}`, baseParams),
      pgGet(`SELECT count(*) AS n FROM crm_leads l WHERE l.status='Qualified' AND l.created_at >= ?${partnerFilter}`, baseParams),

      partnerId
        ? pgGet(`SELECT count(*) AS n FROM crm_customer_vehicles WHERE partner_id = ? AND deleted_at IS NULL AND created_at >= ?`, [partnerId, since])
        : pgGet(`SELECT count(*) AS n FROM crm_customer_vehicles WHERE deleted_at IS NULL AND created_at >= ?`, [since]),

      pgAll(`SELECT id, name, tier, status FROM partners WHERE deleted_at IS NULL ORDER BY name`, []),

      pgAll(
        `SELECT u.id, u.email, u.full_name,
                count(l.id) AS total,
                sum(CASE WHEN l.status='Converted' THEN 1 ELSE 0 END) AS converted
         FROM crm_leads l
         JOIN users u ON u.id = l.created_by
         WHERE l.created_at >= ?
         GROUP BY u.id, u.email, u.full_name
         ORDER BY converted DESC
         LIMIT 10`,
        [since]
      ),

      pgAll(
        `SELECT l.lead_source,
                count(*) AS total,
                sum(CASE WHEN l.status='Converted' THEN 1 ELSE 0 END) AS converted
         FROM crm_leads l WHERE l.created_at >= ?${partnerFilter}
         GROUP BY l.lead_source`,
        baseParams
      ),
    ]);

    const total = Number(totalLeads?.n || 0);
    const converted = Number(convertedLeads?.n || 0);

    return ok(res, {
      period: `${days} days`,
      totalLeads: total,
      newLeads: Number(newLeads?.n || 0),
      qualifiedLeads: Number(qualifiedLeads?.n || 0),
      convertedLeads: converted,
      conversionRate: total > 0 ? Math.round((converted / total) * 100) : 0,
      totalVehicles: Number(totalVehicles?.n || 0),
      partners: partners.map((p: any) => ({ id: p.id, name: p.name, tier: p.tier, status: p.status })),
      leaderboard: leaderboard.map((s: any) => ({
        id: s.id, name: s.full_name || s.email,
        totalLeads: Number(s.total), converted: Number(s.converted),
        rate: Number(s.total) > 0 ? Math.round((Number(s.converted) / Number(s.total)) * 100) : 0,
      })),
      bySource: conversionBySource.map((r: any) => ({
        source: r.lead_source || "Unknown",
        total: Number(r.total), converted: Number(r.converted),
      })),
    });
  }
);

// ─── Finance Dashboard ────────────────────────────────────────────────────────

router.get(
  "/finance",
  requireAuth,
  requireRole(ROLE_GROUPS.FINANCE_AMEND),
  async (req: AuthRequest, res) => {
    const { days = "30", partnerId = "" } = req.query as Record<string, string>;
    const since = daysBefore(days);

    const [invoices, quoteStats, partnerList] = await Promise.all([
      pgAll(
        `SELECT id, status, amount, created_at FROM invoices WHERE created_at >= ? ORDER BY created_at DESC`,
        [since]
      ),
      pgAll(
        `SELECT status, count(*) AS n FROM crm_quotes WHERE created_at >= ? GROUP BY status`,
        [since]
      ),
      pgAll(`SELECT id, name, tier FROM partners WHERE deleted_at IS NULL AND status='Active' ORDER BY name`, []),
    ]);

    const paid = invoices.filter((i: any) => i.status === "Paid");
    const pending = invoices.filter((i: any) => ["Unpaid", "Pending", "Sent"].includes(i.status));
    const overdue = invoices.filter((i: any) => i.status === "Overdue");
    const revenue = paid.reduce((s: number, i: any) => s + Number(i.amount || 0), 0);
    const pendingAmt = [...pending, ...overdue].reduce((s: number, i: any) => s + Number(i.amount || 0), 0);

    const quotesMap: Record<string, number> = {};
    quoteStats.forEach((q: any) => { quotesMap[q.status] = Number(q.n); });

    return ok(res, {
      period: `${days} days`,
      totalInvoices: invoices.length,
      paidInvoices: paid.length, pendingInvoices: pending.length, overdueInvoices: overdue.length,
      totalRevenue: revenue, pendingAmount: pendingAmt,
      quotesDraft: quotesMap["Draft"] || 0,
      quotesSent: quotesMap["Sent"] || 0,
      quotesAccepted: quotesMap["Accepted"] || 0,
      partners: partnerList.map((p: any) => ({ id: p.id, name: p.name, tier: p.tier })),
    });
  }
);

// ─── Technical Dashboard ──────────────────────────────────────────────────────

router.get(
  "/technical",
  requireAuth,
  requireRole(["Admin", "Sales", "Operations", "Technical"]),
  async (req: AuthRequest, res) => {
    const { days = "30" } = req.query as Record<string, string>;
    const since = daysBefore(days);

    const [jobStatusGroups, totalTickets, totalCerts, recentJobs] = await Promise.all([
      pgAll(
        `SELECT status, count(*) AS n FROM installation_tickets WHERE created_at >= ? GROUP BY status`,
        [since]
      ),
      pgGet(`SELECT count(*) AS n FROM installation_tickets WHERE created_at >= ?`, [since]),
      pgGet(`SELECT count(*) AS n FROM certificates WHERE created_at >= ?`, [since]),
      pgAll(
        `SELECT it.id, it.ticket_no, it.status, it.created_at,
                c.account_no, cp.full_name AS customer_name, corp.company_name
         FROM installation_tickets it
         LEFT JOIN crm_customers c ON c.id = it.customer_id
         LEFT JOIN crm_individual_profiles cp ON cp.customer_id = it.customer_id
         LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = it.customer_id
         WHERE it.created_at >= ?
         ORDER BY it.created_at DESC LIMIT 20`,
        [since]
      ),
    ]);

    const statusMap: Record<string, number> = {};
    jobStatusGroups.forEach((j: any) => { statusMap[j.status] = Number(j.n); });

    return ok(res, {
      period: `${days} days`,
      totalJobs: Number(totalTickets?.n || 0),
      open: statusMap["Open"] || 0,
      assigned: statusMap["Assigned"] || 0,
      inProgress: statusMap["InProgress"] || statusMap["In Progress"] || 0,
      completed: statusMap["Completed"] || 0,
      certificatesGenerated: Number(totalCerts?.n || 0),
      recentJobs: recentJobs.map((j: any) => ({
        id: j.id, ticketNo: j.ticket_no, status: j.status, createdAt: j.created_at,
        customerName: j.customer_name || j.company_name || "—", accountNo: j.account_no,
      })),
    });
  }
);

// ─── Inventory Dashboard ──────────────────────────────────────────────────────

router.get(
  "/inventory",
  requireAuth,
  requireRole(["Admin", "Operations", "Technical"]),
  async (req: AuthRequest, res) => {
    const { days = "30" } = req.query as Record<string, string>;
    const since = daysBefore(days);

    const [categoryGroups, totalItems, lowStockItems, recentMovements] = await Promise.all([
      pgAll(`SELECT category, count(*) AS n FROM inv_items GROUP BY category ORDER BY n DESC`, []),
      pgGet(`SELECT count(*) AS n FROM inv_items`, []),
      pgAll(
        `SELECT id, name, serial_no, category FROM inv_items WHERE quantity <= min_quantity AND deleted_at IS NULL LIMIT 20`,
        []
      ).catch(() => []),
      pgAll(
        `SELECT movement_type, count(*) AS n FROM inv_movements WHERE created_at >= ? GROUP BY movement_type`,
        [since]
      ).catch(() => []),
    ]);

    return ok(res, {
      period: `${days} days`,
      totalItems: Number(totalItems?.n || 0),
      byCategory: categoryGroups.map((c: any) => ({ category: c.category || "Uncategorised", count: Number(c.n) })),
      lowStock: (lowStockItems as any[]).map((i: any) => ({
        id: i.id, name: i.name, serialNo: i.serial_no, category: i.category,
      })),
      movements: (recentMovements as any[]).map((m: any) => ({
        type: m.movement_type, count: Number(m.n),
      })),
    });
  }
);

export default router;
