/**
 * Admin Backup Routes — /api/admin/backup
 *
 * POST /run          — trigger an on-demand pg_dump → SharePoint upload
 * GET  /logs         — list backup log history
 * GET  /schedule     — get current cron schedule config
 * POST /schedule     — update cron schedule
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { pgAll, pgGet, pgRun } from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { exec } from "child_process";
import { promisify } from "util";
import { createGzip } from "zlib";
import cron, { ScheduledTask } from "node-cron";

const router = Router();
const execAsync = promisify(exec);

// ── Config ──────────────────────────────────────────────────────────────────
const TENANT_ID       = process.env.GRAPH_TENANT_ID    || "";
const CLIENT_ID       = process.env.GRAPH_CLIENT_ID    || "";
const CLIENT_SECRET   = process.env.GRAPH_CLIENT_SECRET || "";
const SP_SITE_ID      = "finemarktracking.sharepoint.com,9c64045e-077c-4e34-b860-d1e7d67927b4,3a43c493-89fb-45c8-a231-0bab2609f83f";
const SP_FOLDER_PROD  = "Database-Prod";
const SP_FOLDER_DEV   = "Database-Dev";
const SP_SITE_URL     = "https://finemarktracking.sharepoint.com/sites/secops";

// DB connection config for backups
const DB_DEV_HOST   = process.env.DB_DEV_HOST   || "db";
const DB_DEV_PORT   = process.env.DB_DEV_PORT   || "5432";
const DB_PROD_HOST  = process.env.DB_PROD_HOST  || "finemark-prod-db";
const DB_PROD_PORT  = process.env.DB_PROD_PORT  || "5432";
const DB_USER       = process.env.PG_USER       || "finemark";
const DB_NAME       = process.env.PG_DATABASE   || "finemark_backend";
const DB_PASSWORD   = process.env.PG_PASSWORD   || "finemark_secret";

// ── Scheduled job handle ─────────────────────────────────────────────────────
let scheduledTask: ScheduledTask | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getGraphToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         "https://graph.microsoft.com/.default",
  });

  const resp = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const data: any = await resp.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data.error_description || data.error)}`);
  return data.access_token as string;
}

async function getDriveId(token: string): Promise<string> {
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${SP_SITE_ID}/drive`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data: any = await resp.json();
  if (!data.id) throw new Error(`Drive access denied: ${JSON.stringify(data.error)}`);
  return data.id as string;
}

/** Stream a pg_dump (gzipped) directly into SharePoint via the Graph upload API */
async function dumpAndUpload(
  pgHost: string,
  pgPort: string,
  folder: string,
  filename: string,
  token: string,
  driveId: string
): Promise<string> {
  // 1. pg_dump directly over the network — no docker exec needed
  const { stdout } = await execAsync(
    `pg_dump -h ${pgHost} -p ${pgPort} -U ${DB_USER} -d ${DB_NAME}`,
    {
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, PGPASSWORD: DB_PASSWORD },
    }
  );

  // 2. Gzip in-process
  const raw = Buffer.from(stdout, "utf8");
  const gzipped = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gz = createGzip({ level: 6 });
    gz.on("data", (c: Buffer) => chunks.push(c));
    gz.on("end", () => resolve(Buffer.concat(chunks)));
    gz.on("error", reject);
    gz.end(raw);
  });

  // 3. Upload to SharePoint (simple upload — works up to 250MB)
  const uploadUrl =
    `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${folder}/${filename}:/content`;

  const upResp = await fetch(uploadUrl, {
    method:  "PUT",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(gzipped),
  });
  const upData: any = await upResp.json();
  if (!upData.id) throw new Error(`Upload failed: ${JSON.stringify(upData.error)}`);

  // Return a direct SharePoint web URL for the folder
  return `${SP_SITE_URL}/Shared%20Documents/${folder}`;
}

