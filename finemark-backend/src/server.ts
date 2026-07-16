import "dotenv/config";
import "express-async-errors"; // makes unhandled async route errors flow to the error handler
import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { requireAuth } from "./middleware/auth.js";
import authRoutes from "./routes/auth.js";
import authAzureRoutes from "./routes/auth-azure.js";
import crmRoutes from "./routes/crm.js";
import installationsRoutes from "./routes/installations.js";
import usersRoutes from "./routes/users.js";
import auditLogsRoutes from "./routes/auditLogs.js";
import invoicesRoutes from "./routes/invoices.js";
import referrersRoutes, { initReferrersSchema } from "./routes/referrers.js";
import paymentsRoutes from "./routes/payments.js";
import creditNotesRoutes from "./routes/credit-notes.js";
import gpsUninstallQueueRoutes from "./routes/gps-uninstall-queue.js";
import bankAccountsRoutes from "./routes/bank-accounts.js";
import reportsRoutes from "./routes/reports.js";
import financeRoutes from "./routes/finance.js";
import meRoutes from "./routes/me.js";
import speedGovernorsRoutes from "./routes/speedGovernors.js";
import certificatesRoutes from "./routes/certificates.js";
import hrOrgRoutes from "./routes/hr-org.js";
import hrEmployeesRoutes from "./routes/hr-employees.js";
import hrPerformanceRoutes from "./routes/hr-performance.js";
import hrReportsRoutes from "./routes/hr-reports.js";
import hrLeaveRoutes from "./routes/hr-leave.js";
import hrSettingsRoutes from "./routes/hr-settings.js";
import hrM365Routes, { initM365Schema } from "./routes/hr-m365.js";
import crmCustomersRoutes from "./routes/crm-customers.js";
import crmTicketsRoutes from "./routes/crm-tickets.js";
import adminTicketCategoriesRoutes from "./routes/admin-ticket-categories.js";
import crmCommunicationsRoutes from "./routes/crm-communications.js";
import crmCampaignsRoutes from "./routes/crm-campaigns.js";
import webhooksRoutes from "./routes/webhooks.js";
import vehicleInstallationsRoutes from "./routes/vehicle-installations.js";
import crmLeadsRoutes from "./routes/crm-leads.js";
import crmQuotesRoutes from "./routes/crm-quotes.js";
import crmProformaRoutes from "./routes/crm-proforma.js";
import crmGadgetStockRoutes from "./routes/crm-gadget-stock.js";
import crmSurveysRoutes from "./routes/crm-surveys.js";
import inventoryCatalogRoutes from "./routes/inventory-catalog.js";
import inventoryItemsRoutes from "./routes/inventory-items.js";
import vehicleMasterRoutes from "./routes/vehicle-master.js";
import inventoryProcurementRoutes from "./routes/inventory-procurement.js";
import inventoryWarrantyRoutes from "./routes/inventory-warranty.js";
import inventorySimsRoutes from "./routes/inventory-sims.js";
import inventoryMassTopupRoutes from "./routes/inventory-mass-topup.js";
import installationTicketsRoutes from "./routes/installation-tickets.js";
import installationPositionsRoutes from "./routes/installation-positions.js";
import deviceCustodyRoutes from "./routes/device-custody.js";
import technicalTeamRoutes from "./routes/technical-team.js";
import partnersRoutes from "./routes/partners.js";
import partnerPortalRoutes from "./routes/partner-portal.js";
import partnerDashboardsRoutes from "./routes/partner-dashboards.js";
import partnerPricingRoutes from "./routes/partner-pricing.js";
import bankFinancedPricingRoutes from "./routes/bank-financed-pricing.js";
import notificationsRoutes from "./routes/notifications.js";
import cacheAdminRoutes from "./routes/cache-admin.js";
import roleConfigsRoutes, { initRoleConfigsSchema, backfillNewRoleCapabilities } from "./routes/role-configs.js";
import adminStatsRoutes from "./routes/admin-stats.js";
import adminBackupRoutes, { applySchedule } from "./routes/admin-backup.js";
import adminSessionSettingsRoutes from "./routes/admin-session-settings.js";
import retailLeadsRoutes from "./routes/retail-leads.js";
import purchaseOrdersRoutes from "./routes/purchase-orders.js";
import unifiedQuotesRoutes from "./routes/unified-quotes.js";
import invoicesAdvancedRoutes from "./routes/invoices-advanced.js";
import vehiclesRoutes from "./routes/vehicles.js";
import kbRoutes from "./routes/kb.js";
import archiveRoutes from "./routes/archive.js";
import salesIntelligenceRoutes from "./routes/sales-intelligence.js";
import { initReminderCron } from "./jobs/reminderCron.js";
import { initLeadWarningCron } from "./jobs/leadWarningCron.js";
import { initLeadFollowupReminderCron } from "./jobs/leadFollowupReminderCron.js";
import { initVehicleSyncCron } from "./jobs/vehicleSyncCron.js";
import { initGpsUninstallScanCron } from "./jobs/gpsUninstallScanCron.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { initSchema } from "./schema.js";
import { syncMailbox } from "./routes/crm-communications.js";
import { isGraphConfigured, logGraphPermissions } from "./services/graphMailService.js";
import cron from "node-cron";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5500")
  .split(",")
  .map((o) => o.trim());

