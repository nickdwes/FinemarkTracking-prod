import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS, resolveTechnicianIdSet } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { encryptField } from "../services/cryptoService.js";
import { nextDatedBatchNumber } from "../utils/batchNumber.js";
import multer from "multer";

const router = Router();

// ── Schema ────────────────────────────────────────────────────────────────────
const VALID_STATUSES = ["available", "issued", "installed", "suspended", "retired"] as const;
type SimStatus = typeof VALID_STATUSES[number];

// Legal transitions: from → allowed next statuses
// "installed" is terminal from the technician's-custody point of view — once a
// SIM has actually gone into a vehicle it's consumed, not returned to "available".
const STATUS_TRANSITIONS: Record<SimStatus, SimStatus[]> = {
  available:  ["issued",     "suspended", "retired"],
  issued:     ["available",  "installed", "suspended", "retired"],
  installed:  ["retired"],
  suspended:  ["available",  "retired"],
  retired:    [],
};

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_sims (
    id           TEXT PRIMARY KEY,
    iccid        TEXT NOT NULL UNIQUE,
    imsi         TEXT NOT NULL UNIQUE,
    msisdn       TEXT,
    operator     TEXT,
    plan         TEXT,
    status       TEXT NOT NULL DEFAULT 'available',
    pin_enc      TEXT,
    puk_enc      TEXT,
    activation_date TEXT,
    expiry_date  TEXT,
    notes        TEXT,
    created_by   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    deleted_at   TEXT
  )
