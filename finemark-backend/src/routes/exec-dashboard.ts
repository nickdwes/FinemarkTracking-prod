import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { pgAll, pgGet } from "../db.js";
import { auditLog } from "../services/auditService.js";
import { PRODUCT_TRACKS_INVENTORY } from "../services/nonStockProducts.js";

const router = Router();

// Single real-data aggregation for the Executive Dashboard — every query below
// runs directly against the live tables (no re-derivation of numbers already
// known to be broken elsewhere, e.g. installation SLA's dead iso-close gate,
// or crm_leads/retail_leads status-casing collisions when merged naively).
router.get("/", requireAuth, requireRole(ROLE_GROUPS.MANAGEMENT), async (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days || "30"), 10) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const sinceDate = since.slice(0, 10);
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const in60 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

  const [
    // ── Sales — corporate (crm_leads) ──────────────────────────────────
    corpLeadStatus, corpLeadSource, corpLeadNewInPeriod,
    // ── Sales — retail (retail_leads, ticket-derived) ───────────────────
    retailActive, retailCompletedInPeriod, retailSource,
    // ── Quotes ───────────────────────────────────────────────────────────
    quoteStatus, quoteValueInPeriod,
    // ── Revenue by sales person ──────────────────────────────────────────
    revenueBySales,
    // ── Finance ───────────────────────────────────────────────────────────
    invSummary, invoicedInPeriod, collectedInPeriod, outstandingTotal, overdueTotal, forecastRows,
    referrerCommissionPaid, advanceExposure,
    // ── Inventory ─────────────────────────────────────────────────────────
    invStockSummary, invValueRows, lowStockRows, topMovingProducts, retrievalBacklog,
    // ── Technical / Installations ────────────────────────────────────────
    instStatusCounts, instAvgHours, instSlaBreachOpen, techLeaderboard, instByFunnel,
    // ── Certificates ──────────────────────────────────────────────────────
    certStats, certAwaitingGen,
    // ── Support (CRM tickets) ────────────────────────────────────────────
    supportCards, supportByTeam, supportByCategory,
    // ── HR ────────────────────────────────────────────────────────────────
    hrTotals, hrByUnit, hrByRole,
  ] = await Promise.all([
    // Sales — corporate
    pgAll(`SELECT status, COUNT(*) n FROM crm_leads WHERE deleted_at IS NULL GROUP BY status`),
    pgAll(`SELECT lead_source, COUNT(*) n FROM crm_leads WHERE deleted_at IS NULL AND lead_source IS NOT NULL GROUP BY lead_source ORDER BY n DESC LIMIT 8`),
    pgGet(`SELECT COUNT(*) n FROM crm_leads WHERE deleted_at IS NULL AND created_at >= ?`, [since]),

    // Sales — retail (ticket-derived: reliable vs the raw status column)
    pgGet(
      `SELECT COUNT(*) n FROM retail_leads rl WHERE rl.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM installation_tickets t WHERE t.retail_lead_id = rl.id AND t.deleted_at IS NULL
                     AND t.status NOT IN ('Completed','Cancelled','Defaulted'))`
    ),
    pgGet(
      `SELECT COUNT(*) n FROM installation_tickets t WHERE t.deleted_at IS NULL AND t.retail_lead_id IS NOT NULL
         AND t.status = 'Completed' AND t.technician_signed_off_at >= ?`,
      [since]
    ),
    pgAll(`SELECT lead_source, COUNT(*) n FROM retail_leads WHERE deleted_at IS NULL AND lead_source IS NOT NULL GROUP BY lead_source ORDER BY n DESC LIMIT 8`),

    // Quotes
    pgAll(`SELECT status, COUNT(*) n, COALESCE(SUM(total_amount),0) v FROM crm_quotes WHERE deleted_at IS NULL AND created_at >= ? GROUP BY status`, [since]),
    pgGet(`SELECT COALESCE(SUM(total_amount),0) v, COUNT(*) n FROM crm_quotes WHERE deleted_at IS NULL AND status = 'Accepted' AND created_at >= ?`, [since]),

    // Revenue by sales person (invoices.sales_person is an email string)
    pgAll(
      `SELECT i.sales_person AS email, COALESCE(u.name, i.sales_person) AS name,
              COUNT(*) n, COALESCE(SUM(i.amount),0) total
         FROM invoices i LEFT JOIN users u ON u.email = i.sales_person
        WHERE i.sales_person IS NOT NULL AND i.created_at >= ?
        GROUP BY i.sales_person, u.name ORDER BY total DESC LIMIT 8`,
      [since]
    ),

    // Finance
    pgAll(`SELECT status, COUNT(*) n, COALESCE(SUM(amount),0) v FROM invoices GROUP BY status`),
    pgGet(`SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM invoices WHERE created_at >= ?`, [since]),
    pgGet(`SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM payments WHERE status = 'Completed' AND paid_at >= ?`, [since]),
    pgGet(`SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE status IN ('Unpaid','PartiallyPaid')`),
    pgGet(`SELECT COALESCE(SUM(amount),0) v, COUNT(*) n FROM invoices WHERE status IN ('Unpaid','PartiallyPaid') AND due_on < ?`, [today]),
    pgAll(
      `SELECT CASE
           WHEN due_on <= ? THEN '7d' WHEN due_on <= ? THEN '15d' WHEN due_on <= ? THEN '30d'
           WHEN due_on <= ? THEN '45d' WHEN due_on <= ? THEN '60d' ELSE '90d+' END AS bucket,
         COALESCE(SUM(amount),0) v
       FROM invoices WHERE status IN ('Unpaid','PartiallyPaid') AND due_on IS NOT NULL AND due_on <= ?
       GROUP BY bucket`,
      [
        new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
        new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10),
        new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10),
        new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
      ]
    ),
    pgGet(`SELECT COALESCE(SUM(fee_amount),0) v FROM referrer_payments WHERE (status IS NULL OR status <> 'Reversed') AND COALESCE(approval_status, 'NotRequired') IN ('NotRequired','Approved') AND payment_date >= ?`, [sinceDate]),
    pgGet(
      `SELECT COALESCE(SUM(fee_amount),0) v, COUNT(*) n FROM referrer_payments
        WHERE is_advance = TRUE AND reconciliation_status = 'Pending' AND (status IS NULL OR status <> 'Reversed')
          AND COALESCE(approval_status, 'NotRequired') IN ('NotRequired','Approved')`
    ),

    // Inventory
    pgAll(`SELECT status, COUNT(*) n FROM inv_items WHERE deleted_at IS NULL GROUP BY status`),
    pgAll(
      `SELECT i.status, COALESCE(SUM(COALESCE(c.purchase_price,0)),0) cost, COALESCE(SUM(COALESCE(c.sale_price,0)),0) sale
         FROM inv_items i LEFT JOIN inv_product_catalog c ON c.id = i.product_id
        WHERE i.deleted_at IS NULL AND i.status IN ('In Stock','Reserved','Issued for Installation')
        GROUP BY i.status`
    ),
    pgAll(
      `SELECT c.product_code, c.product_name, c.reorder_level,
              COALESCE(SUM(CASE WHEN i.status IN ('In Stock','Reserved','Issued for Installation') THEN 1 ELSE 0 END),0) in_stock
         FROM inv_product_catalog c LEFT JOIN inv_items i ON i.product_id = c.id AND i.deleted_at IS NULL
        WHERE c.deleted_at IS NULL AND COALESCE(c.active, 1) <> 0 AND ${PRODUCT_TRACKS_INVENTORY("c")}
        GROUP BY c.id, c.product_code, c.product_name, c.reorder_level
       HAVING COALESCE(SUM(CASE WHEN i.status IN ('In Stock','Reserved','Issued for Installation') THEN 1 ELSE 0 END),0) <= COALESCE(c.reorder_level,5)
        ORDER BY in_stock ASC LIMIT 10`
    ),
    pgAll(
      `SELECT c.product_name, c.product_code, COUNT(*) n
         FROM inv_movements m JOIN inv_items i ON i.id = m.item_id
         LEFT JOIN inv_product_catalog c ON c.id = i.product_id
        WHERE m.action = 'INSTALLED' AND m.created_at >= ?
        GROUP BY c.product_name, c.product_code ORDER BY n DESC LIMIT 8`,
      [since]
    ).catch(() => []),
    pgGet(`SELECT COUNT(*) n FROM device_retrievals WHERE current_status = 'In Custody'`).catch(() => ({ n: 0 })),

    // Technical / Installations
    pgAll(`SELECT status, COUNT(*) n FROM installation_tickets WHERE deleted_at IS NULL GROUP BY status`),
    pgGet(
      `SELECT COUNT(*) n,
              ROUND(AVG(EXTRACT(EPOCH FROM (technician_signed_off_at::timestamptz - created_at::timestamptz))/3600)::numeric,1) avg_hours
         FROM installation_tickets
        WHERE deleted_at IS NULL AND technician_signed_off_at IS NOT NULL AND technician_signed_off_at >= ?`,
      [since]
    ),
    // 3-gate SLA breach (ack/start/signoff) on still-open tickets — the 4th
    // (iso-close) gate is excluded: sla_iso_closed_by_at is only ever written
    // for status='Closed', which never occurs live, so it always false-flags.
    pgGet(
      `SELECT COUNT(*) n FROM installation_tickets
        WHERE deleted_at IS NULL AND status NOT IN ('Completed','Cancelled','Defaulted')
          AND (
            (sla_acknowledged_by_at IS NULL AND EXTRACT(EPOCH FROM (?::timestamptz - created_at::timestamptz))/3600 > COALESCE(sla_ack_hours,4))
            OR (assigned_at IS NOT NULL AND sla_started_by_at IS NULL AND EXTRACT(EPOCH FROM (?::timestamptz - assigned_at::timestamptz))/3600 > COALESCE(sla_start_hours,24))
            OR (sla_started_by_at IS NOT NULL AND sla_signed_off_by_at IS NULL AND EXTRACT(EPOCH FROM (?::timestamptz - sla_started_by_at::timestamptz))/3600 > COALESCE(sla_signoff_hours,48))
          )`,
      [nowIso, nowIso, nowIso]
    ),
    pgAll(
      `SELECT technician_signed_off_by_name AS technician, COUNT(*) n
         FROM installation_tickets
        WHERE deleted_at IS NULL AND status = 'Completed' AND technician_signed_off_by_name IS NOT NULL
          AND technician_signed_off_at >= ?
        GROUP BY technician_signed_off_by_name ORDER BY n DESC LIMIT 6`,
      [since]
    ),
    pgGet(
      `SELECT
         COUNT(*) FILTER (WHERE retail_lead_id IS NOT NULL) AS retail,
         COUNT(*) FILTER (WHERE retail_lead_id IS NULL) AS corporate
       FROM installation_tickets WHERE deleted_at IS NULL AND status = 'Completed' AND technician_signed_off_at >= ?`,
      [since]
    ),

    // Certificates (mirrors routes/certificates.ts dashboard dedup logic)
    pgGet(
      `SELECT
        (SELECT COUNT(*) FROM certificates WHERE end_date >= ? AND deleted_at IS NULL) AS active,
        (SELECT COUNT(*) FROM certificates WHERE end_date >= ? AND end_date <= ? AND deleted_at IS NULL) AS nearing_expiry,
        (SELECT COUNT(*) FROM certificates WHERE end_date < ? AND deleted_at IS NULL) AS expired,
        (SELECT COUNT(*) FROM certificates WHERE created_at >= ? AND deleted_at IS NULL) AS issued_in_period`,
      [today, today, in60, today, since]
    ),
    pgGet(
      `SELECT COUNT(*) n FROM vi_installations vi
         JOIN crm_customer_vehicles v ON v.id = vi.vehicle_id
        WHERE vi.completed_at IS NOT NULL AND vi.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM certificates c WHERE c.deleted_at IS NULL
              AND (   NULLIF(REPLACE(UPPER(TRIM(c.car_registration)),' ',''),'') = NULLIF(REPLACE(UPPER(TRIM(v.registration)),' ',''),'')
                   OR NULLIF(REPLACE(UPPER(TRIM(c.chassis_number)),' ',''),'')   = NULLIF(REPLACE(UPPER(TRIM(v.chassis_number)),' ',''),'') )
          )`
    ),

    // Support (crm_tickets) — same conventions as stats/support-dashboard
    pgGet(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'Open') AS open,
        COUNT(*) FILTER (WHERE status = 'In Progress') AS in_progress,
        COUNT(*) FILTER (WHERE status IN ('Resolved','Closed') AND resolved_at >= ?) AS resolved_in_period,
        COUNT(*) FILTER (WHERE status NOT IN ('Closed','Resolved') AND sla_breach_at < ?) AS sla_breached
       FROM crm_tickets`,
      [since, nowIso]
    ),
    pgAll(`SELECT COALESCE(team,'Unassigned') team, COUNT(*) n FROM crm_tickets WHERE status NOT IN ('Closed','Resolved') GROUP BY team ORDER BY n DESC`),
    pgAll(`SELECT COALESCE(category,'Other') category, COUNT(*) n FROM crm_tickets WHERE status NOT IN ('Closed','Resolved') GROUP BY category ORDER BY n DESC LIMIT 6`),

    // HR
    pgGet(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'Active') AS active,
        COUNT(*) FILTER (WHERE status = 'Probation') AS probation,
        COUNT(*) FILTER (WHERE employment_type = 'Contractor') AS contract,
        COUNT(*) FILTER (WHERE status = 'Terminated') AS terminated,
        COUNT(*) FILTER (WHERE start_date >= ?) AS new_hires,
        COUNT(*) AS total
       FROM hr_employees`,
      [sinceDate]
    ),
    pgAll(
      `SELECT o.name unit, o.type, COUNT(e.id) n
         FROM hr_org_units o LEFT JOIN hr_employees e ON e.org_unit_id = o.id AND e.status = 'Active'
        GROUP BY o.id, o.name, o.type HAVING COUNT(e.id) > 0 ORDER BY n DESC LIMIT 10`
    ),
    pgAll(
      `SELECT COALESCE(r.title,'Unassigned') role, COUNT(*) n
         FROM hr_employees e LEFT JOIN hr_job_roles r ON r.id = e.job_role_id
        WHERE e.status = 'Active' GROUP BY r.title ORDER BY n DESC LIMIT 8`
    ),
  ]);

  // ── Shape the response ──────────────────────────────────────────────────
  const num = (v: any) => Number(v || 0);
  const rowsToMap = (rows: any[], keyCol: string, valCol: string) => {
    const m: Record<string, number> = {};
    for (const r of rows) m[String(r[keyCol] ?? "Unknown")] = num(r[valCol]);
    return m;
  };

  const corpStatusMap = rowsToMap(corpLeadStatus, "status", "n");
  const invByStatus = rowsToMap(instStatusCounts, "status", "n");
  const invItemsByStatus = rowsToMap(invStockSummary, "status", "n");
  const invValueByStatus: Record<string, { cost: number; sale: number }> = {};
  for (const r of invValueRows as any[]) invValueByStatus[r.status] = { cost: num(r.cost), sale: num(r.sale) };
  const invTotalCost = Object.values(invValueByStatus).reduce((s, v) => s + v.cost, 0);
  const invTotalSale = Object.values(invValueByStatus).reduce((s, v) => s + v.sale, 0);
  const invEffectiveStock = ["In Stock", "Reserved", "Issued for Installation"].reduce((s, k) => s + (invItemsByStatus[k] || 0), 0);

  const invoiceStatusMap = rowsToMap(invSummary, "status", "n");
  const invoiceValueMap: Record<string, number> = {};
  for (const r of invSummary as any[]) invoiceValueMap[r.status] = num(r.v);

  const forecastBuckets = ["7d", "15d", "30d", "45d", "60d", "90d+"];
  const forecastMap = rowsToMap(forecastRows, "bucket", "v");

  auditLog(req, "EXEC_DASHBOARD_VIEWED", "exec-dashboard", "Info", { days }).catch(console.error);

  return res.status(200).json({
    data: {
      range: { days, since, today },
      sales: {
        corporate: {
          new: num(corpStatusMap["New"]), qualified: num(corpStatusMap["Qualified"]),
          converted: num(corpStatusMap["Converted"]), disqualified: num(corpStatusMap["Disqualified"]),
          newInPeriod: num(corpLeadNewInPeriod?.n),
          bySource: corpLeadSource.map((r: any) => ({ label: r.lead_source, count: num(r.n) })),
        },
        retail: {
          activeJobs: num(retailActive?.n),
          completedInPeriod: num(retailCompletedInPeriod?.n),
          bySource: retailSource.map((r: any) => ({ label: r.lead_source, count: num(r.n) })),
        },
        quotes: {
          inPeriod: quoteStatus.reduce((s: number, r: any) => s + num(r.n), 0),
          acceptedCount: num(quoteValueInPeriod?.n), acceptedValue: num(quoteValueInPeriod?.v),
          byStatus: quoteStatus.map((r: any) => ({ label: r.status, count: num(r.n), value: num(r.v) })),
        },
        revenueBySalesPerson: revenueBySales.map((r: any) => ({ name: r.name || r.email, email: r.email, count: num(r.n), total: num(r.total) })),
      },
      finance: {
        invoiceStatus: { unpaid: num(invoiceStatusMap["Unpaid"]), paid: num(invoiceStatusMap["Paid"]), partiallyPaid: num(invoiceStatusMap["PartiallyPaid"]), draft: num(invoiceStatusMap["Draft"]) },
        invoicedInPeriod: { count: num(invoicedInPeriod?.n), value: num(invoicedInPeriod?.v) },
        collectedInPeriod: { count: num(collectedInPeriod?.n), value: num(collectedInPeriod?.v) },
        outstanding: num(outstandingTotal?.v),
        overdue: { value: num(overdueTotal?.v), count: num(overdueTotal?.n) },
        forecast: forecastBuckets.map((b) => ({ bucket: b, value: num(forecastMap[b]) })),
        referrerCommissionPaidInPeriod: num(referrerCommissionPaid?.v),
        advancedCommissionExposure: { value: num(advanceExposure?.v), count: num(advanceExposure?.n) },
      },
      inventory: {
        itemsByStatus: invItemsByStatus,
        effectiveStock: invEffectiveStock,
        valueAtCost: invTotalCost,
        valueAtSale: invTotalSale,
        lowStock: lowStockRows.map((r: any) => ({ code: r.product_code, name: r.product_name, reorderLevel: num(r.reorder_level), inStock: num(r.in_stock) })),
        topMoving: topMovingProducts.map((r: any) => ({ code: r.product_code, name: r.product_name || "Unknown", count: num(r.n) })),
        deviceRetrievalBacklog: num((retrievalBacklog as any)?.n),
      },
      technical: {
        byStatus: { completed: num(invByStatus["Completed"]), inProgress: num(invByStatus["InProgress"]), assigned: num(invByStatus["Assigned"]), pending: num(invByStatus["Pending"]), defaulted: num(invByStatus["Defaulted"]), cancelled: num(invByStatus["Cancelled"]) },
        avgCompletionHoursInPeriod: instAvgHours?.avg_hours != null ? Number(instAvgHours.avg_hours) : null,
        completedCountInPeriod: num(instAvgHours?.n),
        slaBreachedOpen: num(instSlaBreachOpen?.n),
        technicianLeaderboard: techLeaderboard.map((r: any) => ({ name: r.technician, count: num(r.n) })),
        byFunnel: { retail: num((instByFunnel as any)?.retail), corporate: num((instByFunnel as any)?.corporate) },
      },
      certificates: {
        active: num(certStats?.active), nearingExpiry: num(certStats?.nearing_expiry), expired: num(certStats?.expired),
        issuedInPeriod: num(certStats?.issued_in_period),
        awaitingGeneration: num((certAwaitingGen as any)?.n),
      },
      support: {
        open: num(supportCards?.open), inProgress: num(supportCards?.in_progress),
        resolvedInPeriod: num(supportCards?.resolved_in_period), slaBreached: num(supportCards?.sla_breached),
        byTeam: supportByTeam.map((r: any) => ({ label: r.team, count: num(r.n) })),
        byCategory: supportByCategory.map((r: any) => ({ label: r.category, count: num(r.n) })),
      },
      hr: {
        total: num(hrTotals?.total), active: num(hrTotals?.active), probation: num(hrTotals?.probation),
        contract: num(hrTotals?.contract), terminated: num(hrTotals?.terminated), newHiresInPeriod: num(hrTotals?.new_hires),
        byUnit: hrByUnit.map((r: any) => ({ label: r.unit, type: r.type, count: num(r.n) })),
        byRole: hrByRole.map((r: any) => ({ label: r.role, count: num(r.n) })),
      },
    },
  });
});

export default router;
