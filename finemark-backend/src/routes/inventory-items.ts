import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { createNotification } from "./notifications.js";
import { nextDatedBatchNumber } from "../utils/batchNumber.js";

const router = Router();

// ── Tables ────────────────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS inv_items (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    serial_number TEXT,
    imei TEXT,
    mac_address TEXT,
    supplier_id TEXT,
    supplier_ref TEXT,
    batch_id TEXT,
    purchase_date TEXT,
    purchase_price REAL,
    warehouse_location TEXT,
    status TEXT NOT NULL DEFAULT 'In Stock',
    installation_id TEXT,
    customer_id TEXT,
    sim_phone TEXT,
    sim_serial TEXT,
    activated_at TEXT,
    deployed_at TEXT,
    warranty_expires_at TEXT,
    defect_ticket_id TEXT,
    replaced_by_item_id TEXT,
    notes TEXT,
    created_by_user_id TEXT,
    received_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[inv_items] init:", e));

// Safe migration — add batch_ref if not present (stores GRN text reference from bulk receive)
pgRun(`ALTER TABLE inv_items ADD COLUMN batch_ref TEXT`, []).catch(() => {});
// Backfill batch_ref from notes for devices received before the batch_ref column existed
pgRun(`UPDATE inv_items SET batch_ref = SUBSTR(notes, 8) WHERE batch_ref IS NULL AND notes LIKE 'Batch: %'`, []).catch(() => {});

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_movements (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    product_id TEXT,
    action TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    from_location TEXT,
    to_location TEXT,
    installation_id TEXT,
    batch_id TEXT,
    performed_by_user_id TEXT NOT NULL,
    performed_by_email TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[inv_movements] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_checkout_records (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    installation_ticket_id TEXT,
    technician_id TEXT,
    technician_email TEXT,
    sim_phone TEXT,
    checkout_by_user_id TEXT,
    checkout_at TEXT NOT NULL,
    checkin_at TEXT,
    checkin_by_user_id TEXT,
    return_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[inv_checkout_records] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_issuance_batches (
    id                TEXT PRIMARY KEY,
    batch_ref         TEXT UNIQUE NOT NULL,
    technician_id     TEXT NOT NULL,
    technician_name   TEXT,
    clerk_user_id     TEXT NOT NULL,
    clerk_email       TEXT,
    device_count      INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'Pending',
    acknowledged_at   TEXT,
    rejection_reason  TEXT,
    notes             TEXT,
    issued_at         TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )
`, []).catch(e => console.error("[inv_issuance_batches] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_iss_tech   ON inv_issuance_batches(technician_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_iss_status ON inv_issuance_batches(status)`, []).catch(() => {});
// Records who actually performed the acknowledgment and in what role — distinct
// from technician_id once ISO/Admin/etc. can acknowledge on a technician's behalf.
pgRun(`ALTER TABLE inv_issuance_batches ADD COLUMN IF NOT EXISTS acknowledged_by_user_id TEXT`, []).catch(() => {});
pgRun(`ALTER TABLE inv_issuance_batches ADD COLUMN IF NOT EXISTS acknowledged_by_role TEXT`, []).catch(() => {});

pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_items_product ON inv_items(product_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_items_imei ON inv_items(imei)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_items_serial ON inv_items(serial_number)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_items_status ON inv_items(status)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_movements_item ON inv_movements(item_id)`, []).catch(() => {});

// ── Migrate: reservation + issuance columns ────────────────────────────────
setTimeout(async () => {
  for (const col of [
    "reserved_until TEXT", "reservation_quote_id TEXT",
    "issued_to_id TEXT", "issued_to_name TEXT", "issued_at TEXT",
    "issuance_batch_id TEXT", "acknowledged_at TEXT",
  ]) {
    await pgRun(`ALTER TABLE inv_items ADD COLUMN IF NOT EXISTS ${col}`, []).catch(() => {});
  }

  // ── Auto-link roster entries to user accounts by matching display_name ──
  // Runs on every startup; safe to run repeatedly (only updates NULL rows).
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE technical_team_roster r
     SET user_account_id = u.id, updated_at = ?
     FROM users u
     WHERE LOWER(TRIM(u.name)) = LOWER(TRIM(r.display_name))
       AND r.user_account_id IS NULL`,
    [now]
  ).catch(() => {});
}, 1000);

// ── Auto-release expired reservations every 5 minutes ───────────────────────
async function releaseExpiredReservations() {
  const now = new Date().toISOString();
  const expired = await pgAll(
    `SELECT id, product_id FROM inv_items
     WHERE status = 'Reserved' AND reserved_until IS NOT NULL AND reserved_until < ? AND deleted_at IS NULL`,
    [now]
  ).catch(() => []);
  for (const item of expired) {
    await pgRun(
      `UPDATE inv_items SET status='In Stock', reserved_until=NULL, reservation_quote_id=NULL, updated_at=? WHERE id=?`,
      [now, item.id]
    ).catch(() => {});
    await pgRun(
      `INSERT INTO inv_movements (id,item_id,product_id,action,from_status,to_status,performed_by_user_id,performed_by_email,notes,created_at)
       VALUES (?,?,?,'RESERVATION_EXPIRED','Reserved','In Stock','system','system','Reservation expired automatically',?)`,
      [uuidv4(), item.id, item.product_id, now]
    ).catch(() => {});
  }
  if (expired.length > 0) console.log(`[reservations] Released ${expired.length} expired reservation(s)`);
}
setInterval(releaseExpiredReservations, 5 * 60 * 1000);
setTimeout(releaseExpiredReservations, 3000); // also run on startup

// ── VALID STATUSES ─────────────────────────────────────────────────────────────
const VALID_STATUSES = [
  "In Stock", "Reserved", "Issued for Installation", "Installed",
  "Returned", "Defective", "Sent to Supplier", "Replaced",
];

