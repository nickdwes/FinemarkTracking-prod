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
import { spawn } from "child_process";
import { createGzip } from "zlib";
import cron, { ScheduledTask } from "node-cron";

const router = Router();

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
let backupRunning = false;

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

const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024; // 10MiB — must be a multiple of 320KiB per Graph API

/**
 * Upload a file to SharePoint via a Graph upload session, chunked.
 * The simple `PUT .../content` endpoint is only reliable up to ~250MB and
 * starts failing with opaque "IO error during request payload read" errors
 * as dumps grow — an upload session has no such ceiling.
 */
async function uploadToSharePoint(
  driveId: string,
  folder: string,
  filename: string,
  token: string,
  data: Buffer
): Promise<void> {
  const sessionResp = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${folder}/${filename}:/createUploadSession`,
    {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    }
  );
  const session: any = await sessionResp.json();
  if (!session.uploadUrl) throw new Error(`Failed to create upload session: ${JSON.stringify(session.error)}`);

  const total = data.length;
  let finalItem: any = null;

  for (let start = 0; start < total; start += UPLOAD_CHUNK_SIZE) {
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, total);
    const chunk = data.subarray(start, end);

    // No Authorization header here — the upload session URL is pre-authenticated per Graph docs.
    const resp = await fetch(session.uploadUrl, {
      method:  "PUT",
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range":  `bytes ${start}-${end - 1}/${total}`,
      },
      body: new Uint8Array(chunk),
    });

    if (resp.status === 202) continue; // more chunks expected
    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Chunk upload failed [${start}-${end - 1}]: ${resp.status} ${errBody}`);
    }
    finalItem = await resp.json(); // 200/201 on the chunk that completes the file
  }

  if (!finalItem?.id) throw new Error("Upload session completed but no file item was returned");
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
  // 1. pg_dump directly over the network, streamed through gzip as it's produced —
  //    avoids buffering the whole (unbounded) dump in memory, unlike exec()'s maxBuffer.
  const gzipped = await new Promise<Buffer>((resolve, reject) => {
    const dump = spawn(
      "pg_dump",
      ["-h", pgHost, "-p", pgPort, "-U", DB_USER, "-d", DB_NAME],
      { env: { ...process.env, PGPASSWORD: DB_PASSWORD } }
    );

    let stderr = "";
    let settled = false;
    let gzDone: Buffer | null = null;
    let exitCode: number | null = null;

    const fail = (err: Error) => { if (!settled) { settled = true; reject(err); } };
    const finish = () => {
      if (settled || exitCode === null || gzDone === null) return;
      settled = true;
      if (exitCode !== 0) reject(new Error(`pg_dump exited with code ${exitCode}: ${stderr.trim()}`));
      else resolve(gzDone);
    };

    dump.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    dump.on("error", fail);

    const gz = createGzip({ level: 6 });
    const chunks: Buffer[] = [];
    gz.on("data", (c: Buffer) => chunks.push(c));
    gz.on("error", fail);
    gz.on("end", () => { gzDone = Buffer.concat(chunks); finish(); });

    dump.stdout.pipe(gz);

    dump.on("close", (code) => { exitCode = code; finish(); });
  });

  // 3. Upload to SharePoint via a chunked upload session (handles files of any size)
  await uploadToSharePoint(driveId, folder, filename, token, gzipped);

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
  const now = new Date().toISOString();
  // The dev database was decommissioned — exclude it unless explicitly re-enabled.
  const includeDev = process.env.BACKUP_INCLUDE_DEV === "true";

  // ── Prod ──────────────────────────────────────────────────────────────────
  const prodId = uuidv4();
  let prodOk = false;
  let prodUrl: string | null = null;
  let prodErr: string | null = null;
  try {
    prodUrl = await dumpAndUpload(DB_PROD_HOST, DB_PROD_PORT, SP_FOLDER_PROD, `finemark_prod_${date}.sql.gz`, token, driveId);
    prodOk = true;
  } catch (e: any) {
    prodErr = e?.message ?? "Unknown error";
  }
  await pgRun(
    `INSERT INTO db_backup_logs (id, env, status, filename, sharepoint_url, error_message, triggered_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [prodId, "prod", prodOk ? "success" : "failed",
     `finemark_prod_${date}.sql.gz`, prodUrl, prodErr, triggeredBy, now]
  );

  // ── Dev (skipped unless BACKUP_INCLUDE_DEV=true) ────────────────────────────
  const devId = uuidv4();
  if (includeDev) {
    let devOk = false;
    let devUrl: string | null = null;
    let devErr: string | null = null;
    try {
      devUrl = await dumpAndUpload(DB_DEV_HOST, DB_DEV_PORT, SP_FOLDER_DEV, `finemark_dev_${date}.sql.gz`, token, driveId);
      devOk = true;
    } catch (e: any) {
      devErr = e?.message ?? "Unknown error";
    }
    await pgRun(
      `INSERT INTO db_backup_logs (id, env, status, filename, sharepoint_url, error_message, triggered_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [devId, "dev", devOk ? "success" : "failed",
       `finemark_dev_${date}.sql.gz`, devUrl, devErr, triggeredBy, now]
    );
  } else {
    await pgRun(
      `INSERT INTO db_backup_logs (id, env, status, filename, sharepoint_url, error_message, triggered_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [devId, "dev", "skipped", null, null, "Dev database decommissioned — excluded from backups.", triggeredBy, now]
    );
  }

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
    if (backupRunning) {
      return res.status(409).json({ ok: false, running: true, message: "A backup is already running." });
    }
    backupRunning = true;
    // Run in the background and respond immediately — a full multi-GB dump + SharePoint
    // upload far exceeds the reverse-proxy's response window, so holding the request open
    // returned a 504 HTML page (the "Unexpected token '<'" error). The page polls
    // GET /status + GET /logs for the outcome instead.
    runBackup(triggeredBy)
      .catch((e) => console.error("[backup] on-demand backup error:", e))
      .finally(() => { backupRunning = false; });
    return res.status(202).json({ ok: true, started: true, message: "Backup started — running in the background. Refresh the history in a minute or two." });
  }
);

/** GET /api/admin/backup/status — is a backup currently running? */
router.get(
  "/status",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (_req, res) => {
    return res.json({ ok: true, running: backupRunning });
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