`, []).catch(e => console.error("[inv_sims] init:", e));

pgRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_sims_iccid ON inv_sims(iccid)`, []).catch(() => {});
pgRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_sims_imsi  ON inv_sims(imsi)`,  []).catch(() => {});
pgRun(`CREATE INDEX        IF NOT EXISTS idx_inv_sims_status ON inv_sims(status)`, []).catch(() => {});

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_sim_ledger (
    id          TEXT PRIMARY KEY,
    sim_id      TEXT NOT NULL,
    action      TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    actor_id    TEXT,
    actor_email TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL
  )
`, []).catch(e => console.error("[inv_sim_ledger] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_sim_ledger_sim ON inv_sim_ledger(sim_id)`, []).catch(() => {});

// Add issuance columns if they don't exist (idempotent migrations)
pgRun(`ALTER TABLE inv_sims ADD COLUMN IF NOT EXISTS issued_to_id     TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE inv_sims ADD COLUMN IF NOT EXISTS issued_to_name   TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE inv_sims ADD COLUMN IF NOT EXISTS issued_at        TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE inv_sims ADD COLUMN IF NOT EXISTS batch_ref        TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE inv_sims ADD COLUMN IF NOT EXISTS acknowledged_at  TEXT`, []).catch(() => {});
// Consumed-on-installation tracking — mirrors inv_items.installation_id so a
// SIM that's gone into a vehicle drops out of the technician's custody count.
pgRun(`ALTER TABLE inv_sims ADD COLUMN IF NOT EXISTS installation_id  TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE inv_sims ADD COLUMN IF NOT EXISTS installed_at     TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE inv_sims ADD COLUMN IF NOT EXISTS device_item_id   TEXT`, []).catch(() => {});
// SIM category — "Global" (standard roaming SIM) vs "IoT" (M2M/data-only SIM).
pgRun(`ALTER TABLE inv_sims ADD COLUMN IF NOT EXISTS sim_type         TEXT`, []).catch(() => {});
// Bulk receiving scans ICCIDs off physical SIM packs; the IMSI often isn't on
// the barcode, so it can't stay a hard requirement once SIMs arrive this way.
pgRun(`ALTER TABLE inv_sims ALTER COLUMN imsi DROP NOT NULL`, []).catch(() => {});
// Backfill batch_ref for existing rows (date of receipt)
pgRun(`UPDATE inv_sims SET batch_ref = 'SIM-BATCH-' || REPLACE(DATE(created_at), '-', '') WHERE batch_ref IS NULL AND created_at IS NOT NULL`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_sims_batch     ON inv_sims(batch_ref)`,      []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_sims_expiry    ON inv_sims(expiry_date)`,    []).catch(() => {});

// ── Helpers ───────────────────────────────────────────────────────────────────
function validateIccid(v: string): boolean {
  const s = v.replace(/\D/g, "");
  return s.length >= 19 && s.length <= 20;
}
function validateImsi(v: string): boolean {
  const s = v.replace(/\D/g, "");
  return s.length === 15;
}
// Kenyan mobile format: optional +, then 254 or a leading 0, then 7 or 1, then 8 more digits
// e.g. 0712345678, 0112345678, 254712345678, +254712345678
// — OR — Safaricom IoT/M2M SIM MSISDN: a 030000-prefixed number from a
// separate (non-dialable) numbering range Safaricom issues for IoT SIMs.
// These are NOT standard Kenyan mobile numbers and their length varies —
// real data seen is 13 digits (030000 + 7, e.g. 0300002389378), and an
// earlier assumption of exactly 12 digits (030000 + 6) wrongly rejected
// them. Accept 030000 followed by 5–9 more digits (11–15 total, within the
// E.164 max) so the whole IoT range imports.
function validateMsisdn(v: string): boolean {
  return /^((\+?254|0)[71]\d{8}|030000\d{5,9})$/.test(v.trim());
}
function sanitize(v: string): string {
  return v.replace(/[^\d]/g, "");
}

async function writeLedger(
  simId: string, action: string,
  fromStatus: string | null, toStatus: string | null,
  actorId: string, actorEmail: string,
  notes?: string
) {
  await pgRun(
    `INSERT INTO inv_sim_ledger (id,sim_id,action,from_status,to_status,actor_id,actor_email,notes,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [uuidv4(), simId, action, fromStatus || null, toStatus || null,
     actorId, actorEmail, notes || null, new Date().toISOString()]
  );
}

function maskSim(row: any): any {
  const { pin_enc, puk_enc, ...rest } = row;
  return {
    ...rest,
    has_pin: !!pin_enc,
    has_puk: !!puk_enc,
  };
}

// ── CSV upload (memory) ───────────────────────────────────────────────────────
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── GET /stats ─────────────────────────────────────────────────────────────────
router.get("/stats", requireAuth, async (_req, res) => {
  const rows = await pgAll(
    `SELECT status, COUNT(*) AS cnt FROM inv_sims WHERE deleted_at IS NULL GROUP BY status`, []
  );
  const stats: Record<string, number> = { available: 0, issued: 0, suspended: 0, retired: 0 };
  for (const r of rows) stats[r.status] = Number(r.cnt);
  // Split issued into transferred (no ack) vs acknowledged
  const ackRow = await pgGet(
    `SELECT
       COUNT(CASE WHEN acknowledged_at IS NULL THEN 1 END) AS transferred,
       COUNT(CASE WHEN acknowledged_at IS NOT NULL THEN 1 END) AS acknowledged
     FROM inv_sims WHERE status='issued' AND deleted_at IS NULL`, []
  );
  stats.transferred = Number((ackRow as any)?.transferred || 0);
  stats.acknowledged = Number((ackRow as any)?.acknowledged || 0);
  stats.total = Object.values(stats).reduce((a, b) => a + b, 0) - stats.transferred - stats.acknowledged;
  // (Total above re-summed without double-counting the breakdown)
  return ok(res, { data: stats });
});

// ── GET /movement-trend — daily inv_sim_ledger volume, day-range selectable ──
// SIM equivalent of GET /inventory/items/dashboard-detail's movementTrend.
// Excludes registered/received/available — bookkeeping at intake, not real
// SIM movement (mirrors the device version's RECEIVED/CREATED exclusion).
router.get("/movement-trend", requireAuth, async (req, res) => {
  const daysRaw = parseInt((req.query.days as string) || "30", 10);
  const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const trend = await pgAll(
    `SELECT SUBSTRING(created_at,1,10) AS day, COUNT(*) AS cnt
     FROM inv_sim_ledger
     WHERE created_at >= ?
       AND action NOT IN ('registered','received','available')
     GROUP BY day
     ORDER BY day`,
    [since]
  );
  return ok(res, { data: trend, meta: { days } });
});

// ── GET /operators — distinct operator values for filter dropdown ──────────────
router.get("/operators", requireAuth, async (_req, res) => {
  const rows = await pgAll(
    `SELECT DISTINCT operator FROM inv_sims WHERE operator IS NOT NULL AND deleted_at IS NULL ORDER BY operator`,
    []
  );
  return ok(res, { data: rows.map((r: any) => r.operator) });
});

// ── GET / — list SIMs ─────────────────────────────────────────────────────────
router.get("/batches", requireAuth, async (_req, res) => {
  const rows = await pgAll(
    `SELECT batch_ref, MIN(created_at) AS received_at, COUNT(*) AS sim_count
     FROM inv_sims
     WHERE batch_ref IS NOT NULL AND deleted_at IS NULL
     GROUP BY batch_ref
     ORDER BY received_at DESC`,
    []
  );
  return ok(res, { data: rows });
});

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const { status, operator, q, expiry_from, expiry_to, batch_ref, technicianId,
          page = "1", pageSize = "50" } = req.query as any;
  const limit  = Math.min(Number(pageSize) || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const conditions: string[] = ["s.deleted_at IS NULL"];
  const params: any[] = [];

  if (status)      { conditions.push("s.status = ?");               params.push(status); }
  if (operator)    { conditions.push("LOWER(s.operator) = LOWER(?)"); params.push(operator); }
  if (batch_ref)   { conditions.push("s.batch_ref = ?");             params.push(batch_ref); }
  if (expiry_from) { conditions.push("s.expiry_date >= ?");          params.push(expiry_from); }
  if (expiry_to)   { conditions.push("s.expiry_date <= ?");          params.push(expiry_to); }
  if (q) {
    conditions.push("(s.iccid LIKE ? OR s.imsi LIKE ? OR s.msisdn LIKE ? OR s.operator LIKE ? OR s.batch_ref LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  // Optional: scope to a specific technician's issued SIMs (roster-resolved, same
  // pattern as device-custody.ts's /available-for-job) — used by ISO Assisted
  // Installation to pair the ASSIGNED TECHNICIAN's SIMs, not the caller's own.
  // Omitted entirely preserves today's unfiltered behavior (SIM management page).
  if (technicianId) {
    const ids = [...(await resolveTechnicianIdSet(technicianId))];
    conditions.push(`s.issued_to_id IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }

  const where = conditions.join(" AND ");
  const total = (await pgGet(`SELECT COUNT(*) AS cnt FROM inv_sims s WHERE ${where}`, params))?.cnt ?? 0;
  const rows  = await pgAll(
    `SELECT s.id,s.iccid,s.imsi,s.msisdn,s.operator,s.plan,s.sim_type,s.status,s.batch_ref,s.activation_date,s.expiry_date,s.notes,
            s.issued_to_id,s.issued_to_name,s.issued_at,s.acknowledged_at,
            s.installation_id,s.installed_at,s.device_item_id,s.created_at,s.updated_at,
            t.customer_name AS job_customer_name, t.vehicle_registration AS job_vehicle_reg,
            t.assigned_to_email AS technician_email, t.iso_name, t.iso_email,
            dp.device_model
     FROM inv_sims s
     LEFT JOIN LATERAL (
       SELECT * FROM installation_tickets t2
       WHERE t2.id = s.installation_id OR t2.assigned_device_id = s.device_item_id
       ORDER BY t2.created_at DESC LIMIT 1
     ) t ON true
     LEFT JOIN inv_items di ON di.id = s.device_item_id
     LEFT JOIN inv_product_catalog dp ON dp.id = di.product_id
     WHERE ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, { data: rows, total: Number(total), page: Number(page), pageSize: limit });
});

// ── POST / — register single SIM ─────────────────────────────────────────────
router.post("/",
  requireAuth,
  requireRole([...ROLE_GROUPS.INVENTORY_FULL, "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const { iccid: rawIccid, imsi: rawImsi, msisdn, operator, plan,
            pin, puk, activation_date, expiry_date, notes } = req.body;

    if (!rawIccid || !rawImsi) return errorResponse(res, 400, "VALIDATION_ERROR", "iccid and imsi are required");

    const iccid = sanitize(String(rawIccid));
    const imsi  = sanitize(String(rawImsi));
    const msisdnVal = msisdn ? String(msisdn).trim() : null;

    if (!validateIccid(iccid)) return errorResponse(res, 400, "VALIDATION_ERROR", "ICCID must be 19–20 digits");
    if (!validateImsi(imsi))   return errorResponse(res, 400, "VALIDATION_ERROR", "IMSI must be exactly 15 digits");
    if (msisdnVal && !validateMsisdn(msisdnVal))
      return errorResponse(res, 400, "VALIDATION_ERROR", "MSISDN must be a valid Kenyan mobile number (e.g. 0712345678 or 254712345678)");

    const dupClauses = ["iccid=?", "imsi=?"];
    const dupParams: (string | null)[] = [iccid, imsi];
    if (msisdnVal) { dupClauses.push("msisdn=?"); dupParams.push(msisdnVal); }
    const existing = await pgGet(
      `SELECT id FROM inv_sims WHERE (${dupClauses.join(" OR ")}) AND deleted_at IS NULL`,
      dupParams
    );
    if (existing) return errorResponse(res, 409, "CONFLICT", "A SIM with this ICCID, IMSI, or MSISDN already exists");

    const id       = uuidv4();
    const now      = new Date().toISOString();
    const batchRef = await nextDatedBatchNumber("SIM", [{ table: "inv_sims", column: "batch_ref", distinct: true }]);
    await pgRun(
      `INSERT INTO inv_sims (id,iccid,imsi,msisdn,operator,plan,status,pin_enc,puk_enc,
         activation_date,expiry_date,notes,batch_ref,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, iccid, imsi, msisdnVal, operator||null, plan||null, "available",
       pin ? encryptField(pin) : null,
       puk ? encryptField(puk) : null,
       activation_date||null, expiry_date||null, notes||null,
       batchRef, req.user!.id, now, now]
    );

    await writeLedger(id, "registered", null, "available", req.user!.id, req.user!.email||"", "SIM registered");
    await auditLog(req as any, "SIM_REGISTERED", "inv_sims", "Info", { iccid, batchRef });

    const sim = await pgGet(`SELECT id,iccid,imsi,msisdn,operator,plan,status,batch_ref,activation_date,expiry_date,notes,created_at,updated_at FROM inv_sims WHERE id=?`, [id]);
    return created(res, { data: sim });
  }
);

// ── POST /check-duplicates — bulk pre-check before receiving a batch ──────────
router.post("/check-duplicates",
  requireAuth,
  requireRole(["Admin","InventoryManager","WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const iccids: string[] = Array.isArray(req.body?.iccids) ? req.body.iccids : [];
    if (!iccids.length) return ok(res, { duplicates: [] });
    const cleaned = iccids.map(v => sanitize(String(v)));
    const placeholders = cleaned.map(() => "?").join(",");
    const rows = await pgAll(
      `SELECT iccid FROM inv_sims WHERE iccid IN (${placeholders}) AND deleted_at IS NULL`,
      cleaned
    );
    return ok(res, { duplicates: rows.map((r: any) => r.iccid) });
  }
);

// ── POST /bulk — receive a batch of SIMs (mirrors /inventory/items/bulk) ──────
// Provider/plan/type apply to the whole batch; each item is just the physical
// SIM's identifiers. batch_ref is always server-generated so it stays a
// reliable, sortable "received on this date" marker rather than free text.
router.post("/bulk",
  requireAuth,
  requireRole(["Admin","InventoryManager","WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const { operator, plan, simType, items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "items array is required");
    }
    if (simType && !["Global", "IoT"].includes(simType)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "simType must be 'Global' or 'IoT'");
    }

    const now = new Date().toISOString();
    const batchRef = await nextDatedBatchNumber("SIM", [{ table: "inv_sims", column: "batch_ref", distinct: true }]);

    const received: any[] = [];
    const errors: any[] = [];
    const seenIccid = new Set<string>();
    const seenMsisdn = new Set<string>();

    for (const item of items) {
      const rawIccid = item?.iccid;
      const rawImsi  = item?.imsi;
      if (!rawIccid) { errors.push({ item, error: "iccid is required" }); continue; }

      const iccid = sanitize(String(rawIccid));
      if (!validateIccid(iccid)) { errors.push({ item, error: "ICCID must be 19–20 digits" }); continue; }
      if (seenIccid.has(iccid)) { errors.push({ item, error: "Duplicate ICCID within this batch" }); continue; }

      let imsi: string | null = null;
      if (rawImsi) {
        imsi = sanitize(String(rawImsi));
        if (!validateImsi(imsi)) { errors.push({ item, error: "IMSI must be exactly 15 digits" }); continue; }
      }

      let msisdnVal: string | null = null;
      if (item?.msisdn) {
        msisdnVal = String(item.msisdn).trim();
        if (!validateMsisdn(msisdnVal)) { errors.push({ item, error: "MSISDN must be a valid Kenyan mobile number" }); continue; }
        if (seenMsisdn.has(msisdnVal)) { errors.push({ item, error: "Duplicate MSISDN within this batch" }); continue; }
      }

      const bulkDupClauses = ["iccid = ?", "(imsi IS NOT NULL AND imsi = ?)"];
      const bulkDupParams: string[] = [iccid, imsi || ""];
      if (msisdnVal) { bulkDupClauses.push("msisdn = ?"); bulkDupParams.push(msisdnVal); }
      const dup = await pgGet(
        `SELECT id FROM inv_sims WHERE (${bulkDupClauses.join(" OR ")}) AND deleted_at IS NULL`,
        bulkDupParams
      );
      if (dup) { errors.push({ item, error: "Already exists (duplicate ICCID, IMSI, or MSISDN)" }); continue; }

      seenIccid.add(iccid);
      if (msisdnVal) seenMsisdn.add(msisdnVal);

      const id = uuidv4();
      await pgRun(
        `INSERT INTO inv_sims (id,iccid,imsi,msisdn,operator,plan,sim_type,status,batch_ref,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, iccid, imsi, msisdnVal, operator || null, plan || null, simType || null,
          "available", batchRef, req.user!.id, now, now]
      );
      await writeLedger(id, "received", null, "available", req.user!.id, req.user!.email || "", `Bulk-received in batch ${batchRef}`);
      received.push({ id, iccid, imsi });
    }

    if (received.length) {
      auditLog(req as any, "SIM_BULK_RECEIVED", "inv_sims", "Info",
        { batchRef, count: received.length, operator, simType }).catch(console.error);
    }

    return ok(res, { data: { received, errors, batchRef } });
  }
);

// ── POST /import-csv ──────────────────────────────────────────────────────────
router.post("/import-csv",
  requireAuth,
  requireRole([...ROLE_GROUPS.INVENTORY_FULL, "WarehouseOfficer"]),
  csvUpload.single("file"),
  async (req: AuthRequest, res) => {
    if (!req.file) return errorResponse(res, 400, "VALIDATION_ERROR", "CSV file required");

    const content = req.file.buffer.toString("utf-8");
    const lines   = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return errorResponse(res, 400, "VALIDATION_ERROR", "CSV must have a header row and at least one data row");

    const header = lines[0].split(",").map(h => h.trim().toLowerCase());
    const required = ["iccid","imsi"];
    for (const col of required) {
      if (!header.includes(col)) return errorResponse(res, 400, "VALIDATION_ERROR", `Missing required CSV column: ${col}`);
    }

    const idx = (col: string) => header.indexOf(col);
    const iccidInFile  = new Set<string>();
    const imsiInFile   = new Set<string>();
    const msisdnInFile = new Set<string>();

    interface SimRow {
      rowNum: number; iccid: string; imsi: string; msisdn?: string;
      operator?: string; plan?: string; activation_date?: string; expiry_date?: string;
    }
    const valid: SimRow[] = [];
    const errors: { row: number; reason: string; data: string }[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map(c => c.trim());
      const rawIccid = cols[idx("iccid")] || "";
      const rawImsi  = cols[idx("imsi")]  || "";
      const iccid    = sanitize(rawIccid);
      const imsi     = sanitize(rawImsi);

      if (!iccid && !imsi) continue; // blank row

      if (!iccid || !validateIccid(iccid)) {
        errors.push({ row: i + 1, reason: "Invalid ICCID (must be 19–20 digits)", data: rawIccid });
        continue;
      }
      if (!imsi || !validateImsi(imsi)) {
        errors.push({ row: i + 1, reason: "Invalid IMSI (must be 15 digits)", data: rawImsi });
        continue;
      }
      if (iccidInFile.has(iccid)) {
        errors.push({ row: i + 1, reason: "Duplicate ICCID within file", data: iccid });
        continue;
      }
      if (imsiInFile.has(imsi)) {
        errors.push({ row: i + 1, reason: "Duplicate IMSI within file", data: imsi });
        continue;
      }

      const rawMsisdn = idx("msisdn") >= 0 ? (cols[idx("msisdn")] || "").trim() : "";
      if (rawMsisdn) {
        if (!validateMsisdn(rawMsisdn)) {
          errors.push({ row: i + 1, reason: "Invalid MSISDN (must be a valid Kenyan mobile number)", data: rawMsisdn });
          continue;
        }
        if (msisdnInFile.has(rawMsisdn)) {
          errors.push({ row: i + 1, reason: "Duplicate MSISDN within file", data: rawMsisdn });
          continue;
        }
      }

      iccidInFile.add(iccid);
      imsiInFile.add(imsi);
      if (rawMsisdn) msisdnInFile.add(rawMsisdn);

      valid.push({
        rowNum: i + 1, iccid, imsi,
        msisdn:          rawMsisdn || undefined,
        operator:        idx("operator")        >= 0 ? cols[idx("operator")]        || undefined : undefined,
        plan:            idx("plan")            >= 0 ? cols[idx("plan")]            || undefined : undefined,
        activation_date: idx("activation_date") >= 0 ? cols[idx("activation_date")] || undefined : undefined,
        expiry_date:     idx("expiry_date")     >= 0 ? cols[idx("expiry_date")]     || undefined : undefined,
      });
    }

    // Check mode: preview (default) or commit
    const commit = req.query.commit === "true";
    if (!commit) {
      return ok(res, { data: { valid, errors, summary: { total: valid.length + errors.length, valid: valid.length, errors: errors.length } } });
    }

    // Commit: check DB duplicates, insert valid rows
    const iccids  = valid.map(r => r.iccid);
    const imsis   = valid.map(r => r.imsi);
    const msisdns = valid.map(r => r.msisdn).filter((v): v is string => !!v);
    const dbDupIccid = iccids.length
      ? await pgAll(`SELECT iccid FROM inv_sims WHERE iccid IN (${iccids.map(() => "?").join(",")}) AND deleted_at IS NULL`, iccids)
      : [];
    const dbDupImsi  = imsis.length
      ? await pgAll(`SELECT imsi  FROM inv_sims WHERE imsi  IN (${imsis.map(() => "?").join(",")})  AND deleted_at IS NULL`, imsis)
      : [];
    const dbDupMsisdn = msisdns.length
      ? await pgAll(`SELECT msisdn FROM inv_sims WHERE msisdn IN (${msisdns.map(() => "?").join(",")}) AND deleted_at IS NULL`, msisdns)
      : [];

    const dupIccidSet  = new Set(dbDupIccid.map((r: any) => r.iccid));
    const dupImsiSet   = new Set(dbDupImsi.map((r:  any) => r.imsi));
    const dupMsisdnSet = new Set(dbDupMsisdn.map((r: any) => r.msisdn));

    const received: string[] = [];
    const commitErrors: { row: number; reason: string; data: string }[] = [];
    const csvBatchRef = await nextDatedBatchNumber("SIM", [{ table: "inv_sims", column: "batch_ref", distinct: true }]);

    for (const row of valid) {
      if (dupIccidSet.has(row.iccid)) { commitErrors.push({ row: row.rowNum, reason: "ICCID already in database", data: row.iccid }); continue; }
      if (dupImsiSet.has(row.imsi))   { commitErrors.push({ row: row.rowNum, reason: "IMSI already in database",  data: row.imsi  }); continue; }
      if (row.msisdn && dupMsisdnSet.has(row.msisdn)) { commitErrors.push({ row: row.rowNum, reason: "MSISDN already in database", data: row.msisdn }); continue; }

      const id       = uuidv4();
      const now      = new Date().toISOString();
      await pgRun(
        `INSERT INTO inv_sims (id,iccid,imsi,msisdn,operator,plan,status,batch_ref,activation_date,expiry_date,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, row.iccid, row.imsi, row.msisdn||null, row.operator||null, row.plan||null,
         "available", csvBatchRef, row.activation_date||null, row.expiry_date||null,
         req.user!.id, now, now]
      );
      await writeLedger(id, "registered", null, "available", req.user!.id, req.user!.email||"", "Bulk CSV import");
      received.push(row.iccid);
    }

    return ok(res, {
      data: {
        inserted: received.length,
        errors: [...commitErrors],
        summary: { total: valid.length, inserted: received.length, errors: commitErrors.length },
      },
    });
  }
);

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  const sim = await pgGet(`SELECT * FROM inv_sims WHERE id=? AND deleted_at IS NULL`, [req.params.id]);
  if (!sim) return errorResponse(res, 404, "NOT_FOUND", "SIM not found");
  return ok(res, { data: maskSim(sim) });
});