async function logMovement(
  itemId: string, productId: string, action: string,
  fromStatus: string|null, toStatus: string|null,
  fromLocation: string|null, toLocation: string|null,
  userId: string, userEmail: string, notes?: string, installationId?: string, batchId?: string
) {
  await pgRun(
    `INSERT INTO inv_movements
       (id,item_id,product_id,action,from_status,to_status,from_location,to_location,
        installation_id,batch_id,performed_by_user_id,performed_by_email,notes,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uuidv4(), itemId, productId, action, fromStatus, toStatus,
     fromLocation, toLocation, installationId||null, batchId||null,
     userId, userEmail, notes||null, new Date().toISOString()]
  );
}

// ── GET /stats — inventory statistics ─────────────────────────────────────────
router.get("/stats", requireAuth, async (_req, res) => {
  const statRows = await pgAll(
    `SELECT i.status, COUNT(*) as cnt FROM inv_items i WHERE i.deleted_at IS NULL GROUP BY i.status`, []
  );
  const stats: Record<string, number> = {};
  for (const r of statRows) stats[r.status] = Number(r.cnt);

  // Effective stock = anything not yet installed/returned/defective/etc.
  // Per business rule: devices already issued to technicians remain "in stock"
  // until the installation is completed.
  const effectiveStockExpr = `i.status IN ('In Stock','Reserved','Issued for Installation')`;

  // Low-stock products: compare effective stock to reorder level
  const lowStock = await pgAll(
    `SELECT p.product_code, p.product_name, p.device_model, p.reorder_level,
            COUNT(CASE WHEN ${effectiveStockExpr} THEN 1 END) as in_stock
     FROM inv_product_catalog p
     LEFT JOIN inv_items i ON i.product_id = p.id AND i.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.active = 1
     GROUP BY p.id, p.product_code, p.product_name, p.device_model, p.reorder_level
     HAVING COUNT(CASE WHEN ${effectiveStockExpr} THEN 1 END) <= p.reorder_level
     ORDER BY COUNT(CASE WHEN ${effectiveStockExpr} THEN 1 END) ASC LIMIT 10`, []
  );

  // Effective stock total (used by dashboard tiles that want a single "stock" number)
  stats["Effective Stock"] =
    (stats["In Stock"] || 0) +
    (stats["Reserved"] || 0) +
    (stats["Issued for Installation"] || 0);

  // Assigned to a specific job card — a real subset of "Issued for
  // Installation", not a synonym for it. Confirmed live: of 448 currently-
  // issued devices, only 2 are actually linked to a specific installation
  // ticket (via inv_items.installation_id, set optionally at /checkout time,
  // or installation_tickets.assigned_device_id, set when a ticket picks a
  // specific device) — the other 446 are in a technician's general custody
  // but not yet tied to a job. Both linkage columns are checked since either
  // can be the one populated depending on which workflow step set it.
  const assignedRow = await pgGet<{ cnt: string }>(
    `SELECT COUNT(DISTINCT i.id) AS cnt
     FROM inv_items i
     LEFT JOIN installation_tickets t ON t.assigned_device_id = i.id
     WHERE i.deleted_at IS NULL
       AND i.status = 'Issued for Installation'
       AND (i.installation_id IS NOT NULL OR t.id IS NOT NULL)`, []
  );
  stats["Assigned to Job Card"] = Number(assignedRow?.cnt || 0);

  return ok(res, { data: { summary: stats, lowStock } });
});

// Technicians ranked by devices currently in custody (a live snapshot, not
// time-windowed), each also carrying an "installed in the last N days" count
// for the given window. issued_to_id on inv_items is users.id directly
// (confirmed live: 436/436 issued items match users.id, 0/436 match
// hr_employees.id) — an earlier version of this query bridged through
// hr_employees/technical_team_roster assuming issued_to_id was an
// hr_employees.id, which silently resolved technician_email to NULL for
// every technician and every "installed" figure to 0.
//
// installed_Nd is deliberately NOT keyed by inv_movements.performed_by_user_id
// — installs are auto-logged by ISO/back-office staff completing the ticket
// workflow (confirmed live: every INSTALLED movement was authored by one of
// just 4 ISO/Technical-role accounts, never by the field technician
// themselves), so that would misattribute every install to back-office staff
// instead of whoever actually did the job. Attribute instead via the
// device's own issued_to_id, which the /:id/install handler leaves
// untouched when it flips status to 'Installed' — i.e. "whoever had custody
// of this item when it got installed."
async function getTopTechnicians(installedWindowDays: number) {
  const since = new Date(Date.now() - installedWindowDays * 86400000).toISOString();

  const inCustody = await pgAll(
    `SELECT i.issued_to_id                                                 AS technician_id,
            COALESCE(NULLIF(i.issued_to_name, ''), u.name, 'Unknown')      AS technician_name,
            u.email                                                       AS technician_email,
            COUNT(*)                                                      AS in_custody
     FROM inv_items i
     LEFT JOIN users u ON u.id = i.issued_to_id
     WHERE i.deleted_at IS NULL
       AND i.status = 'Issued for Installation'
       AND i.issued_to_id IS NOT NULL
     GROUP BY i.issued_to_id, i.issued_to_name, u.name, u.email
     ORDER BY in_custody DESC
     LIMIT 10`, []
  );

  const technicianIds = inCustody.map((r: any) => r.technician_id).filter(Boolean);
  let installedMap: Record<string, number> = {};
  if (technicianIds.length) {
    const placeholders = technicianIds.map(() => "?").join(",");
    const installRows = await pgAll(
      `SELECT i.issued_to_id AS technician_id, COUNT(*) AS installed
       FROM inv_movements m
       JOIN inv_items i ON i.id = m.item_id
       WHERE m.action = 'INSTALLED'
         AND m.created_at >= ?
         AND i.issued_to_id IN (${placeholders})
       GROUP BY i.issued_to_id`,
      [since, ...technicianIds]
    );
    for (const r of installRows) installedMap[r.technician_id] = Number(r.installed);
  }

  return inCustody.map((r: any) => ({
    technician_id:    r.technician_id,
    technician_name:  r.technician_name,
    technician_email: r.technician_email,
    in_custody:       Number(r.in_custody),
    installed_90d:    installedMap[r.technician_id] ?? 0, // key name kept for existing dashboard-detail consumers
  }));
}

// ── GET /technician-leaderboard — Top Technicians panel, day-range selectable ──
// Backs the dashboard's slider (1/3/7/14/21/30/60/90 days) — custody is
// always a live snapshot; only the "installed" window changes.
router.get("/technician-leaderboard", requireAuth, async (req, res) => {
  const daysRaw = parseInt((req.query.days as string) || "90", 10);
  const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 90, 1), 365);
  const topTechnicians = await getTopTechnicians(days);
  return ok(res, { data: topTechnicians.map(t => ({ ...t, installed: t.installed_90d })), meta: { days } });
});

// ── GET /dashboard-detail — detailed dashboard breakdowns ─────────────────────
// Returns:
//   - byCategoryProduct: per-product status breakdown grouped by category
//   - fastestMoving:     products with most issue/install/return movements in last 30 days
//   - topTechnicians:    technicians ranked by devices currently in custody
router.get("/dashboard-detail", requireAuth, async (req, res) => {
  // Only movementTrend is windowed by this — byCategoryProduct/fastestMoving/
  // topTechnicians/certLinkage stay on their own fixed windows (out of scope
  // for the dynamic day-range selector on the new Pipeline & Stock report).
  const trendDaysRaw = parseInt((req.query.days as string) || "30", 10);
  const trendDays = Math.min(Math.max(Number.isFinite(trendDaysRaw) ? trendDaysRaw : 30, 1), 365);
  // Per-product breakdown by category & product
  const byCategoryProduct = await pgAll(
    `SELECT c.id  AS category_id,
            c.name AS category_name,
            p.id  AS product_id,
            p.product_code,
            p.product_name,
            p.device_model,
            p.reorder_level,
            COUNT(CASE WHEN i.status = 'In Stock' THEN 1 END)                 AS in_stock,
            COUNT(CASE WHEN i.status = 'Reserved' THEN 1 END)                 AS reserved,
            COUNT(CASE WHEN i.status = 'Issued for Installation' THEN 1 END)  AS issued,
            COUNT(CASE WHEN i.status = 'Installed' THEN 1 END)                AS installed,
            COUNT(CASE WHEN i.status = 'Returned' THEN 1 END)                 AS returned,
            COUNT(CASE WHEN i.status = 'Defective' THEN 1 END)                AS defective,
            COUNT(CASE WHEN i.status = 'Sent to Supplier' THEN 1 END)         AS to_supplier,
            COUNT(i.id)                                                       AS total
     FROM inv_product_catalog p
     JOIN inv_product_categories c ON c.id = p.category_id
     LEFT JOIN inv_items i ON i.product_id = p.id AND i.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.active = 1
     GROUP BY c.id, c.name, p.id, p.product_code, p.product_name, p.device_model, p.reorder_level
     ORDER BY c.name ASC, p.product_code ASC`, []
  );

  // Fastest-moving products: count Issue + Install + Return movements in last 30 days.
  // created_at is stored as ISO text; lexicographic compare works for ISO-8601.
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const fastestMoving = await pgAll(
    `SELECT p.id            AS product_id,
            p.product_code,
            p.product_name,
            p.device_model,
            c.name           AS category_name,
            COUNT(*)                                                           AS movements_30d,
            COUNT(CASE WHEN m.action = 'ISSUED_TO_TECHNICIAN' THEN 1 END)      AS issued_30d,
            COUNT(CASE WHEN m.action = 'INSTALLED' THEN 1 END)                 AS installed_30d,
            COUNT(CASE WHEN m.action IN ('RETURNED','RETURNED_DEFECTIVE') THEN 1 END) AS returned_30d
     FROM inv_movements m
     JOIN inv_product_catalog p ON p.id = m.product_id
     JOIN inv_product_categories c ON c.id = p.category_id
     WHERE m.created_at >= ?
       AND m.action NOT IN ('RECEIVED','CREATED','RESERVATION_EXPIRED')
     GROUP BY p.id, p.product_code, p.product_name, p.device_model, c.name
     ORDER BY movements_30d DESC, installed_30d DESC
     LIMIT 10`,
    [since30]
  );

  // Top technicians by devices currently in custody, with a 90-day installed
  // count (the dashboard's default view before the user touches the day
  // slider — see getTopTechnicians() and GET /technician-leaderboard above).
  const topTechnicians = await getTopTechnicians(90);

  // Real movement feed for the dashboard's "Recent Movements" panel — the
  // frontend previously faked this from the latest 8 inv_items by
  // updated_at, which is really just "current status of recently touched
  // items," not actual movement history. This is the real inv_movements
  // ledger.
  const recentMovements = await pgAll(
    `SELECT m.id, m.action, m.from_status, m.to_status, m.created_at, m.performed_by_email, m.notes,
            p.product_code, p.product_name, p.device_model,
            i.imei, i.serial_number
     FROM inv_movements m
     LEFT JOIN inv_items i ON i.id = m.item_id
     LEFT JOIN inv_product_catalog p ON p.id = m.product_id
     ORDER BY m.created_at DESC
     LIMIT 15`, []
  );

  // Daily movement volume, day-range selectable (defaults to 30d) — same
  // exclusions as fastestMoving above (RECEIVED/CREATED/RESERVATION_EXPIRED
  // are bookkeeping, not real device movement). Zero-fill missing days client-side.
  const sinceTrend = new Date(Date.now() - trendDays * 86400000).toISOString();
  const movementTrend = await pgAll(
    `SELECT SUBSTRING(created_at,1,10) AS day, COUNT(*) AS cnt
     FROM inv_movements
     WHERE created_at >= ?
       AND action NOT IN ('RECEIVED','CREATED','RESERVATION_EXPIRED')
     GROUP BY day
     ORDER BY day`,
    [sinceTrend]
  );

  // Certificates linked to devices — via the vehicle-registration chain
  // (certificates.car_registration -> installation_tickets.vehicle_registration
  // -> inv_items.installation_id), NOT a direct IMEI match. Confirmed live:
  // direct IMEI match only covers ~2% of certificates (6 of 323) vs ~35%
  // (112 of 323) via this chain — certificates.imei_1/imei_2 are free-typed
  // at cert-creation time, not a real FK to inv_items. One row per matched
  // device, so a cert with 2 devices yields 2 rows.
  const certLinkageRows = await pgAll(
    `SELECT c.id AS cert_id, c.serial_no, c.car_registration, c.name AS customer_name, c.created_at AS cert_created_at,
            i.imei, i.serial_number, i.status,
            p.product_name, p.device_model
     FROM certificates c
     JOIN installation_tickets t ON REPLACE(UPPER(t.vehicle_registration),' ','') = REPLACE(UPPER(c.car_registration),' ','')
     JOIN inv_items i ON i.installation_id = t.id AND i.deleted_at IS NULL
     LEFT JOIN inv_product_catalog p ON p.id = i.product_id
     ORDER BY c.created_at DESC
     LIMIT 50`, []
  );
  const certLinkageCountRow = await pgGet<{ cnt: string }>(
    `SELECT COUNT(DISTINCT c.id) AS cnt
     FROM certificates c
     JOIN installation_tickets t ON REPLACE(UPPER(t.vehicle_registration),' ','') = REPLACE(UPPER(c.car_registration),' ','')
     JOIN inv_items i ON i.installation_id = t.id AND i.deleted_at IS NULL`, []
  );

  return ok(res, {
    data: {
      byCategoryProduct, fastestMoving, topTechnicians,
      recentMovements, movementTrend,
      certLinkage: { count: Number(certLinkageCountRow?.cnt || 0), rows: certLinkageRows },
    },
    meta: { trendDays },
  });
});

// ── GET /movements — global movement ledger (audit), filterable + paginated ──
// Backs the Inventory Reports "Movements" dataset. Defined BEFORE GET /:id so
// the literal "movements" path isn't swallowed as an :id. inv_movements is
// large (thousands of rows) and grows unbounded, so this is server-paginated
// rather than loaded in full client-side.
router.get("/movements", requireAuth, requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Procurement"]), async (req, res) => {
  const { action, q, dateFrom, dateTo, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 1000);
  const offset = (pageNum - 1) * sizeNum;

  const filters: string[] = ["1=1"];
  const params: any[] = [];
  if (action)   { filters.push("m.action = ?");        params.push(action); }
  if (dateFrom) { filters.push("m.created_at >= ?");   params.push(dateFrom); }
  if (dateTo)   { filters.push("m.created_at <= ?");   params.push(dateTo + "T23:59:59.999Z"); }
  if (q) {
    filters.push("(i.imei LIKE ? OR i.serial_number LIKE ? OR p.product_code LIKE ? OR p.product_name LIKE ? OR p.device_model LIKE ? OR m.performed_by_email LIKE ?)");
    const like = `%${q}%`; params.push(like, like, like, like, like, like);
  }
  const where = `WHERE ${filters.join(" AND ")}`;
  const fromJoin = `FROM inv_movements m
     LEFT JOIN inv_items i ON i.id = m.item_id
     LEFT JOIN inv_product_catalog p ON p.id = m.product_id`;
  const rows = await pgAll(
    `SELECT m.id, m.action, m.from_status, m.to_status, m.from_location, m.to_location,
            m.performed_by_email, m.notes, m.created_at,
            i.imei, i.serial_number,
            p.product_code, p.product_name, p.device_model
     ${fromJoin} ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet<{ total: string }>(`SELECT COUNT(*) AS total ${fromJoin} ${where}`, params);
  return ok(res, { data: rows, meta: { total: Number(totalRow?.total ?? 0) } });
});

