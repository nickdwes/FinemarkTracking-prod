/**
 * HR Microsoft 365 / Entra ID provisioning routes
 *
 * Mounts under /api/hr/m365
 *
 *  GET  /configured             — check if Graph credentials are set (no sensitive data, uses auth only)
 *  GET  /suggest-email          — suggest corporate emails for an employee
 *  GET  /status/:employeeId     — get m365 account record + live Entra status
 *  POST /provision              — create Entra ID account, assign license, add groups
 *  POST /sync/:employeeId       — pull latest data from Graph and update local record
 */

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { auditLog } from "../services/auditService.js";
import { errorResponse } from "../utils/responses.js";
import {
  isGraphConfigured,
  buildEmailCandidates,
  checkEmailAvailability,
  getEntraUser,
  createEntraUser,
  syncEntraUser,
  getUserLicenses,
} from "../services/graphUserService.js";

const router = Router();

// ── DB bootstrap ─────────────────────────────────────────────────────────────
export async function initM365Schema(): Promise<void> {
  await pgRun(`
    CREATE TABLE IF NOT EXISTS hr_m365_accounts (
      id                  TEXT PRIMARY KEY,
      employee_id         TEXT NOT NULL UNIQUE,
      upn                 TEXT,
      entra_object_id     TEXT,
      account_status      TEXT NOT NULL DEFAULT 'Not Provisioned',
      license_status      TEXT NOT NULL DEFAULT 'None',
      license_sku         TEXT,
      provisioned_by      TEXT,
      provisioned_at      TEXT,
      graph_transaction_id TEXT,
      last_synced_at      TEXT,
      notes               TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    )
  `);
}

// ── Helper: map DB row → camelCase ────────────────────────────────────────────
const mapAccount = (row: any) => ({
  id: row.id,
  employeeId: row.employee_id,
  upn: row.upn,
  entraObjectId: row.entra_object_id,
  accountStatus: row.account_status,
  licenseStatus: row.license_status,
  licenseSku: row.license_sku,
  provisionedBy: row.provisioned_by,
  provisionedAt: row.provisioned_at,
  graphTransactionId: row.graph_transaction_id,
  lastSyncedAt: row.last_synced_at,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /configured — returns whether Graph credentials are set up. */
router.get("/configured", requireAuth, (_req, res) => {
  res.json({ configured: isGraphConfigured() });
});

/**
 * GET /suggest-email?employeeId=xxx
 * Generates corporate email candidates and checks availability in Entra ID.
 */
router.get("/suggest-email", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const { employeeId } = req.query as { employeeId?: string };
  if (!employeeId) return errorResponse(res, 400, "VALIDATION_ERROR", "employeeId is required");

  const emp = await pgGet("SELECT full_name, email FROM hr_employees WHERE id = ?", [employeeId]);
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found");

  const candidates = buildEmailCandidates(emp.full_name);

  if (!isGraphConfigured()) {
    // Return candidates without availability check
    return res.json({
      fullName: emp.full_name,
      candidates: candidates.map(email => ({ email, available: null })),
      graphConfigured: false,
    });
  }

  const withAvailability = await checkEmailAvailability(candidates);
  res.json({
    fullName: emp.full_name,
    candidates: withAvailability,
    graphConfigured: true,
  });
});

/**
 * GET /status/:employeeId
 * Returns the local m365 account record. If the account is provisioned and
 * Graph is configured, also fetches live data from Entra ID.
 */
router.get("/status/:employeeId", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  const { employeeId } = req.params;

  const row = await pgGet("SELECT * FROM hr_m365_accounts WHERE employee_id = ?", [employeeId]);
  const account = row ? mapAccount(row) : null;

  let liveData: any = null;
  if (account?.entraObjectId && isGraphConfigured()) {
    try {
      liveData = await getEntraUser(account.upn);
    } catch (_e) { /* ignore — may not have permission yet */ }
  }

  res.json({
    account,
    live: liveData,
    graphConfigured: isGraphConfigured(),
  });
});

/**
 * POST /provision
 * Body: { employeeId, upn, sendWelcomeEmail? }
 * Creates the Entra ID user, assigns license + groups, stores record.
 */