/** Core backup function — runs both prod and dev dumps, writes log rows */
export async function runBackup(triggeredBy: string = "system"): Promise<{
  prodLog: any;
  devLog: any;
}> {
  const date  = new Date().toISOString().slice(0, 10);
  const token = await getGraphToken();
  const driveId = await getDriveId(token);

  const results = await Promise.allSettled([
    dumpAndUpload(DB_PROD_HOST, DB_PROD_PORT, SP_FOLDER_PROD, `finemark_prod_${date}.sql.gz`, token, driveId),
    dumpAndUpload(DB_DEV_HOST,  DB_DEV_PORT,  SP_FOLDER_DEV,  `finemark_dev_${date}.sql.gz`,  token, driveId),
  ]);

  const now = new Date().toISOString();

  // Prod log
  const prodId = uuidv4();
  const prodOk = results[0].status === "fulfilled";
  const prodUrl = prodOk ? (results[0] as PromiseFulfilledResult<string>).value : null;
  const prodErr = prodOk ? null : (results[0] as PromiseRejectedResult).reason?.message ?? "Unknown error";
  await pgRun(
    `INSERT INTO db_backup_logs (id, env, status, filename, sharepoint_url, error_message, triggered_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [prodId, "prod", prodOk ? "success" : "failed",
     `finemark_prod_${date}.sql.gz`, prodUrl, prodErr, triggeredBy, now]
  );

  // Dev log
  const devId = uuidv4();
  const devOk = results[1].status === "fulfilled";
  const devUrl  = devOk ? (results[1] as PromiseFulfilledResult<string>).value : null;
  const devErr  = devOk ? null : (results[1] as PromiseRejectedResult).reason?.message ?? "Unknown error";
  await pgRun(
    `INSERT INTO db_backup_logs (id, env, status, filename, sharepoint_url, error_message, triggered_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [devId, "dev", devOk ? "success" : "failed",
     `finemark_dev_${date}.sql.gz`, devUrl, devErr, triggeredBy, now]
  );

  const prodLog = await pgGet("SELECT * FROM db_backup_logs WHERE id = ?", [prodId]);
  const devLog  = await pgGet("SELECT * FROM db_backup_logs WHERE id = ?", [devId]);
  return { prodLog, devLog };
}

/** (Re-)register the scheduled cron job based on saved config */
export async function applySchedule(): Promise<void> {
  const cfg = await pgGet<{ cron_expr: string; enabled: number }>(
    "SELECT cron_expr, enabled FROM db_backup_schedule WHERE id = 1"
  );
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (cfg?.enabled && cfg.cron_expr) {
    if (!cron.validate(cfg.cron_expr)) {
      console.warn(`[backup] Invalid cron expression in DB: "${cfg.cron_expr}", skipping schedule.`);
      return;
    }
    scheduledTask = cron.schedule(cfg.cron_expr, () => {
      console.log("[backup] Scheduled backup starting…");
      runBackup("scheduler").catch((e) =>
        console.error("[backup] Scheduled backup error:", e)
      );
    });
    console.log(`[backup] Scheduled backup registered: ${cfg.cron_expr}`);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** POST /api/admin/backup/run — on-demand backup */
router.post(
  "/run",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: any, res) => {
    const triggeredBy: string = req.user?.email ?? "admin";
    try {
      const { prodLog, devLog } = await runBackup(triggeredBy);
      const allOk = prodLog?.status === "success" && devLog?.status === "success";
      return res.status(allOk ? 200 : 207).json({
        ok:      allOk,
        message: allOk ? "Both databases backed up successfully." : "One or more backups failed.",
        results: { prod: prodLog, dev: devLog },
      });
    } catch (err: any) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }
);

/** GET /api/admin/backup/logs — list recent backup log entries */
router.get(
  "/logs",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (_req, res) => {
    const logs = await pgAll(
      `SELECT * FROM db_backup_logs ORDER BY created_at DESC LIMIT 100`
    );
    return res.json({ ok: true, logs });
  }
);

/** GET /api/admin/backup/schedule — get schedule config */
router.get(
  "/schedule",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (_req, res) => {
    const cfg = await pgGet("SELECT * FROM db_backup_schedule WHERE id = 1");
    return res.json({ ok: true, schedule: cfg ?? { enabled: 0, cron_expr: "0 2 * * *", label: "Daily at 2:00 AM" } });
  }
);

/** POST /api/admin/backup/schedule — save and apply schedule */
router.post(
  "/schedule",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: any, res) => {
    const { enabled, cron_expr, label } = req.body as {
      enabled: boolean;
      cron_expr: string;
      label?: string;
    };

    if (cron_expr && !cron.validate(cron_expr)) {
      return res.status(400).json({ ok: false, message: `Invalid cron expression: "${cron_expr}"` });
    }

    await pgRun(
      `INSERT INTO db_backup_schedule (id, enabled, cron_expr, label, updated_at, updated_by)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET enabled=EXCLUDED.enabled, cron_expr=EXCLUDED.cron_expr,
         label=EXCLUDED.label, updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by`,
      [enabled ? 1 : 0, cron_expr, label ?? "", new Date().toISOString(), req.user?.email ?? "admin"]
    );

    await applySchedule();
    const cfg = await pgGet("SELECT * FROM db_backup_schedule WHERE id = 1");
    return res.json({ ok: true, schedule: cfg });
  }
);

export default router;