// ── GET / — list items ─────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const { productId, status, q, customerId, installationId, dateFrom, dateTo, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 500);
  const offset  = (pageNum - 1) * sizeNum;

  const filters = ["i.deleted_at IS NULL"];
  const params: any[] = [];

  const { categoryId } = req.query as any;
  if (productId)      { filters.push("i.product_id = ?");       params.push(productId); }
  if (status === "AssignedToJob") {
    // Virtual status: device is out on an active (non-completed) installation job.
    // Not a real inv_items.status value — derived from status + a live ticket link,
    // same pattern as the existing Transferred/Issued split in displayStatus().
    filters.push(
      `i.status = 'Issued for Installation' AND i.installation_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM installation_tickets it2
         WHERE it2.id = i.installation_id AND it2.status NOT IN ('Completed','Closed')
       )`
    );
  } else if (status)  { filters.push("i.status = ?");           params.push(status); }
  if (customerId)     { filters.push("i.customer_id = ?");      params.push(customerId); }
  if (installationId) { filters.push("i.installation_id = ?");  params.push(installationId); }
  if (categoryId)     { filters.push("p.category_id = ?");      params.push(categoryId); }
  if (dateFrom)       { filters.push("i.created_at >= ?");      params.push(dateFrom); }
  if (dateTo)         { filters.push("i.created_at <= ?");      params.push(dateTo + "T23:59:59.999Z"); }
  const { issuedToId } = req.query as any;
  if (issuedToId) {
    // Resolve across user_account_id, hr_employee_id, and email so the custody page
    // (which sends users.id) matches items issued via the hr_employee_id in the roster,
    // even when user_account_id is not yet linked in the roster.
    filters.push(`(i.issued_to_id = ? OR i.issued_to_id IN (
      SELECT COALESCE(r.hr_employee_id, r.id)
      FROM technical_team_roster r
      WHERE r.user_account_id = ?
         OR (r.user_account_id IS NULL AND r.email IN (
               SELECT u.email FROM users u WHERE u.id = ?
             ))
    ))`);
    params.push(issuedToId, issuedToId, issuedToId);
  }
  if (q) {
    filters.push("(i.serial_number LIKE ? OR i.imei LIKE ? OR i.sim_phone LIKE ? OR p.device_model LIKE ? OR p.product_code LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const where = `WHERE ${filters.join(" AND ")}`;
  const rows = await pgAll(
    `SELECT i.*, p.product_code, p.product_name, p.device_model, p.warranty_months, p.requires_sim,
            c.name as category_name, s.supplier_name,
            COALESCE(b.batch_number, i.batch_ref, CASE WHEN i.notes LIKE 'Batch: %' THEN SUBSTR(i.notes, 8) END) as batch_number,
            t.ticket_no, t.customer_name AS job_customer_name,
            t.vehicle_registration AS job_vehicle_reg, t.status AS job_status,
            COALESCE(tu.name, t.assigned_to_email) AS technician_name, t.assigned_to_email AS technician_email,
            t.iso_name, t.iso_email,
            COALESCE(t.engineer_signed_off_at, t.technician_signed_off_at) AS installation_date,
            COALESCE(su.name, rl.sales_rep_name, cu.name) AS sales_rep_name,
            -- Deal/finance context, resolved via the retail lead → quote →
            -- proforma → invoice chain (same path the sales reports use).
            rl.bank_partner_name AS partner_bank,
            q.loan_term_months  AS loan_term_months,
            q.total_amount      AS quote_amount,
            inv.invoice_number  AS invoice_no,
            inv.status          AS invoice_status,
            sim.iccid AS paired_sim_iccid, sim.msisdn AS paired_sim_msisdn,
            u.email as received_by_email
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     JOIN inv_product_categories c ON c.id = p.category_id
     LEFT JOIN inv_suppliers s ON s.id = i.supplier_id
     LEFT JOIN inv_procurement_batches b ON b.id = i.batch_id
     LEFT JOIN LATERAL (
       SELECT * FROM installation_tickets t2
       WHERE t2.id = i.installation_id OR t2.assigned_device_id = i.id
       ORDER BY t2.created_at DESC LIMIT 1
     ) t ON true
     LEFT JOIN users tu ON tu.id = t.assigned_to_user_id
     -- Sales rep: retail_lead_id covers 323 of 324 tickets (this business is
     -- almost entirely retail-driven); created_by_user_id is a full-coverage
     -- fallback for the remainder (corporate/invoice-raised tickets, which
     -- have no retail_leads row to pull a rep from). retail_leads.sales_rep_name
     -- is a denormalized text snapshot that's often just an email (confirmed
     -- live) — prefer resolving the real name via sales_rep_id -> users.name,
     -- falling back to the raw snapshot only if that user record is gone.
     LEFT JOIN retail_leads rl ON rl.id = t.retail_lead_id
     LEFT JOIN users su ON su.id = rl.sales_rep_id
     LEFT JOIN users cu ON cu.id = t.created_by_user_id
     LEFT JOIN crm_quotes q ON q.id = rl.quote_id AND q.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT * FROM crm_proforma_invoices pf2
       WHERE pf2.quote_id = q.id AND pf2.deleted_at IS NULL
       ORDER BY pf2.created_at DESC LIMIT 1
     ) pf ON true
     LEFT JOIN invoices inv ON inv.id = pf.invoice_id
     LEFT JOIN inv_sims sim ON sim.device_item_id = i.id AND sim.deleted_at IS NULL
     LEFT JOIN users u ON u.id = i.received_by_user_id
     ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(
    `SELECT COUNT(*) as total
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     JOIN inv_product_categories c ON c.id = p.category_id
     ${where}`,
    params
  );

  return ok(res, { data: rows, meta: { total: Number(totalRow?.total ?? 0) } });
});

// ── POST / — receive single item ───────────────────────────────────────────────
router.post("/",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Procurement"]),
  async (req: AuthRequest, res) => {
    const {
      productId, serialNumber, imei, macAddress, supplierId, supplierRef,
      batchId, purchaseDate, purchasePrice, warehouseLocation, simPhone, simSerial, notes,
    } = req.body;

    if (!productId) return errorResponse(res, 400, "MISSING_FIELD", "productId is required.");

    const product = await pgGet(
      "SELECT id, warranty_months FROM inv_product_catalog WHERE id = ? AND deleted_at IS NULL", [productId]
    );
    if (!product) return errorResponse(res, 404, "NOT_FOUND", "Product not found.");

    // Check uniqueness of IMEI / serial
    if (imei) {
      const dup = await pgGet("SELECT id FROM inv_items WHERE imei = ? AND deleted_at IS NULL", [imei]);
      if (dup) return errorResponse(res, 409, "DUPLICATE", `IMEI ${imei} already exists in inventory.`);
    }
    if (serialNumber) {
      const dup = await pgGet("SELECT id FROM inv_items WHERE serial_number = ? AND deleted_at IS NULL", [serialNumber]);
      if (dup) return errorResponse(res, 409, "DUPLICATE", `Serial number ${serialNumber} already exists.`);
    }

    const now = new Date().toISOString();
    const warrantyExpires = purchaseDate && product.warranty_months
      ? new Date(new Date(purchaseDate).setMonth(new Date(purchaseDate).getMonth() + product.warranty_months)).toISOString()
      : null;

    const id = uuidv4();
    await pgRun(
      `INSERT INTO inv_items
         (id,product_id,serial_number,imei,mac_address,supplier_id,supplier_ref,batch_id,
          purchase_date,purchase_price,warehouse_location,status,sim_phone,sim_serial,
          warranty_expires_at,notes,created_by_user_id,received_by_user_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, productId, serialNumber||null, imei||null, macAddress||null,
       supplierId||null, supplierRef||null, batchId||null,
       purchaseDate||null, purchasePrice||null, warehouseLocation||null,
       "In Stock", simPhone||null, simSerial||null, warrantyExpires,
       notes||null, req.user!.id, req.user!.id, now, now]
    );

    await logMovement(
      id, productId, "RECEIVED", null, "In Stock",
      "Supplier", warehouseLocation || "Warehouse",
      req.user!.id, req.user!.email || "", notes
    );

    auditLog(req, "INV_ITEM_RECEIVED", "inv_items", "Info", { id, imei, serialNumber }).catch(console.error);
    const item = await pgGet("SELECT * FROM inv_items WHERE id = ?", [id]);
    return created(res, { data: item }, "Device received into inventory.");
  }
);