router.post("/provision", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  if (!isGraphConfigured()) {
    return errorResponse(res, 503, "NOT_CONFIGURED", "Microsoft Graph is not configured on the server.");
  }

  const { employeeId, upn } = req.body as { employeeId?: string; upn?: string };
  if (!employeeId || !upn) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "employeeId and upn are required");
  }

  // Check employee exists
  const emp = await pgGet(
    `SELECT e.*, jr.title AS job_role_title, ou.name AS org_unit_name
     FROM hr_employees e
     LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
     LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
     WHERE e.id = ?`,
    [employeeId]
  );
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found");

  // Prevent duplicate provisioning
  const existing = await pgGet("SELECT id, entra_object_id FROM hr_m365_accounts WHERE employee_id = ?", [employeeId]);
  if (existing?.entra_object_id) {
    return errorResponse(res, 409, "CONFLICT", "This employee already has a provisioned Microsoft 365 account.");
  }

  // Check UPN is free
  try {
    const taken = await getEntraUser(upn);
    if (taken) {
      return errorResponse(res, 409, "CONFLICT", `The email address '${upn}' is already in use in Microsoft Entra ID.`);
    }
  } catch (checkErr: any) {
    // Non-fatal pre-check — creation will fail with a clear error if truly taken
    console.warn("[m365] UPN availability pre-check failed:", checkErr?.message);
  }

  // Split name
  const nameParts = emp.full_name.trim().split(/\s+/);
  const givenName = nameParts[0] || emp.full_name;
  const surname = nameParts.slice(1).join(" ") || "";

  // Create user in Entra ID
  let result: Awaited<ReturnType<typeof createEntraUser>>;
  try {
    result = await createEntraUser({
      upn,
      displayName: emp.full_name,
      givenName,
      surname,
      department: emp.org_unit_name || undefined,
      jobTitle: emp.job_role_title || undefined,
      employeeId: emp.employee_no || undefined,
      mobilePhone: emp.phone || undefined,
    });
  } catch (graphErr: any) {
    console.error("[m365] createEntraUser failed:", graphErr?.message);
    let friendly = "Failed to create Microsoft 365 account.";
    try {
      const raw: string = graphErr?.message || "";
      const jsonStart = raw.indexOf("{");
      if (jsonStart !== -1) {
        const parsed = JSON.parse(raw.slice(jsonStart));
        friendly = parsed?.error?.message || parsed?.message || friendly;
      }
    } catch { /* use default */ }
    return errorResponse(res, 502, "GRAPH_ERROR", friendly);
  }

  // Persist to hr_m365_accounts
  const now = new Date().toISOString();
  const skuId = process.env.M365_LICENSE_SKU_ID || null;
  const licenseStatus = skuId ? "Assigned" : "None";
  const recordId = uuidv4();

  if (existing) {
    // Update existing placeholder row
    await pgRun(
      `UPDATE hr_m365_accounts SET
          upn = ?, entra_object_id = ?, account_status = 'Provisioned',
          license_status = ?, license_sku = ?, provisioned_by = ?,
          provisioned_at = ?, graph_transaction_id = ?, last_synced_at = ?, updated_at = ?
       WHERE employee_id = ?`,
      [upn, result.objectId, licenseStatus, skuId, req.user?.id || "system",
       now, result.graphTransactionId, now, now, employeeId]
    );
  } else {
    await pgRun(
      `INSERT INTO hr_m365_accounts
         (id, employee_id, upn, entra_object_id, account_status, license_status, license_sku,
          provisioned_by, provisioned_at, graph_transaction_id, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Provisioned', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [recordId, employeeId, upn, result.objectId, licenseStatus, skuId,
       req.user?.id || "system", now, result.graphTransactionId, now, now, now]
    );
  }

  auditLog(req, "M365_USER_PROVISIONED", `hr_m365:${employeeId}`, "Info", {
    upn,
    entraObjectId: result.objectId,
    licenseSku: skuId,
  }).catch(console.error);

  res.status(201).json({
    success: true,
    upn: result.upn,
    entraObjectId: result.objectId,
    tempPassword: result.tempPassword,
    licenseStatus,
    message: "Microsoft 365 account created successfully. The temporary password is shown once — please share it securely.",
  });
});

/**
 * POST /sync/:employeeId
 * Pulls the latest employee HR data and pushes it to Entra ID. Also fetches
 * live license data from Graph and updates the local record.
 */
router.post("/sync/:employeeId", requireAuth, requireRole(ROLE_GROUPS.ADMIN_ONLY), async (req: AuthRequest, res) => {
  if (!isGraphConfigured()) {
    return errorResponse(res, 503, "NOT_CONFIGURED", "Microsoft Graph is not configured on the server.");
  }

  const { employeeId } = req.params;
  const account = await pgGet("SELECT * FROM hr_m365_accounts WHERE employee_id = ?", [employeeId]);
  if (!account?.entra_object_id) {
    return errorResponse(res, 404, "NOT_FOUND", "No provisioned Microsoft 365 account found for this employee.");
  }

  const emp = await pgGet(
    `SELECT e.*, jr.title AS job_role_title, ou.name AS org_unit_name
     FROM hr_employees e
     LEFT JOIN hr_job_roles jr ON jr.id = e.job_role_id
     LEFT JOIN hr_org_units ou ON ou.id = e.org_unit_id
     WHERE e.id = ?`,
    [employeeId]
  );
  if (!emp) return errorResponse(res, 404, "NOT_FOUND", "Employee not found");

  // Push HR updates to Entra ID
  try {
    await syncEntraUser(account.entra_object_id, {
      displayName: emp.full_name,
      department: emp.org_unit_name || undefined,
      jobTitle: emp.job_role_title || undefined,
      mobilePhone: emp.phone || undefined,
      employeeId: emp.employee_no || undefined,
    });
  } catch (syncErr: any) {
    console.error("[m365] syncEntraUser failed:", syncErr?.message);
    let friendly = "Failed to sync with Microsoft 365.";
    try {
      const raw: string = syncErr?.message || "";
      const jsonStart = raw.indexOf("{");
      if (jsonStart !== -1) {
        const parsed = JSON.parse(raw.slice(jsonStart));
        friendly = parsed?.error?.message || parsed?.message || friendly;
      }
    } catch { /* use default */ }
    return errorResponse(res, 502, "GRAPH_ERROR", friendly);
  }

  // Pull live license info
  let licenseStatus = account.license_status;
  try {
    const skus = await getUserLicenses(account.entra_object_id);
    licenseStatus = skus.length ? "Assigned" : "None";
  } catch (_e) { /* ignore */ }

  const now = new Date().toISOString();
  await pgRun(
    "UPDATE hr_m365_accounts SET license_status = ?, last_synced_at = ?, updated_at = ? WHERE employee_id = ?",
    [licenseStatus, now, now, employeeId]
  );

  auditLog(req, "M365_USER_SYNCED", `hr_m365:${employeeId}`, "Info", {
    upn: account.upn,
    entraObjectId: account.entra_object_id,
  }).catch(console.error);

  const updated = await pgGet("SELECT * FROM hr_m365_accounts WHERE employee_id = ?", [employeeId]);
  res.json({ success: true, account: mapAccount(updated!) });
});

export default router;
