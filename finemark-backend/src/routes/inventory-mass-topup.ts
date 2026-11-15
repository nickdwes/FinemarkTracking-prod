import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { isValidKePhone, normalizeKePhoneStrict } from "../utils/validators.js";
import { buildCsv, sendCsv } from "../utils/csv.js";
import multer from "multer";

const router = Router();

// Ported from the legacy IDTS PHP app's "Manage Mass Top Up" tool
// (MASS_TOP_UP_NEW table) — a queue of tracker SIM numbers that need airtime/
// data top-ups, tracked by ops staff and actioned manually (there was never a
// live telco disbursement API behind it, and there still isn't here — this is
// a to-do list, not a payment integration). Modernized with: a status field
// so a completed top-up doesn't just get deleted (the legacy tool had no way
// to distinguish "done" from "not yet done" other than removing the row),
// strict phone validation via the shared KE phone validator instead of a bare
// 9-digit regex, RBAC, and an audit trail.
pgRun(`
  CREATE TABLE IF NOT EXISTS inv_mass_topups (
    id            TEXT PRIMARY KEY,
    phone         TEXT NOT NULL,
    amount        REAL NOT NULL,
    organization  TEXT,
    network       TEXT NOT NULL DEFAULT 'Safaricom',
    status        TEXT NOT NULL DEFAULT 'Pending',
    batch_ref     TEXT,
    notes         TEXT,
    completed_by  TEXT,
    completed_at  TEXT,
    created_by    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
  )
`, []).catch(e => console.error("[inv_mass_topups] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_mass_topups_status ON inv_mass_topups(status)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_mass_topups_phone ON inv_mass_topups(phone)`, []).catch(() => {});

const WRITE_ROLES = [...ROLE_GROUPS.INVENTORY_FULL, "WarehouseOfficer"];

function mapRow(r: any) {
  return {
    id: r.id, phone: r.phone, amount: Number(r.amount), organization: r.organization || null,
    network: r.network, status: r.status, batchRef: r.batch_ref || null, notes: r.notes || null,
    completedBy: r.completed_by || null, completedAt: r.completed_at || null,
    createdBy: r.created_by || null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ── GET /stats ──────────────────────────────────────────────────────────────
router.get("/stats", requireAuth, async (_req, res) => {
  const rows = await pgAll<{ status: string; n: string; total_amount: string }>(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS total_amount
     FROM inv_mass_topups WHERE deleted_at IS NULL GROUP BY status`, []
  );
  const stats = { pending: 0, completed: 0, pendingAmount: 0, completedAmount: 0 };
  for (const r of rows) {
    const n = Number(r.n), amt = Number(r.total_amount);
    if (r.status === "Completed") { stats.completed = n; stats.completedAmount = amt; }
    else { stats.pending += n; stats.pendingAmount += amt; }
  }
  return ok(res, { stats });
});

// ── GET / — list, search, status filter, pagination ─────────────────────────
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const { search, status, page, pageSize } = req.query as Record<string, string | undefined>;
  const conditions: string[] = ["deleted_at IS NULL"];
  const params: any[] = [];

  if (search?.trim()) {
    conditions.push("(phone ILIKE ? OR organization ILIKE ? OR network ILIKE ?)");
    params.push(`%${search.trim()}%`, `%${search.trim()}%`, `%${search.trim()}%`);
  }
  if (status?.trim()) { conditions.push("status = ?"); params.push(status.trim()); }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const parsedPage = Math.max(parseInt(page || "1", 10) || 1, 1);
  const parsedPageSize = Math.min(parseInt(pageSize || "50", 10) || 50, 500);
  const offset = (parsedPage - 1) * parsedPageSize;

  const [rows, totalRow] = await Promise.all([
    pgAll(`SELECT * FROM inv_mass_topups ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, parsedPageSize, offset]),
    pgGet<{ total: string }>(`SELECT COUNT(*) AS total FROM inv_mass_topups ${where}`, params),
  ]);

  return ok(res, { data: rows.map(mapRow), meta: { total: Number(totalRow?.total || 0), page: parsedPage, pageSize: parsedPageSize } });
});

// ── GET /export.csv ───────────────────────────────────────────────────────────
router.get("/export.csv", requireAuth, requireRole(WRITE_ROLES), async (req, res) => {
  const rows = await pgAll(`SELECT * FROM inv_mass_topups WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 10000`, []);
  const csv = buildCsv(
    ["phone", "amount", "organization", "network", "status", "completedAt", "createdAt"],
    rows.map(mapRow)
  );
  auditLog(req, "MASS_TOPUP_EXPORTED", "inv_mass_topups", "Info", { count: rows.length }).catch(console.error);
  return sendCsv(res, "mass-topups.csv", csv);
});

// ── Installed-SIM airtime top-up report ──────────────────────────────────────
// Pulls every successfully-installed SIM (by ICCID) with its captured MSISDN and
// emits the exact 4-column CSV the legacy IDTS "Upload Mass Top Up" tool ingests
// (MASS_TOP_UP_NEW: number, amount, organization, network) — one row per installed
// SIM that has a number on file. SIMs missing an MSISDN are reported in the JSON
// preview but excluded from the CSV (they can't be topped up without a number).
function toTopupNumber(msisdn: any): string {
  let d = String(msisdn || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("254") && d.length > 9) d = d.slice(3); // strip country code
  d = d.replace(/^0+/, "");                                 // strip leading zero(s)
  return d;
}

async function loadInstalledSims(status: string) {
  const statuses = status === "both" ? ["installed", "issued"] : [status];
  const placeholders = statuses.map(() => "?").join(",");
  return pgAll(
    `SELECT s.id, s.iccid, s.msisdn, s.operator, s.status, s.issued_to_name, s.batch_ref, s.installed_at
     FROM inv_sims s
     WHERE s.status IN (${placeholders}) AND s.deleted_at IS NULL
     ORDER BY s.installed_at DESC NULLS LAST, s.iccid ASC
     LIMIT 20000`,
    statuses
  );
}

router.get("/installed-report", requireAuth, requireRole(WRITE_ROLES), async (req: AuthRequest, res) => {
  const status = String((req.query.status as string) || "installed").toLowerCase();
  const rows = await loadInstalledSims(status);
  const mapped = rows.map((r: any) => {
    const number = toTopupNumber(r.msisdn);
    return {
      id: r.id, iccid: r.iccid, msisdn: r.msisdn || null, number: number || null,
      network: ((r.operator || "").toLowerCase() || null), simStatus: r.status,
      issuedTo: r.issued_to_name || null, batchRef: r.batch_ref || null,
      installedAt: r.installed_at || null, ready: !!number,
    };
  });
  const withNumber = mapped.filter((r) => r.ready).length;
  return ok(res, {
    summary: { installed: mapped.length, withMsisdn: withNumber, missingMsisdn: mapped.length - withNumber, status },
    rows: mapped,
  });
});

router.get("/installed-report.csv", requireAuth, requireRole(WRITE_ROLES), async (req: AuthRequest, res) => {
  const status = String((req.query.status as string) || "installed").toLowerCase();
  const amount = Number(req.query.amount) > 0 ? Number(req.query.amount) : 7;
  const organization = String((req.query.organization as string) || "unique").trim() || "unique";
  const defaultNetwork = String((req.query.network as string) || "safaricom").trim().toLowerCase() || "safaricom";
  const rows = await loadInstalledSims(status);
  const csvRows = rows
    .map((r: any) => ({ number: toTopupNumber(r.msisdn), network: ((r.operator || "").toLowerCase() || defaultNetwork) }))
    .filter((r: any) => r.number)
    .map((r: any) => ({ number: r.number, amount: amount.toFixed(2), organization, network: r.network }));
  const csv = buildCsv(["number", "amount", "organization", "network"], csvRows);
  auditLog(req, "MASS_TOPUP_INSTALLED_REPORT_EXPORTED", "inv_sims", "Info", { status, count: csvRows.length, amount, organization }).catch(console.error);
  return sendCsv(res, `installed-sim-topup_${status}_${new Date().toISOString().slice(0, 10)}.csv`, csv);
});

// ── Set/correct a SIM's MSISDN directly from the top-up report ────────────────
// Accepts M2M / data-SIM numbers (e.g. 0300…), not just standard KE mobiles, so
// ops can complete the airtime top-up list inline from the report.
router.post("/installed-report/set-msisdn", requireAuth, requireRole(WRITE_ROLES), async (req: AuthRequest, res) => {
  const { id, msisdn } = req.body || {};
  if (!id) return errorResponse(res, 400, "VALIDATION_ERROR", "SIM id is required.");
  const clean = String(msisdn || "").replace(/[^\d+]/g, "");
  if (clean.replace(/\D/g, "").length < 6) return errorResponse(res, 400, "VALIDATION_ERROR", "Enter a valid SIM number / MSISDN.");
  const sim = await pgGet(`SELECT id, iccid FROM inv_sims WHERE id = ? AND deleted_at IS NULL`, [id]);
  if (!sim) return errorResponse(res, 404, "NOT_FOUND", "SIM not found.");
  await pgRun(`UPDATE inv_sims SET msisdn = ?, updated_at = ? WHERE id = ?`, [clean, new Date().toISOString(), id]);
  auditLog(req, "SIM_MSISDN_SET", `inv_sim:${id}`, "Info", { iccid: (sim as any).iccid, msisdn: clean }).catch(console.error);
  return ok(res, { id, msisdn: clean, number: toTopupNumber(clean) });
});

// ── POST / — bulk manual add (paste-list of numbers, one amount/org/network) ─
router.post("/", requireAuth, requireRole(WRITE_ROLES), async (req: AuthRequest, res) => {
  const { numbers, amount, organization, network } = req.body || {};
  const list: string[] = Array.isArray(numbers) ? numbers : String(numbers || "").split(/\r?\n/);
  const cleaned = list.map((n) => String(n || "").trim()).filter(Boolean);

  const amt = Number(amount);
  if (!cleaned.length) return errorResponse(res, 400, "VALIDATION_ERROR", "At least one phone number is required.");
  if (!Number.isFinite(amt) || amt < 0) return errorResponse(res, 400, "VALIDATION_ERROR", "Amount must be a non-negative number.");
  if (!network?.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "Network is required.");

  const inserted: string[] = [];
  const skipped: { number: string; reason: string }[] = [];
  const seenInBatch = new Set<string>();

  for (const raw of cleaned) {
    if (!isValidKePhone(raw)) { skipped.push({ number: raw, reason: "Invalid Kenyan phone number." }); continue; }
    const phone = normalizeKePhoneStrict(raw)!;
    if (seenInBatch.has(phone)) { skipped.push({ number: raw, reason: "Duplicate within this batch." }); continue; }
    const existing = await pgGet(`SELECT 1 FROM inv_mass_topups WHERE phone = ? AND status = 'Pending' AND deleted_at IS NULL`, [phone]);
    if (existing) { skipped.push({ number: raw, reason: "Already has a pending top-up." }); continue; }

    seenInBatch.add(phone);
    const now = new Date().toISOString();
    await pgRun(
      `INSERT INTO inv_mass_topups (id, phone, amount, organization, network, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?, 'Pending', ?, ?, ?)`,
      [uuidv4(), phone, amt, organization?.trim() || null, network.trim(), req.user!.id, now, now]
    );
    inserted.push(phone);
  }

  await auditLog(req, "MASS_TOPUP_BULK_ADDED", "inv_mass_topups", "Info", { inserted: inserted.length, skipped: skipped.length }).catch(console.error);
  return created(res, { inserted: inserted.length, skipped });
});

// ── POST /import-csv?commit=true|false — preview then commit, mirrors ───────
// inventory-sims.ts's CSV import pattern.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
router.post("/import-csv", requireAuth, requireRole(WRITE_ROLES), csvUpload.single("file"), async (req: AuthRequest, res) => {
  if (!req.file) return errorResponse(res, 400, "VALIDATION_ERROR", "CSV file required.");

  const content = req.file.buffer.toString("utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return errorResponse(res, 400, "VALIDATION_ERROR", "CSV must have a header row and at least one data row.");

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const required = ["number", "amount", "organization", "network"];
  for (const col of required) {
    if (!header.includes(col)) return errorResponse(res, 400, "VALIDATION_ERROR", `Missing required CSV column: ${col}`);
  }
  const idx = (col: string) => header.indexOf(col);

  interface Row { rowNum: number; phone: string; amount: number; organization: string; network: string }
  const valid: Row[] = [];
  const errors: { row: number; reason: string; data: string }[] = [];
  const seenInFile = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const rawNumber = cols[idx("number")] || "";
    const rawAmount = cols[idx("amount")] || "";
    const organization = cols[idx("organization")] || "";
    const network = cols[idx("network")] || "";

    if (!rawNumber && !rawAmount) continue; // blank row

    if (!isValidKePhone(rawNumber)) { errors.push({ row: i + 1, reason: "Invalid Kenyan phone number.", data: rawNumber }); continue; }
    const phone = normalizeKePhoneStrict(rawNumber)!;
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 0) { errors.push({ row: i + 1, reason: "Invalid amount.", data: rawAmount }); continue; }
    if (!network) { errors.push({ row: i + 1, reason: "Network is required.", data: lines[i] }); continue; }
    if (seenInFile.has(phone)) { errors.push({ row: i + 1, reason: "Duplicate phone number within file.", data: rawNumber }); continue; }

    seenInFile.add(phone);
    valid.push({ rowNum: i + 1, phone, amount, organization, network });
  }

  const commit = req.query.commit === "true";
  if (!commit) {
    return ok(res, { data: { valid, errors, summary: { total: valid.length + errors.length, valid: valid.length, errors: errors.length } } });
  }

  const phones = valid.map((r) => r.phone);
  const dbDup = phones.length
    ? await pgAll<{ phone: string }>(`SELECT phone FROM inv_mass_topups WHERE phone IN (${phones.map(() => "?").join(",")}) AND status = 'Pending' AND deleted_at IS NULL`, phones)
    : [];
  const dupSet = new Set(dbDup.map((r) => r.phone));

  const commitErrors: { row: number; reason: string; data: string }[] = [];
  let insertedCount = 0;
  const batchRef = `TOPUP-BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

  for (const row of valid) {
    if (dupSet.has(row.phone)) { commitErrors.push({ row: row.rowNum, reason: "Already has a pending top-up.", data: row.phone }); continue; }
    const now = new Date().toISOString();
    await pgRun(
      `INSERT INTO inv_mass_topups (id, phone, amount, organization, network, status, batch_ref, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?, 'Pending', ?, ?, ?, ?)`,
      [uuidv4(), row.phone, row.amount, row.organization || null, row.network, batchRef, req.user!.id, now, now]
    );
    insertedCount++;
  }

  await auditLog(req, "MASS_TOPUP_CSV_IMPORTED", "inv_mass_topups", "Info", { inserted: insertedCount, errors: commitErrors.length, batchRef }).catch(console.error);
  return ok(res, { data: { inserted: insertedCount, errors: commitErrors, summary: { total: valid.length, inserted: insertedCount, errors: commitErrors.length } } });
});

// ── PATCH /:id — edit fields and/or toggle status ────────────────────────────
router.patch("/:id", requireAuth, requireRole(WRITE_ROLES), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT * FROM inv_mass_topups WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Top-up record not found.");

  const { phone, amount, organization, network, status, notes } = req.body || {};
  const updates: string[] = [];
  const values: any[] = [];

  if (phone !== undefined) {
    if (!isValidKePhone(phone)) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid Kenyan phone number.");
    updates.push("phone = ?"); values.push(normalizeKePhoneStrict(phone));
  }
  if (amount !== undefined) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) return errorResponse(res, 400, "VALIDATION_ERROR", "Amount must be a non-negative number.");
    updates.push("amount = ?"); values.push(amt);
  }
  if (organization !== undefined) { updates.push("organization = ?"); values.push(organization?.trim() || null); }
  if (network !== undefined) {
    if (!network?.trim()) return errorResponse(res, 400, "VALIDATION_ERROR", "Network is required.");
    updates.push("network = ?"); values.push(network.trim());
  }
  if (notes !== undefined) { updates.push("notes = ?"); values.push(notes?.trim() || null); }
  if (status !== undefined) {
    if (!["Pending", "Completed"].includes(status)) return errorResponse(res, 400, "VALIDATION_ERROR", "Status must be Pending or Completed.");
    updates.push("status = ?"); values.push(status);
    if (status === "Completed") {
      updates.push("completed_by = ?", "completed_at = ?");
      values.push(req.user!.email || req.user!.id, new Date().toISOString());
    } else {
      updates.push("completed_by = NULL", "completed_at = NULL");
    }
  }

  if (!updates.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No fields to update.");
  updates.push("updated_at = ?"); values.push(new Date().toISOString());
  values.push(req.params.id);

  await pgRun(`UPDATE inv_mass_topups SET ${updates.join(", ")} WHERE id = ?`, values);
  await auditLog(req, "MASS_TOPUP_UPDATED", `inv_mass_topups:${req.params.id}`, "Info", { fields: Object.keys(req.body || {}) }).catch(console.error);

  const updated = await pgGet(`SELECT * FROM inv_mass_topups WHERE id = ?`, [req.params.id]);
  return ok(res, { data: mapRow(updated) });
});

// ── DELETE /:id ────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole(WRITE_ROLES), async (req: AuthRequest, res) => {
  const row = await pgGet(`SELECT id FROM inv_mass_topups WHERE id = ? AND deleted_at IS NULL`, [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Top-up record not found.");
  await pgRun(`UPDATE inv_mass_topups SET deleted_at = ? WHERE id = ?`, [new Date().toISOString(), req.params.id]);
  await auditLog(req, "MASS_TOPUP_DELETED", `inv_mass_topups:${req.params.id}`, "Info", {}).catch(console.error);
  return ok(res, { data: { id: req.params.id } });
});

export default router;