// ── POST /check-duplicates — pre-flight IMEI/serial check ────────────────────
router.post("/check-duplicates",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Procurement"]),
  async (req: AuthRequest, res) => {
    const { imeis } = req.body as { imeis?: string[] };
    if (!Array.isArray(imeis) || !imeis.length)
      return errorResponse(res, 400, "MISSING_FIELD", "imeis array required.");

    const placeholders = imeis.map(() => "?").join(",");
    const rows = await pgAll(
      `SELECT imei FROM inv_items WHERE imei IN (${placeholders}) AND deleted_at IS NULL`,
      imeis
    );
    const duplicates = rows.map((r: any) => r.imei).filter(Boolean);
    return ok(res, { duplicates });
  }
);

// ── POST /bulk — bulk receive from GRN ────────────────────────────────────────
router.post("/bulk",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Procurement"]),
  async (req: AuthRequest, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length)
      return errorResponse(res, 400, "MISSING_FIELD", "items array required.");

    // Auto-generated once for the whole request — every item received
    // together in this call is the same physical batch, and every batch
    // number should carry a readable date regardless of intake path (see
    // inventory-procurement.ts's nextBatchNo, same shared counting logic).
    // Replaces the old free-typed batchRef field, which had no format
    // enforcement at all.
    const batchRef = await nextDatedBatchNumber("GRB", [
      { table: "inv_procurement_batches", column: "batch_number" },
      { table: "inv_items", column: "batch_ref", distinct: true },
    ]);

    const results: any[] = [];
    const errors: any[] = [];

    for (const item of items) {
      try {
        const { productId, serialNumber, imei, batchId, purchaseDate, purchasePrice, warehouseLocation, notes } = item;
        if (!productId) { errors.push({ item, error: "productId required" }); continue; }
        const product = await pgGet("SELECT warranty_months, identifier_type FROM inv_product_catalog WHERE id = ?", [productId]);
        const idType: string = product?.identifier_type || "both";
        // Enforce IMEI format for products that require it
        if ((idType === "imei" || idType === "both") && imei) {
          if (!/^\d{14,16}$/.test(imei))
            { errors.push({ item, error: `Invalid IMEI format: ${imei} (must be 14–16 digits)` }); continue; }
        }
        if (idType === "imei" && !imei)
          { errors.push({ item, error: "This product requires an IMEI number" }); continue; }
        if (idType === "serial" && imei)
          { errors.push({ item, error: "This product uses serial numbers, not IMEI" }); continue; }
        if (imei) {
          const dup = await pgGet("SELECT id FROM inv_items WHERE imei = ? AND deleted_at IS NULL", [imei]);
          if (dup) { errors.push({ item, error: `IMEI ${imei} already exists in inventory` }); continue; }
        }
        const warrantyExpires = purchaseDate && product?.warranty_months
          ? new Date(new Date(purchaseDate).setMonth(new Date(purchaseDate).getMonth() + product.warranty_months)).toISOString()
          : null;
        const now = new Date().toISOString();
        const id = uuidv4();
        await pgRun(
          `INSERT INTO inv_items (id,product_id,serial_number,imei,batch_id,batch_ref,purchase_date,purchase_price,warehouse_location,status,warranty_expires_at,notes,created_by_user_id,received_by_user_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, productId, serialNumber||null, imei||null, batchId||null, batchRef, purchaseDate||null,
           purchasePrice||null, warehouseLocation||null, "In Stock", warrantyExpires,
           notes||null, req.user!.id, req.user!.id, now, now]
        );
        await logMovement(id, productId, "RECEIVED", null, "In Stock", "Supplier", warehouseLocation||"Warehouse", req.user!.id, req.user!.email||"");
        results.push({ id, imei, serialNumber });
      } catch(e: any) { errors.push({ item, error: e.message }); }
    }

    auditLog(req, "INV_BULK_RECEIVED", "inv_items", "Info", { count: results.length, batchRef }).catch(console.error);
    return ok(res, { data: { received: results, errors, batchRef } }, `${results.length} device(s) registered in batch ${batchRef}.`);
  }
);

// ── POST /issue-batch — issue multiple devices to a technician ───────────────
async function nextIssuanceBatchRef(): Promise<string> {
  return nextDatedBatchNumber("ISB", [{ table: "inv_issuance_batches", column: "batch_ref" }]);
}

/**
 * Return every issued_to_id value that could belong to a user.
 *
 * Batches/items may be stored with users.id, hr_employees.id, or
 * technical_team_roster.id as the technician/issued-to identifier.
 * All three are considered equivalent for the same physical person.
 *
 * @param userId        users.id (canonical ERP ID)
 * @param hrEmployeeId  hr_employees.id — already known from req.user (no extra query needed)
 */
async function resolveIssuedToIds(userId: string, hrEmployeeId?: string | null): Promise<string[]> {
  const rows = await pgAll(
    `SELECT r.id AS roster_id, r.hr_employee_id
     FROM technical_team_roster r
     WHERE r.user_account_id = ?
        OR (r.user_account_id IS NULL AND r.email IN (
             SELECT u.email FROM users u WHERE u.id = ?
           ))`,
    [userId, userId]
  ).catch(() => [] as any[]);

  const ids = new Set<string>([userId]);
  if (hrEmployeeId) ids.add(hrEmployeeId);
  for (const r of rows as any[]) {
    if (r.roster_id)     ids.add(r.roster_id);
    if (r.hr_employee_id) ids.add(r.hr_employee_id);
  }
  return [...ids];
}

router.post("/issue-batch",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const { technicianId, technicianName, itemIds } = req.body;
    if (!technicianId || !technicianName)
      return errorResponse(res, 400, "MISSING_FIELD", "technicianId and technicianName are required.");
    if (!Array.isArray(itemIds) || !itemIds.length)
      return errorResponse(res, 400, "MISSING_FIELD", "itemIds array is required.");

    const now = new Date().toISOString();
    const batchId = uuidv4();
    const batchRef = await nextIssuanceBatchRef();

    // Resolve canonical user ID — the Device Ledger may send hr_employee_id; prefer user_account_id
    // so the custody page (which queries by users.id) can find the items.
    // Also enforce that only field Technicians (member_type = 'Technician') can receive devices —
    // ISO staff are not issued physical custody of devices.
    const rosterEntry = await pgGet(
      `SELECT user_account_id, hr_employee_id, id as roster_id, member_type
       FROM technical_team_roster
       WHERE (user_account_id = ? OR hr_employee_id = ? OR id::text = ?)`,
      [technicianId, technicianId, technicianId]
    ).catch(() => null);
    if (!rosterEntry) {
      return errorResponse(res, 400, "INVALID_RECIPIENT",
        "Selected technician was not found in the active technical team roster.");
    }
    if ((rosterEntry as any).member_type !== "Technician") {
      return errorResponse(res, 400, "INVALID_RECIPIENT",
        "Devices can only be issued to field Technicians. ISO staff do not receive physical custody of devices.");
    }
    const canonicalTechId = (rosterEntry as any)?.user_account_id || technicianId;
    const issued: string[] = [];
    const errors: string[] = [];

    await pgRun(
      `INSERT INTO inv_issuance_batches (id, batch_ref, technician_id, technician_name, clerk_user_id, clerk_email, device_count, status, issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?)`,
      [batchId, batchRef, canonicalTechId, technicianName, req.user!.id, req.user!.email || null, itemIds.length, now, now, now]
    );

    for (const itemId of itemIds) {
      const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [itemId]);
      if (!item) { errors.push(`${itemId}: not found`); continue; }
      if (!["In Stock", "Reserved"].includes(item.status)) {
        errors.push(`${item.serial_number || itemId}: status is '${item.status}' — must be In Stock`);
        continue;
      }
      await pgRun(
        `UPDATE inv_items SET status='Issued for Installation',
           issued_to_id=?, issued_to_name=?, issued_at=?, issuance_batch_id=?, updated_at=? WHERE id=?`,
        [canonicalTechId, technicianName, now, batchId, now, itemId]
      );
      await logMovement(
        item.id, item.product_id, "ISSUED_TO_TECHNICIAN", item.status, "Issued for Installation",
        item.warehouse_location, "Field", req.user!.id, req.user!.email || "",
        `Issued to ${technicianName}`
      );
      await pgRun(
        `INSERT INTO inv_checkout_records
           (id,item_id,technician_id,checkout_by_user_id,checkout_at,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), itemId, canonicalTechId, req.user!.id, now, now, now]
      ).catch(() => {});
      issued.push(itemId);
    }

    // Update batch device count to actual issued count
    await pgRun(`UPDATE inv_issuance_batches SET device_count=?, updated_at=? WHERE id=?`, [issued.length, now, batchId]);

    auditLog(req, "INV_BATCH_ISSUED", "inv_issuance_batches", "Info", { batchRef, technicianId, technicianName, count: issued.length }).catch(console.error);
    return ok(res, { data: { batchId, batchRef, issued, errors } }, `${issued.length} device(s) issued to ${technicianName}.`);
  }
);