// ── PATCH /:id — update fields ────────────────────────────────────────────────
router.patch("/:id",
  requireAuth,
  requireRole([...ROLE_GROUPS.INVENTORY_FULL, "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const sim = await pgGet(`SELECT * FROM inv_sims WHERE id=? AND deleted_at IS NULL`, [req.params.id]);
    if (!sim) return errorResponse(res, 404, "NOT_FOUND", "SIM not found");

    const { msisdn, operator, plan, pin, puk, activation_date, expiry_date, notes } = req.body;
    const now = new Date().toISOString();

    if (msisdn) {
      const msisdnVal = String(msisdn).trim();
      if (!validateMsisdn(msisdnVal))
        return errorResponse(res, 400, "VALIDATION_ERROR", "MSISDN must be a valid Kenyan mobile number (e.g. 0712345678 or 254712345678)");
      const dup = await pgGet(
        `SELECT id FROM inv_sims WHERE msisdn = ? AND id != ? AND deleted_at IS NULL`,
        [msisdnVal, req.params.id]
      );
      if (dup) return errorResponse(res, 409, "CONFLICT", "Another SIM already uses this MSISDN");
    }

    await pgRun(
      `UPDATE inv_sims SET
         msisdn=COALESCE(?,msisdn), operator=COALESCE(?,operator), plan=COALESCE(?,plan),
         pin_enc=CASE WHEN ? IS NOT NULL THEN ? ELSE pin_enc END,
         puk_enc=CASE WHEN ? IS NOT NULL THEN ? ELSE puk_enc END,
         activation_date=COALESCE(?,activation_date), expiry_date=COALESCE(?,expiry_date),
         notes=COALESCE(?,notes), updated_at=?
       WHERE id=?`,
      [msisdn??null, operator??null, plan??null,
       pin??null, pin ? encryptField(pin) : null,
       puk??null, puk ? encryptField(puk) : null,
       activation_date??null, expiry_date??null, notes??null,
       now, req.params.id]
    );

    await writeLedger(req.params.id, "updated", sim.status, sim.status, req.user!.id, req.user!.email||"", "Fields updated");
    const updated = await pgGet(`SELECT id,iccid,imsi,msisdn,operator,plan,status,activation_date,expiry_date,notes,updated_at FROM inv_sims WHERE id=?`, [req.params.id]);
    return ok(res, { data: updated });
  }
);

// ── POST /:id/status — change status ─────────────────────────────────────────
router.post("/:id/status",
  requireAuth,
  requireRole([...ROLE_GROUPS.INVENTORY_FULL, "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const sim = await pgGet(`SELECT * FROM inv_sims WHERE id=? AND deleted_at IS NULL`, [req.params.id]);
    if (!sim) return errorResponse(res, 404, "NOT_FOUND", "SIM not found");

    const { status: newStatus, notes } = req.body;
    if (!VALID_STATUSES.includes(newStatus)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`);
    }
    const allowed = STATUS_TRANSITIONS[sim.status as SimStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      return errorResponse(res, 422, "INVALID_TRANSITION", `Cannot transition from '${sim.status}' to '${newStatus}'`);
    }

    await pgRun(`UPDATE inv_sims SET status=?, updated_at=? WHERE id=?`,
      [newStatus, new Date().toISOString(), req.params.id]);
    await writeLedger(req.params.id, newStatus, sim.status, newStatus, req.user!.id, req.user!.email||"", notes);
    await auditLog(req as any, `SIM_STATUS_${newStatus.toUpperCase()}`, "inv_sims", "Info", { iccid: sim.iccid, from: sim.status, to: newStatus });

    const updated = await pgGet(`SELECT id,iccid,imsi,msisdn,operator,plan,status,updated_at FROM inv_sims WHERE id=?`, [req.params.id]);
    return ok(res, { data: updated });
  }
);

// ── GET /:id/ledger ───────────────────────────────────────────────────────────
router.get("/:id/ledger", requireAuth, async (req, res) => {
  const sim = await pgGet(`SELECT id FROM inv_sims WHERE id=?`, [req.params.id]);
  if (!sim) return errorResponse(res, 404, "NOT_FOUND", "SIM not found");
  const entries = await pgAll(
    `SELECT * FROM inv_sim_ledger WHERE sim_id=? ORDER BY created_at DESC`, [req.params.id]
  );
  return ok(res, { data: entries });
});

// ── POST /issue — bulk issue SIMs to a technician ────────────────────────────
router.post("/issue",
  requireAuth,
  requireRole([...ROLE_GROUPS.INVENTORY_FULL, "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const { sim_ids, technician_id, technician_name, notes } = req.body;
    if (!technician_id || !technician_name) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "technician_id and technician_name are required");
    }
    if (!Array.isArray(sim_ids) || !sim_ids.length) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "sim_ids must be a non-empty array");
    }

    // Validate technician exists in roster and is a field Technician (not ISO)
    const roster = await pgGet(
      `SELECT user_account_id, hr_employee_id, id AS roster_id, member_type
       FROM technical_team_roster
       WHERE (user_account_id = $1 OR hr_employee_id = $2 OR id::text = $3)`,
      [technician_id, technician_id, technician_id]
    ).catch(() => null);

    if (!roster) {
      return errorResponse(res, 400, "INVALID_RECIPIENT", "Technician not found in active team roster");
    }
    if ((roster as any).member_type !== "Technician") {
      return errorResponse(res, 400, "INVALID_RECIPIENT", "SIMs can only be issued to field Technicians, not ISO staff");
    }

    const canonicalId = (roster as any).user_account_id || technician_id;
    const now = new Date().toISOString();
    const issued: string[] = [];
    const errors: { id: string; reason: string }[] = [];

    for (const simId of sim_ids) {
      const sim = await pgGet(`SELECT * FROM inv_sims WHERE id=? AND deleted_at IS NULL`, [simId]);
      if (!sim) { errors.push({ id: simId, reason: "Not found" }); continue; }
      if (sim.status !== "available") {
        errors.push({ id: simId, reason: `Status is '${sim.status}' — must be available` });
        continue;
      }

      await pgRun(
        `UPDATE inv_sims SET status='issued', issued_to_id=?, issued_to_name=?, issued_at=?, acknowledged_at=NULL, updated_at=? WHERE id=?`,
        [canonicalId, technician_name, now, now, simId]
      );
      await writeLedger(simId, "TRANSFERRED_TO_TECHNICIAN", "available", "issued", req.user!.id, req.user!.email || "",
        notes || `Transferred to ${technician_name} — awaiting acknowledgement`);
      issued.push(simId);
    }

    await auditLog(req as any, "SIM_ISSUE_BATCH", "inv_sims", "Info",
      { issued: issued.length, technician: technician_name, errors: errors.length });

    return ok(res, { data: { issued: issued.length, errors } });
  }
);

// ── POST /acknowledge — technician acknowledges (or rejects) issued SIMs ─────
// "Technical" (ISO)/Admin/InventoryManager/WarehouseOfficer may acknowledge on
// any technician's behalf — mirrors the equivalent device-issuance-batch
// endpoint in inventory-items.ts. A plain Technician is self-scoped to SIMs
// actually issued to them (resolveTechnicianIdSet covers their roster/HR aliases).
router.post("/acknowledge",
  requireAuth,
  requireRole(["Technician", "Technical", "Admin", "InventoryManager", "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const { sim_ids, action = "accept", notes } = req.body || {};
    if (!Array.isArray(sim_ids) || !sim_ids.length) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "sim_ids must be a non-empty array");
    }
    if (!['accept','reject'].includes(action)) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "action must be 'accept' or 'reject'");
    }

    const canActOnBehalf = ["Admin", "InventoryManager", "WarehouseOfficer", "Technical"].includes(req.user!.role);
    const myIds = canActOnBehalf ? null : await resolveTechnicianIdSet(req.user!.id);
    const actorLabel = req.user!.role === "Technical" ? "ISO Office" : req.user!.role;

    const now = new Date().toISOString();
    const updated: string[] = [];
    const errors: { id: string; reason: string }[] = [];

    for (const simId of sim_ids) {
      const sim = await pgGet(`SELECT * FROM inv_sims WHERE id=? AND deleted_at IS NULL`, [simId]);
      if (!sim) { errors.push({ id: simId, reason: "Not found" }); continue; }
      if (sim.status !== "issued") {
        errors.push({ id: simId, reason: `Status is '${sim.status}' — must be issued` });
        continue;
      }
      if (myIds && !myIds.has(sim.issued_to_id)) {
        errors.push({ id: simId, reason: "You can only acknowledge your own issuances" });
        continue;
      }
      const isOnBehalf = sim.issued_to_id !== req.user!.id;
      if (action === "accept") {
        await pgRun(
          `UPDATE inv_sims SET acknowledged_at=?, updated_at=? WHERE id=?`,
          [now, now, simId]
        );
        const ackNote = isOnBehalf
          ? `Acknowledged by ${actorLabel} (${req.user!.email || req.user!.id}) on behalf of ${sim.issued_to_name}`
          : `Acknowledged by ${sim.issued_to_name || req.user!.email || "technician"}`;
        await writeLedger(simId, "ACKNOWLEDGED", "issued", "issued", req.user!.id, req.user!.email || "", notes || ackNote);
      } else {
        // reject → revert to available
        await pgRun(
          `UPDATE inv_sims SET status='available', issued_to_id=NULL, issued_to_name=NULL, issued_at=NULL, acknowledged_at=NULL, updated_at=? WHERE id=?`,
          [now, simId]
        );
        const rejNote = isOnBehalf
          ? `Rejected by ${actorLabel} (${req.user!.email || req.user!.id}) on behalf of ${sim.issued_to_name}`
          : `Rejected by ${sim.issued_to_name || req.user!.email || "technician"}`;
        await writeLedger(simId, "REJECTED_BY_TECHNICIAN", "issued", "available", req.user!.id, req.user!.email || "", notes || rejNote);
      }
      updated.push(simId);
    }

    await auditLog(req as any, action === "accept" ? "SIM_ACKNOWLEDGED" : "SIM_REJECTED",
      "inv_sims", "Info", { count: updated.length, errors: errors.length });

    return ok(res, { data: { updated: updated.length, errors } });
  }
);

// ── POST /transfer — ISO-assisted SIM transfer between technicians ───────────
// Mirrors /inventory/items/transfer: moves already-issued SIMs directly between
// technicians, effective immediately (acknowledged_at set on write) since an
// ISO/Admin/InventoryManager/WarehouseOfficer is physically facilitating the handoff.
router.post("/transfer",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Technical"]),
  async (req: AuthRequest, res) => {
    const { sim_ids, toTechnicianId, toTechnicianName, notes } = req.body || {};
    if (!toTechnicianId || !toTechnicianName)
      return errorResponse(res, 400, "VALIDATION_ERROR", "toTechnicianId and toTechnicianName are required");
    if (!Array.isArray(sim_ids) || !sim_ids.length)
      return errorResponse(res, 400, "VALIDATION_ERROR", "sim_ids must be a non-empty array");

    const now = new Date().toISOString();
    const actorLabel = req.user!.role === "Technical" ? "ISO Office" : req.user!.role;
    const updated: string[] = [];
    const errors: { id: string; reason: string }[] = [];

    for (const simId of sim_ids) {
      const sim = await pgGet(`SELECT * FROM inv_sims WHERE id=? AND deleted_at IS NULL`, [simId]);
      if (!sim) { errors.push({ id: simId, reason: "Not found" }); continue; }
      if (sim.status !== "issued" || !sim.issued_to_id) {
        errors.push({ id: simId, reason: "Not currently in a technician's custody" });
        continue;
      }
      if (sim.issued_to_id === toTechnicianId) {
        errors.push({ id: simId, reason: `Already held by ${toTechnicianName}` });
        continue;
      }
      const fromName = sim.issued_to_name || "—";
      await pgRun(
        `UPDATE inv_sims SET issued_to_id=?, issued_to_name=?, issued_at=?, acknowledged_at=?, updated_at=? WHERE id=?`,
        [toTechnicianId, toTechnicianName, now, now, now, simId]
      );
      await writeLedger(simId, "ISO_ASSISTED_TRANSFER", "issued", "issued", req.user!.id, req.user!.email || "",
        `Transferred from ${fromName} to ${toTechnicianName} — assisted by ${actorLabel} (${req.user!.email || req.user!.id})${notes ? `: ${notes}` : ""}`);
      updated.push(simId);
    }

    auditLog(req as any, "SIM_ISO_ASSISTED_TRANSFER", "inv_sims", "Info",
      { toTechnicianId, toTechnicianName, count: updated.length, errors: errors.length }).catch(console.error);
    return ok(res, { data: { updated: updated.length, errors } }, `${updated.length} SIM(s) transferred to ${toTechnicianName}.`);
  }
);

// ── POST /:id/return — return issued SIM back to available ───────────────────
router.post("/:id/return",
  requireAuth,
  requireRole([...ROLE_GROUPS.INVENTORY_FULL, "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const sim = await pgGet(`SELECT * FROM inv_sims WHERE id=? AND deleted_at IS NULL`, [req.params.id]);
    if (!sim) return errorResponse(res, 404, "NOT_FOUND", "SIM not found");
    if (sim.status !== "issued") {
      return errorResponse(res, 422, "INVALID_TRANSITION", `SIM is not issued (current status: '${sim.status}')`);
    }

    const { notes } = req.body;
    const now = new Date().toISOString();
    await pgRun(
      `UPDATE inv_sims SET status='available', issued_to_id=NULL, issued_to_name=NULL, issued_at=NULL, acknowledged_at=NULL, updated_at=? WHERE id=?`,
      [now, req.params.id]
    );
    await writeLedger(req.params.id, "RETURNED", "issued", "available", req.user!.id, req.user!.email || "",
      notes || `Returned by ${req.user!.email || "unknown"}`);
    await auditLog(req as any, "SIM_RETURNED", "inv_sims", "Info", { iccid: sim.iccid });

    const updated = await pgGet(
      `SELECT id,iccid,imsi,msisdn,operator,plan,status,issued_to_name,issued_at,updated_at FROM inv_sims WHERE id=?`,
      [req.params.id]
    );
    return ok(res, { data: updated });
  }
);

export default router;