// All traffic arrives via our own reverse proxies (Caddy -> nginx -> here), both
// of which set X-Forwarded-For/X-Real-IP correctly. Trusting them lets
// req.ip resolve to the real client IP instead of the frontend container's
// internal docker address — needed for accurate audit log IPs.
app.set("trust proxy", true);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow frontend (port 5500) to read API responses (port 3000)
}));
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, mobile, same-origin)
      if (!origin) return callback(null, true);
      if (CORS_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
// Partner logos are loaded by the customer portal (unauthenticated context) — must remain public
app.use("/uploads/partner-logos", express.static(path.join(process.cwd(), "uploads", "partner-logos")));
// All other uploads (lead attachments, installation photos, KB files) require authentication
app.use("/uploads", requireAuth, express.static(path.join(process.cwd(), "uploads")));
// Public assets (logos used in system emails) remain public
app.use("/public", express.static(path.join(process.cwd(), "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/auth/azure", authAzureRoutes);
app.use("/api/crm", crmRoutes);
app.use("/api/installations", installationsRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/audit-logs", auditLogsRoutes);
app.use("/api/invoices", invoicesRoutes);
app.use("/api/referrers", referrersRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/credit-notes", creditNotesRoutes);
app.use("/api/gps-uninstall-queue", gpsUninstallQueueRoutes);
app.use("/api/bank-accounts", bankAccountsRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/me", meRoutes);
app.use("/api/speed-governors", speedGovernorsRoutes);
app.use("/api/certificates", certificatesRoutes);
app.use("/api/hr/org", hrOrgRoutes);
app.use("/api/hr/employees", hrEmployeesRoutes);
app.use("/api/hr/performance", hrPerformanceRoutes);
app.use("/api/hr/reports", hrReportsRoutes);
app.use("/api/hr/leave", hrLeaveRoutes);
app.use("/api/hr/settings", hrSettingsRoutes);
app.use("/api/hr/m365", hrM365Routes);
app.use("/api/crm/customers", crmCustomersRoutes);
app.use("/api/crm/tickets", crmTicketsRoutes);
app.use("/api/admin/ticket-categories", adminTicketCategoriesRoutes);
app.use("/api/crm/communications", crmCommunicationsRoutes);
app.use("/api/crm/campaigns", crmCampaignsRoutes);
app.use("/api/vehicle-installations", vehicleInstallationsRoutes);
app.use("/api/crm/leads", crmLeadsRoutes);
app.use("/api/crm/quotes", crmQuotesRoutes);
app.use("/api/crm/proforma", crmProformaRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/cache", cacheAdminRoutes);
app.use("/api/admin/role-configs", roleConfigsRoutes);
app.use("/api/admin/stats", adminStatsRoutes);
app.use("/api/admin/backup", adminBackupRoutes);
app.use("/api/admin/session-settings", adminSessionSettingsRoutes);
app.use("/api/retail/leads", retailLeadsRoutes);
app.use("/api/crm/gadget-stock", crmGadgetStockRoutes);
app.use("/api/crm/surveys", crmSurveysRoutes);
app.use("/api/inventory/catalog", inventoryCatalogRoutes);
app.use("/api/inventory/items", inventoryItemsRoutes);
app.use("/api/vehicle-master", vehicleMasterRoutes);
app.use("/api/inventory/procurement", inventoryProcurementRoutes);
app.use("/api/inventory/warranty", inventoryWarrantyRoutes);
app.use("/api/inventory/sims", inventorySimsRoutes);
app.use("/api/inventory/mass-topup", inventoryMassTopupRoutes);
app.use("/api/installation-tickets", installationTicketsRoutes);
app.use("/api/installation-positions", installationPositionsRoutes);
app.use("/api/device-custody", deviceCustodyRoutes);
app.use("/api/technical-team", technicalTeamRoutes);
app.use("/api/partners", partnersRoutes);
app.use("/api/partner-portal", partnerPortalRoutes);
app.use("/api/partner-dashboards", partnerDashboardsRoutes);
app.use("/api/partner-pricing", partnerPricingRoutes);
app.use("/api/bank-financed-pricing", bankFinancedPricingRoutes);
app.use("/api/purchase-orders", purchaseOrdersRoutes);
app.use("/api/quotes", unifiedQuotesRoutes);
app.use("/api/invoices-advanced", invoicesAdvancedRoutes);
app.use("/api/vehicles", vehiclesRoutes);
app.use("/api/kb", kbRoutes);
app.use("/api/archive", archiveRoutes);
app.use("/api/sales-intelligence", salesIntelligenceRoutes);
// Inbound webhooks — no auth middleware (verified by signature / IP allowlist)
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded bodies
app.use("/api/webhooks", webhooksRoutes);

app.use(errorHandler);

(async () => {
  await initSchema();
  await initM365Schema();
  await initRoleConfigsSchema();
  await backfillNewRoleCapabilities();
  await initReferrersSchema();
  app.listen(PORT, () => {
    console.log(`Finemark backend running on http://localhost:${PORT}`);
  });

  // ── Database backup schedule ──────────────────────────────────────────────────
  applySchedule().catch((e) => console.error("[backup] Schedule init error:", e));

  // ── Email sync cron job ───────────────────────────────────────────────────────
  // Runs every N minutes (default 5). Polls all three O365 mailboxes for new emails.
  if (isGraphConfigured()) {
    // Log current Azure AD app roles so misconfigurations are caught immediately
    logGraphPermissions().catch(() => {});
    const intervalMs = parseInt(process.env.GRAPH_SYNC_INTERVAL_MS || "300000", 10);
    const minutes = Math.max(1, Math.round(intervalMs / 60000));
    const cronExpr = `*/${minutes} * * * *`;
    console.log(`[emailSync] Scheduled email sync every ${minutes} min (${cronExpr})`);
    cron.schedule(cronExpr, () => {
      syncMailbox().catch((err) => console.error("[emailSync] Error:", err));
    });
    // Run once on startup
    syncMailbox().catch((err) => console.error("[emailSync] Startup sync error:", err));
  } else {
    console.log("[emailSync] Microsoft Graph not configured — email sync disabled. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET in .env");
  }

  // ── Invoice reminder cron job ────────────────────────────────────────────────
  initReminderCron();

  // ── Corporate lead warning cron job ─────────────────────────────────────────
  initLeadWarningCron();

  // ── Corporate lead follow-up reminder cron job ──────────────────────────────
  initLeadFollowupReminderCron();

  // ── Vehicle master data sync cron job ───────────────────────────────────────
  initVehicleSyncCron();

  // ── GPS uninstallation loan-term-end scan cron job ──────────────────────────
  initGpsUninstallScanCron();
})();