// ── GET /custody/:technicianId — all devices held by a technician ────────────
router.get("/custody/:technicianId", requireAuth, async (req, res) => {
  const rows = await pgAll(
    `SELECT i.*, p.product_code, p.product_name, p.device_model, p.requires_sim,
            c.name as category_name
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     JOIN inv_product_categories c ON c.id = p.category_id
     WHERE i.issued_to_id = ? AND i.status = 'Issued for Installation' AND i.deleted_at IS NULL
     ORDER BY i.issued_at DESC`,
    [req.params.technicianId]
  );
  return ok(res, { data: rows });
});

// ── GET /issuance-batches — list issuance batches ─────────────────────────────
router.get("/issuance-batches", requireAuth, async (req: AuthRequest, res) => {
  const { technicianId, status } = req.query as any;
  const user = req.user!;
  const conditions: string[] = [];
  const params: any[] = [];

  // "Technical" (the ISO role) is deliberately NOT self-scoped here — ISO staff
  // never receive device custody themselves (see the issuance-block for
  // member_type='ISO'), so scoping them the same as Technician would always
  // return an empty list. They see everyone's batches, same as Admin/etc.,
  // optionally narrowed by ?technicianId=, so they can acknowledge on behalf.
  if (user.role === "Technician") {
    // Build the full set of IDs this user may appear as in technician_id.
    // hrEmployeeId comes directly from req.user (no extra DB round-trip).
    const myIds = await resolveIssuedToIds(user.id, user.hrEmployeeId);
    const placeholders = myIds.map(() => "?").join(",");
    conditions.push(`b.technician_id IN (${placeholders})`);
    params.push(...myIds);
  } else if (technicianId) {
    conditions.push("b.technician_id = ?");
    params.push(technicianId);
  }
  if (status) { conditions.push("b.status = ?"); params.push(status); }

  // ── Backfill: create batch records for items issued before batch-tracking was deployed ──
  // Resolve all issued_to_ids that belong to this viewer
  let techIdsToBackfill: string[] = [];
  if (user.role === "Technician") {
    techIdsToBackfill = await resolveIssuedToIds(user.id, user.hrEmployeeId);
  } else if (technicianId) {
    techIdsToBackfill = [technicianId];
  }

  for (const tid of techIdsToBackfill) {
    const unbatched = await pgAll(
      `SELECT * FROM inv_items
       WHERE issued_to_id = ? AND issuance_batch_id IS NULL
         AND status = 'Issued for Installation' AND deleted_at IS NULL`,
      [tid]
    ).catch(() => []);
    if ((unbatched as any[]).length > 0) {
      const bId = uuidv4();
      const bRef = await nextIssuanceBatchRef();
      const issuedAt = (unbatched as any[])[0].issued_at || new Date().toISOString();
      const techName = (unbatched as any[])[0].issued_to_name || "";
      const now2 = new Date().toISOString();
      await pgRun(
        `INSERT INTO inv_issuance_batches
           (id, batch_ref, technician_id, technician_name, clerk_user_id, clerk_email,
            device_count, status, issued_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?)`,
        [bId, bRef, tid, techName, "system", null, (unbatched as any[]).length, issuedAt, now2, now2]
      ).catch(console.error);
      await pgRun(
        `UPDATE inv_items SET issuance_batch_id = ?, updated_at = ?
         WHERE issued_to_id = ? AND issuance_batch_id IS NULL
           AND status = 'Issued for Installation' AND deleted_at IS NULL`,
        [bId, now2, tid]
      ).catch(console.error);
    }
  }
  // ── End backfill ──

  // 1000, not 200: a self-scoped Technician never had enough of their own
  // batches to hit 200, but ISO/Admin now see the org-wide backlog by design
  // (242 pending at the time this was raised) — 200 was silently truncating it.
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const batches = await pgAll(
    `SELECT b.* FROM inv_issuance_batches b ${where} ORDER BY b.created_at DESC LIMIT 1000`,
    params
  );

  const result = await Promise.all(batches.map(async (b: any) => {
    const devices = await pgAll(
      `SELECT i.id, i.serial_number, i.imei, p.device_model, p.product_name, i.status
       FROM inv_items i
       JOIN inv_product_catalog p ON p.id = i.product_id
       WHERE i.issuance_batch_id = ? AND i.deleted_at IS NULL`,
      [b.id]
    );
    return {
      id: b.id,
      batchRef: b.batch_ref,
      technicianId: b.technician_id,
      technicianName: b.technician_name,
      clerkUserId: b.clerk_user_id,
      clerkEmail: b.clerk_email,
      deviceCount: b.device_count,
      status: b.status,
      acknowledgedAt: b.acknowledged_at || null,
      acknowledgedByUserId: b.acknowledged_by_user_id || null,
      acknowledgedByRole: b.acknowledged_by_role || null,
      rejectionReason: b.rejection_reason || null,
      notes: b.notes || null,
      issuedAt: b.issued_at,
      createdAt: b.created_at,
      devices: devices.map((d: any) => ({
        id: d.id,
        serialNumber: d.serial_number,
        imei: d.imei || null,
        deviceModel: d.device_model || null,
        productName: d.product_name || null,
        status: d.status,
      })),
    };
  }));

  return ok(res, { data: result });
});

// ── POST /issuance-batches/:batchId/acknowledge — technician accepts or rejects
router.post("/issuance-batches/:batchId/acknowledge",
  requireAuth,
  requireRole(["Technician", "Technical", "Admin", "InventoryManager", "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const { action, rejectionReason } = req.body;
    if (!["accept", "reject"].includes(action))
      return errorResponse(res, 400, "INVALID", "action must be 'accept' or 'reject'.");

    const batch = await pgGet(
      `SELECT * FROM inv_issuance_batches WHERE id = ? AND status = 'Pending'`,
      [req.params.batchId]
    );
    if (!batch) return errorResponse(res, 404, "NOT_FOUND", "Batch not found or already processed.");

    // "Technical" (ISO) can acknowledge on any technician's behalf — ISO never
    // holds custody themselves, so they're never in resolveIssuedToIds either;
    // this is the only way they can ever act on this endpoint at all.
    if (!["Admin", "InventoryManager", "WarehouseOfficer", "Technical"].includes(req.user!.role)) {
      // Resolve all IDs that belong to this user (user_account_id and any linked hr_employee_id)
      const myIds = new Set<string>(await resolveIssuedToIds(req.user!.id));
      if (!myIds.has(batch.technician_id))
        return errorResponse(res, 403, "FORBIDDEN", "You can only acknowledge your own issuances.");
    }

    const now = new Date().toISOString();
    // "Technical"/Admin/InventoryManager/WarehouseOfficer acting for someone else's
    // batch is an on-behalf acknowledgement — surfaced distinctly in device history
    // (Movement History drawer) so it's clear a technician didn't self-acknowledge.
    const isOnBehalf = req.user!.role !== "Technician";
    const actorLabel = req.user!.role === "Technical" ? "ISO Office" : req.user!.role;
    const batchItems = await pgAll(
      `SELECT id, product_id FROM inv_items WHERE issuance_batch_id = ? AND deleted_at IS NULL`,
      [batch.id]
    );

    if (action === "accept") {
      await pgRun(
        `UPDATE inv_issuance_batches SET status='Acknowledged', acknowledged_at=?, acknowledged_by_user_id=?, acknowledged_by_role=?, updated_at=? WHERE id=?`,
        [now, req.user!.id, req.user!.role, now, batch.id]
      );
      await pgRun(
        `UPDATE inv_items SET acknowledged_at=?, updated_at=? WHERE issuance_batch_id=? AND deleted_at IS NULL`,
        [now, now, batch.id]
      );
      const ackNote = isOnBehalf
        ? `Acknowledged by ${actorLabel} (${req.user!.email || req.user!.id}) on behalf of ${batch.technician_name}`
        : `Acknowledged by ${batch.technician_name}`;
      for (const it of batchItems as any[]) {
        await logMovement(it.id, it.product_id, "ACKNOWLEDGED", "Issued for Installation", "Issued for Installation",
          null, null, req.user!.id, req.user!.email || "", ackNote, undefined, batch.id).catch(console.error);
      }
      auditLog(req, "INV_ISSUANCE_ACKNOWLEDGED", `inv_issuance_batches:${batch.id}`, "Info",
        { batchRef: batch.batch_ref, technicianId: batch.technician_id,
          onBehalf: req.user!.id !== batch.technician_id, acknowledgedByRole: req.user!.role }).catch(console.error);
      return ok(res, { batchId: batch.id, status: "Acknowledged" }, "Devices accepted into custody.");
    } else {
      const rejNote = isOnBehalf
        ? `Rejected by ${actorLabel} (${req.user!.email || req.user!.id}) on behalf of ${batch.technician_name}${rejectionReason ? ` — ${rejectionReason}` : ""}`
        : `Rejected by ${batch.technician_name}${rejectionReason ? ` — ${rejectionReason}` : ""}`;
      for (const it of batchItems as any[]) {
        await logMovement(it.id, it.product_id, "REJECTED", "Issued for Installation", "In Stock",
          null, null, req.user!.id, req.user!.email || "", rejNote, undefined, batch.id).catch(console.error);
      }
      await pgRun(
        `UPDATE inv_issuance_batches SET status='Rejected', rejection_reason=?, updated_at=? WHERE id=?`,
        [rejectionReason || null, now, batch.id]
      );
      await pgRun(
        `UPDATE inv_items SET status='In Stock', issued_to_id=NULL, issued_to_name=NULL,
           issued_at=NULL, issuance_batch_id=NULL, acknowledged_at=NULL, updated_at=?
         WHERE issuance_batch_id=? AND deleted_at IS NULL`,
        [now, batch.id]
      );
      auditLog(req, "INV_ISSUANCE_REJECTED", `inv_issuance_batches:${batch.id}`, "Info",
        { batchRef: batch.batch_ref, technicianId: batch.technician_id, rejectionReason }).catch(console.error);
      return ok(res, { batchId: batch.id, status: "Rejected" }, "Issuance rejected — devices returned to inventory.");
    }
  }
);

// ── POST /transfer — ISO-assisted device transfer between technicians ────────
// Distinct from /issue-batch: this moves already-issued devices directly from one
// technician's custody to another's without passing back through warehouse "In
// Stock" status. Effective immediately (acknowledged_at set on write) because an
// ISO/Admin/InventoryManager/WarehouseOfficer is physically facilitating the
// handoff between the two technicians — there is no separate pending-acceptance
// step the way a warehouse-to-technician issuance has.
router.post("/transfer",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Technical"]),
  async (req: AuthRequest, res) => {
    const { itemIds, toTechnicianId, toTechnicianName, notes } = req.body;
    if (!toTechnicianId || !toTechnicianName)
      return errorResponse(res, 400, "MISSING_FIELD", "toTechnicianId and toTechnicianName are required.");
    if (!Array.isArray(itemIds) || !itemIds.length)
      return errorResponse(res, 400, "MISSING_FIELD", "itemIds array is required.");

    const rosterEntry = await pgGet(
      `SELECT user_account_id, hr_employee_id, id as roster_id, member_type
       FROM technical_team_roster
       WHERE (user_account_id = ? OR hr_employee_id = ? OR id::text = ?)`,
      [toTechnicianId, toTechnicianId, toTechnicianId]
    ).catch(() => null);
    if (!rosterEntry) {
      return errorResponse(res, 400, "INVALID_RECIPIENT",
        "Receiving technician was not found in the active technical team roster.");
    }
    if ((rosterEntry as any).member_type !== "Technician") {
      return errorResponse(res, 400, "INVALID_RECIPIENT",
        "Devices can only be transferred to field Technicians. ISO staff do not receive physical custody of devices.");
    }
    const canonicalToId = (rosterEntry as any)?.user_account_id || toTechnicianId;

    const now = new Date().toISOString();
    const actorLabel = req.user!.role === "Technical" ? "ISO Office" : req.user!.role;
    const transferred: string[] = [];
    const errors: string[] = [];

    for (const itemId of itemIds) {
      const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [itemId]);
      if (!item) { errors.push(`${itemId}: not found`); continue; }
      if (item.status !== "Issued for Installation" || !item.issued_to_id) {
        errors.push(`${item.serial_number || itemId}: not currently in a technician's custody`);
        continue;
      }
      if (item.installation_id) {
        errors.push(`${item.serial_number || itemId}: already committed to an active job card`);
        continue;
      }
      if (item.issued_to_id === canonicalToId) {
        errors.push(`${item.serial_number || itemId}: already held by ${toTechnicianName}`);
        continue;
      }
      const fromName = item.issued_to_name || "warehouse";
      await pgRun(
        `UPDATE inv_items SET issued_to_id=?, issued_to_name=?, issued_at=?, issuance_batch_id=NULL,
           acknowledged_at=?, updated_at=? WHERE id=?`,
        [canonicalToId, toTechnicianName, now, now, now, itemId]
      );
      await logMovement(
        item.id, item.product_id, "ISO_ASSISTED_TRANSFER", "Issued for Installation", "Issued for Installation",
        fromName, toTechnicianName, req.user!.id, req.user!.email || "",
        `Transferred from ${fromName} to ${toTechnicianName} — assisted by ${actorLabel} (${req.user!.email || req.user!.id})${notes ? `: ${notes}` : ""}`
      );
      transferred.push(itemId);
    }

    auditLog(req, "INV_ISO_ASSISTED_TRANSFER", "inv_items", "Info",
      { toTechnicianId: canonicalToId, toTechnicianName, count: transferred.length, errors: errors.length }).catch(console.error);
    return ok(res, { data: { transferred: transferred.length, errors } },
      `${transferred.length} device(s) transferred to ${toTechnicianName}.`);
  }
);

// ── POST /notify-refill — ISO/Admin nudges Inventory for a device/SIM refill ─
// Manual, on-demand nudge (not a cron) — the underlying custody-warning math
// lives entirely client-side on the Duty Rota page (technical.html), so the
// caller passes the already-computed reasons rather than this endpoint
// recomputing them. Mirrors the targetRole pair used by the legacy (dead-table)
// triggerReorderCheck in device-custody.ts: InventoryManager + Admin.
router.post("/notify-refill",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer", "Technical"]),
  async (req: AuthRequest, res) => {
    const { technicianId, technicianName, reasons } = req.body;
    if (!technicianId || !technicianName)
      return errorResponse(res, 400, "MISSING_FIELD", "technicianId and technicianName are required.");
    if (!Array.isArray(reasons) || !reasons.length)
      return errorResponse(res, 400, "MISSING_FIELD", "reasons array is required.");

    const actorLabel = req.user!.role === "Technical" ? "ISO Office" : req.user!.role;
    const title = `Refill Needed — ${technicianName}`;
    const body = `${reasons.join(" ")} Flagged by ${actorLabel} (${req.user!.email || req.user!.id}).`;
    const link = "/technical.html";

    await Promise.all([
      createNotification({ targetRole: "InventoryManager", type: "warning", title, body, link }),
      createNotification({ targetRole: "Admin", type: "warning", title, body, link }),
    ]);

    auditLog(req, "INV_REFILL_NUDGE", "inv_items", "Info", { technicianId, technicianName, reasons }).catch(console.error);
    return ok(res, {}, `Inventory Manager notified for ${technicianName}.`);
  }
);

// ── GET /deleted — admin-only recycle bin ────────────────────────────────────
router.get("/deleted",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const { q, page = "1", pageSize = "50" } = req.query as any;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
    const offset  = (pageNum - 1) * sizeNum;

    const filters = ["i.deleted_at IS NOT NULL"];
    const params: any[] = [];
    if (q) {
      filters.push("(i.serial_number LIKE ? OR i.imei LIKE ? OR p.product_code LIKE ? OR p.product_name LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const where = `WHERE ${filters.join(" AND ")}`;

    const rows = await pgAll(
      `SELECT i.id, i.imei, i.serial_number, i.status, i.deleted_at, i.notes,
              p.product_code, p.product_name, p.device_model,
              c.name AS category_name,
              u.email AS deleted_by_email,
              m.notes AS delete_reason
       FROM inv_items i
       JOIN inv_product_catalog p ON p.id = i.product_id
       JOIN inv_product_categories c ON c.id = p.category_id
       LEFT JOIN users u ON u.id = i.created_by_user_id
       LEFT JOIN inv_movements m ON m.item_id = i.id AND m.action = 'DELETED'
       ${where}
       ORDER BY i.deleted_at DESC LIMIT ? OFFSET ?`,
      [...params, sizeNum, offset]
    );
    const totalRow = await pgGet(
      `SELECT COUNT(*) as total FROM inv_items i
       JOIN inv_product_catalog p ON p.id = i.product_id
       JOIN inv_product_categories c ON c.id = p.category_id
       ${where}`, params
    );
    return ok(res, { data: rows, meta: { total: Number(totalRow?.total ?? 0) } });
  }
);

// ── GET /:id ───────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  const item = await pgGet(
    `SELECT i.*, p.product_code, p.product_name, p.device_model, p.warranty_months,
            p.purchase_price as catalog_purchase_price, p.sale_price as catalog_sale_price,
            c.name as category_name, s.supplier_name,
            COALESCE(b.batch_number, i.batch_ref, CASE WHEN i.notes LIKE 'Batch: %' THEN SUBSTR(i.notes, 8) END) as batch_number,
            t.ticket_no, t.customer_id AS job_customer_id, t.customer_name AS job_customer_name,
            t.vehicle_registration AS job_vehicle_reg, t.status AS job_status,
            t.invoice_id AS job_invoice_id, inv.invoice_number AS job_invoice_number
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     JOIN inv_product_categories c ON c.id = p.category_id
     LEFT JOIN inv_suppliers s ON s.id = i.supplier_id
     LEFT JOIN inv_procurement_batches b ON b.id = i.batch_id
     LEFT JOIN installation_tickets t ON t.assigned_device_id = i.id OR (t.id = i.installation_id AND i.installation_id IS NOT NULL)
     LEFT JOIN invoices inv ON inv.id = t.invoice_id
     WHERE i.id = ? AND i.deleted_at IS NULL`, [req.params.id]
  );
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");

  // Full movement history
  const movements = await pgAll(
    "SELECT * FROM inv_movements WHERE item_id = ? ORDER BY created_at DESC", [req.params.id]
  );

  return ok(res, { data: { ...item, movements } });
});

// ── POST /:id/checkout — issue for installation ────────────────────────────────
router.post("/:id/checkout",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
    if (!["In Stock", "Reserved"].includes(item.status))
      return errorResponse(res, 400, "INVALID_STATUS", `Cannot check out item with status '${item.status}'.`);

    const { installationTicketId, technicianId, technicianEmail, simPhone, notes } = req.body;
    const now = new Date().toISOString();

    await pgRun(
      `UPDATE inv_items SET status='Issued for Installation', installation_id=COALESCE(?,installation_id),
       sim_phone=COALESCE(?,sim_phone), updated_at=? WHERE id=?`,
      [installationTicketId||null, simPhone||null, now, item.id]
    );
    await logMovement(
      item.id, item.product_id, "CHECKOUT", item.status, "Issued for Installation",
      item.warehouse_location, "Field", req.user!.id, req.user!.email||"",
      notes, installationTicketId
    );
    await pgRun(
      `INSERT INTO inv_checkout_records
         (id,item_id,installation_ticket_id,technician_id,technician_email,sim_phone,checkout_by_user_id,checkout_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), item.id, installationTicketId||null, technicianId||null, technicianEmail||null,
       simPhone||null, req.user!.id, now, now, now]
    );

    auditLog(req, "INV_ITEM_CHECKOUT", "inv_items", "Info", { id: item.id, installationTicketId }).catch(console.error);
    return ok(res, null, "Device checked out for installation.");
  }
);

// ── POST /:id/checkin — return device ─────────────────────────────────────────
router.post("/:id/checkin",
  requireAuth,
  requireRole(["Admin", "InventoryManager", "WarehouseOfficer"]),
  async (req: AuthRequest, res) => {
    const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");

    const { returnReason, warehouseLocation, notes } = req.body;
    if (!returnReason)
      return errorResponse(res, 400, "MISSING_FIELD", "returnReason required.");

    const now = new Date().toISOString();
    const newStatus = returnReason === "Defective" ? "Defective" : "Returned";

    await pgRun(
      `UPDATE inv_items SET status=?, warehouse_location=COALESCE(?,warehouse_location),
       installation_id=NULL, updated_at=? WHERE id=?`,
      [newStatus, warehouseLocation||null, now, item.id]
    );
    await logMovement(
      item.id, item.product_id, "CHECKIN", item.status, newStatus,
      "Field", warehouseLocation||item.warehouse_location, req.user!.id, req.user!.email||"",
      `Return reason: ${returnReason}. ${notes||""}`
    );
    // Update latest open checkout record
    await pgRun(
      `UPDATE inv_checkout_records SET checkin_at=?, checkin_by_user_id=?, return_reason=?, updated_at=?
       WHERE item_id=? AND checkin_at IS NULL`,
      [now, req.user!.id, returnReason, now, item.id]
    );

    auditLog(req, "INV_ITEM_CHECKIN", "inv_items", "Warning", { id: item.id, returnReason }).catch(console.error);
    return ok(res, null, `Device checked in with status '${newStatus}'.`);
  }
);

// ── POST /:id/reserve ──────────────────────────────────────────────────────────
router.post("/:id/reserve", requireAuth, requireRole(["Admin", "InventoryManager", "Sales"]), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  if (item.status !== "In Stock")
    return errorResponse(res, 400, "INVALID_STATUS", "Only 'In Stock' items can be reserved.");
  const now = new Date().toISOString();
  await pgRun("UPDATE inv_items SET status='Reserved', updated_at=? WHERE id=?", [now, item.id]);
  await logMovement(item.id, item.product_id, "RESERVED", "In Stock", "Reserved", item.warehouse_location, item.warehouse_location, req.user!.id, req.user!.email||"", req.body.notes);
  return ok(res, null, "Device reserved.");
});

// ── POST /:id/install — mark as installed ─────────────────────────────────────
router.post("/:id/install", requireAuth, requireRole(["Admin", "InventoryManager", "Technical", "Technician"]), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  if (item.status !== "Issued for Installation")
    return errorResponse(res, 400, "INVALID_STATUS", "Device must be 'Issued for Installation' to mark installed.");
  const { customerId, activatedAt } = req.body;
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE inv_items SET status='Installed', customer_id=COALESCE(?,customer_id),
     activated_at=COALESCE(?,activated_at), deployed_at=?, updated_at=? WHERE id=?`,
    [customerId||null, activatedAt||null, now, now, item.id]
  );
  await logMovement(item.id, item.product_id, "INSTALLED", "Issued for Installation", "Installed", "Field", "Customer Site", req.user!.id, req.user!.email||"");
  auditLog(req, "INV_ITEM_INSTALLED", "inv_items", "Info", { id: item.id, customerId }).catch(console.error);
  return ok(res, null, "Device marked as installed.");
});

// ── POST /:id/mark-defective ───────────────────────────────────────────────────
router.post("/:id/mark-defective", requireAuth, requireRole(["Admin", "InventoryManager", "Technical", "Technician", "WarehouseOfficer"]), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  const { notes, defectTicketId } = req.body;
  const now = new Date().toISOString();
  await pgRun(
    "UPDATE inv_items SET status='Defective', defect_ticket_id=COALESCE(?,defect_ticket_id), updated_at=? WHERE id=?",
    [defectTicketId||null, now, item.id]
  );
  await logMovement(item.id, item.product_id, "MARKED_DEFECTIVE", item.status, "Defective", null, null, req.user!.id, req.user!.email||"", notes);
  auditLog(req, "INV_ITEM_DEFECTIVE", "inv_items", "Warning", { id: item.id }).catch(console.error);
  return ok(res, null, "Device marked as defective.");
});

// ── POST /:id/send-to-supplier ─────────────────────────────────────────────────
router.post("/:id/send-to-supplier", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  const { notes } = req.body;
  const now = new Date().toISOString();
  await pgRun("UPDATE inv_items SET status='Sent to Supplier', updated_at=? WHERE id=?", [now, item.id]);
  await logMovement(item.id, item.product_id, "SENT_TO_SUPPLIER", item.status, "Sent to Supplier", "Warehouse", "Supplier", req.user!.id, req.user!.email||"", notes);
  auditLog(req, "INV_ITEM_SENT_SUPPLIER", "inv_items", "Info", { id: item.id }).catch(console.error);
  return ok(res, null, "Device sent to supplier.");
});

// ── PATCH /:id — update item notes/location ────────────────────────────────────
router.patch("/:id", requireAuth, requireRole(["Admin", "InventoryManager", "WarehouseOfficer"]), async (req: AuthRequest, res) => {
  const item = await pgGet("SELECT id FROM inv_items WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  const { warehouseLocation, simPhone, simSerial, notes } = req.body;
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE inv_items SET warehouse_location=COALESCE(?,warehouse_location),
     sim_phone=COALESCE(?,sim_phone), sim_serial=COALESCE(?,sim_serial),
     notes=COALESCE(?,notes), updated_at=? WHERE id=?`,
    [warehouseLocation||null, simPhone||null, simSerial||null, notes||null, now, req.params.id]
  );
  return ok(res, null, "Item updated.");
});

// ── GET /:id/movements ─────────────────────────────────────────────────────────
router.get("/:id/movements", requireAuth, async (req, res) => {
  const item = await pgGet("SELECT id FROM inv_items WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");
  const movements = await pgAll("SELECT * FROM inv_movements WHERE item_id = ? ORDER BY created_at DESC", [req.params.id]);
  return ok(res, { data: movements });
});

// ── POST /:id/restore — admin-only restore from recycle bin ───────────────────
router.post("/:id/restore",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NOT NULL", [req.params.id]);
    if (!item) return errorResponse(res, 404, "NOT_FOUND", "Deleted item not found.");

    const now = new Date().toISOString();
    // Restore to In Stock regardless of previous status (safe default)
    await pgRun(
      "UPDATE inv_items SET deleted_at=NULL, status='In Stock', updated_at=? WHERE id=?",
      [now, item.id]
    );
    await logMovement(
      item.id, item.product_id, "RESTORED", "Deleted", "In Stock", null, null,
      req.user!.id, req.user!.email || "", "Restored from recycle bin by admin"
    );
    auditLog(req, "INV_ITEM_RESTORED", "inv_items", "Info",
      { id: item.id, imei: item.imei, serialNumber: item.serial_number }
    ).catch(console.error);
    return ok(res, null, "Device restored to inventory as In Stock.");
  }
);

// ── DELETE /:id/purge — admin-only permanent hard delete ──────────────────────
router.delete("/:id/purge",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NOT NULL", [req.params.id]);
    if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found in recycle bin. Only soft-deleted items can be purged.");

    // Hard delete: remove item and all its movements
    await pgRun("DELETE FROM inv_movements WHERE item_id=?", [item.id]);
    await pgRun("DELETE FROM inv_items WHERE id=?", [item.id]);

    auditLog(req, "INV_ITEM_PURGED", "inv_items", "Critical",
      { id: item.id, imei: item.imei, serialNumber: item.serial_number }
    ).catch(console.error);
    return ok(res, null, "Device permanently purged from system.");
  }
);

// ── DELETE /:id — admin-only soft delete ──────────────────────────────────────
router.delete("/:id",
  requireAuth,
  requireRole(ROLE_GROUPS.ADMIN_ONLY),
  async (req: AuthRequest, res) => {
    const item = await pgGet("SELECT * FROM inv_items WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!item) return errorResponse(res, 404, "NOT_FOUND", "Item not found.");

    // Only allow deletion of items not currently installed or issued in the field
    if (["Installed", "Issued for Installation"].includes(item.status)) {
      return errorResponse(res, 400, "INVALID_STATUS",
        `Cannot delete a device with status '${item.status}'. Return it to inventory first.`);
    }

    const { reason } = req.body as { reason?: string };
    const noteText = reason ? `Deleted by admin: ${reason}` : "Deleted by admin";
    const now = new Date().toISOString();
    await pgRun("UPDATE inv_items SET deleted_at=?, updated_at=? WHERE id=?", [now, now, item.id]);
    await logMovement(
      item.id, item.product_id, "DELETED", item.status, null, null, null,
      req.user!.id, req.user!.email || "", noteText
    );
    auditLog(req, "INV_ITEM_DELETED", "inv_items", "Critical",
      { id: item.id, imei: item.imei, serialNumber: item.serial_number, status: item.status, reason: reason || null }
    ).catch(console.error);
    return ok(res, null, "Device deleted from inventory.");
  }
);

// ── GET /by-imei/:imei ─────────────────────────────────────────────────────────
router.get("/by-imei/:imei", requireAuth, async (req, res) => {
  const item = await pgGet(
    `SELECT i.*, p.product_code, p.product_name, p.device_model, c.name as category_name,
            s.id as supplier_id, s.supplier_name
     FROM inv_items i
     JOIN inv_product_catalog p ON p.id = i.product_id
     JOIN inv_product_categories c ON c.id = p.category_id
     LEFT JOIN inv_suppliers s ON s.id = i.supplier_id
     WHERE i.imei = ? AND i.deleted_at IS NULL`, [req.params.imei]
  );
  if (!item) return errorResponse(res, 404, "NOT_FOUND", "No item found with that IMEI.");
  return ok(res, { data: item });
});

export default router;
