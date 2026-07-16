/**
 * One-time load from the legacy IDTS MySQL database (idts_mysql) into the new,
 * isolated finemark_archive Postgres database. Read-only against the source;
 * idempotent against the target (upsert on each table's original legacy id),
 * so it's safe to re-run before the final cutover snapshot.
 *
 * Run inside finemark-dev-backend (has ts-node + reaches both DBs by container name):
 *   docker exec finemark-dev-backend npx ts-node --esm src/scripts/archiveEtl.ts
 */
import mysql from "mysql2/promise";
import pg from "pg";
import { v4 as uuidv4 } from "uuid";

const MYSQL_CONFIG = {
  host: process.env.IDTS_MYSQL_HOST || "idts_mysql",
  port: Number(process.env.IDTS_MYSQL_PORT || 3306),
  user: process.env.IDTS_MYSQL_USER || "pnlpyamy_finemark",
  password: process.env.IDTS_MYSQL_PASSWORD || "P?YjNx%N[XGp",
  database: process.env.IDTS_MYSQL_DATABASE || "pnlpyamy_finemarktracking",
};

const PG_CONFIG = {
  host: process.env.PG_HOST || "db",
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || "finemark",
  password: process.env.PG_PASSWORD || "finemark_secret",
  database: process.env.ARCHIVE_PG_DATABASE || "finemark_archive",
};

const counts: Record<string, number> = {};

// ── Transform helpers ─────────────────────────────────────────────────────────

/** "6/17/2026" or "06/17/2026" -> "2026-06-17". Rejects anything not date-shaped. */
function parseUsDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^([0-1]?[0-9])\/([0-3]?[0-9])\/([0-9]{4})$/.exec(raw.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  // Guard against e.g. 02/30 rolling over to March in the JS Date parser.
  const d = new Date(iso + "T00:00:00Z");
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  return iso;
}

/** Mirrors sales2.php's normalizeBankName(): collapses co-op typos, lowercased key. */
function normalizeBankKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "private") return null; // self-funded, not a financing partner
  const coop = /^(c0-op|c0op|c00p|co-op|coop|c-0p|c-o-p)$/;
  if (coop.test(trimmed)) return "co-op";
  return trimmed;
}

function bankDisplayName(key: string): string {
  if (key === "co-op") return "Co-op";
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

function toNumeric(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const runId = uuidv4();
  const startedAt = new Date().toISOString();
  console.log(`[archiveEtl] run ${runId} starting`);
  console.log(`[archiveEtl] source: mysql://${MYSQL_CONFIG.host}/${MYSQL_CONFIG.database}`);
  console.log(`[archiveEtl] target: postgres://${PG_CONFIG.host}/${PG_CONFIG.database}`);

  const my = await mysql.createConnection(MYSQL_CONFIG);
  const pgPool = new pg.Pool(PG_CONFIG);

  try {
    await loadBanksAndInstallations(my, pgPool);
    await loadRenewals(my, pgPool);
    await loadGadgets(my, pgPool);
    await loadSims(my, pgPool);
    await loadTechnicianAllocations(my, pgPool);
    await loadInvoicesAndItems(my, pgPool);
    await loadPayments(my, pgPool);
    await loadSpeedGovernors(my, pgPool);
    await loadTickets(my, pgPool);
    await loadFaultyGadgets(my, pgPool);
    await loadImeiSwaps(my, pgPool);
    await loadFuelRecords(my, pgPool);
    await loadRecordAudit(my, pgPool);
    await loadRemovedInstallations(my, pgPool);

    await pgPool.query(
      `INSERT INTO archive_load_runs (id, started_at, finished_at, table_counts_json, status)
       VALUES ($1, $2, now(), $3, 'success')`,
      [runId, startedAt, JSON.stringify(counts)],
    );
    console.log("[archiveEtl] done:", counts);
  } catch (err) {
    console.error("[archiveEtl] FAILED:", err);
    await pgPool.query(
      `INSERT INTO archive_load_runs (id, started_at, finished_at, table_counts_json, status, notes)
       VALUES ($1, $2, now(), $3, 'failed', $4)`,
      [runId, startedAt, JSON.stringify(counts), String(err)],
    );
    process.exitCode = 1;
  } finally {
    await my.end();
    await pgPool.end();
  }
}

// ── record10 → archive_banks + archive_installations ──────────────────────────
async function loadBanksAndInstallations(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM record10`);
  console.log(`[archiveEtl] record10: ${rows.length} rows`);

  // Build the bank lookup once from the distinct normalized keys.
  const bankKeys = new Set<string>();
  for (const r of rows) {
    const key = normalizeBankKey(r.Bank);
    if (key) bankKeys.add(key);
  }
  const bankIdByKey = new Map<string, string>();
  for (const key of bankKeys) {
    const id = uuidv4();
    const res = await pg.query(
      `INSERT INTO archive_banks (id, canonical_name, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (canonical_name) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [id, key, bankDisplayName(key)],
    );
    bankIdByKey.set(key, res.rows[0].id);
  }
  counts.archive_banks = bankIdByKey.size;

  let n = 0;
  for (const r of rows) {
    const bankKey = normalizeBankKey(r.Bank);
    const bankId = bankKey ? bankIdByKey.get(bankKey) ?? null : null;
    await pg.query(
      `INSERT INTO archive_installations (
         id, legacy_id, installation_date, installation_date_raw, client_name, sales_person,
         vehicle_reg, model, tracker_number, contact, bank_id, bank_raw, bank_branch,
         tracker_location, technician, tk_status, tracksolid, username, password,
         loan_duration, c_no, expiry_date, expiry_date_raw, imei, logins_confirm,
         telesales_comment, commented_by, updated_by, uploaded_by, amount_quoted
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
         $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
       )
       ON CONFLICT (legacy_id) DO UPDATE SET
         installation_date = EXCLUDED.installation_date, client_name = EXCLUDED.client_name,
         sales_person = EXCLUDED.sales_person, vehicle_reg = EXCLUDED.vehicle_reg,
         model = EXCLUDED.model, tracker_number = EXCLUDED.tracker_number, contact = EXCLUDED.contact,
         bank_id = EXCLUDED.bank_id, bank_raw = EXCLUDED.bank_raw, bank_branch = EXCLUDED.bank_branch,
         tracker_location = EXCLUDED.tracker_location, technician = EXCLUDED.technician,
         tk_status = EXCLUDED.tk_status, tracksolid = EXCLUDED.tracksolid, username = EXCLUDED.username,
         password = EXCLUDED.password, loan_duration = EXCLUDED.loan_duration, c_no = EXCLUDED.c_no,
         expiry_date = EXCLUDED.expiry_date, expiry_date_raw = EXCLUDED.expiry_date_raw, imei = EXCLUDED.imei,
         logins_confirm = EXCLUDED.logins_confirm, telesales_comment = EXCLUDED.telesales_comment,
         commented_by = EXCLUDED.commented_by, updated_by = EXCLUDED.updated_by,
         uploaded_by = EXCLUDED.uploaded_by, amount_quoted = EXCLUDED.amount_quoted`,
      [
        `arch-inst-${r.ID}`, r.ID, parseUsDate(r.INSTALLATION_DATE), r.INSTALLATION_DATE, r.CLIENT_NAME, r.SALES_PERSON,
        r.VEHICLE_REG, r.MODEL, r.TRACKER_NUMBER, r.CONTACT, bankId, r.Bank, r.Bank_Branch,
        r.Tracker_Location, r.TECHNICIAN, r.T_K, r.Tracksolid, r.USERNAME, r.PASSWORD,
        r.LOAN_DURATION, r.C_NO, parseUsDate(r.expiray), r.expiray, r.IMEI, r.logins_confirm,
        r.telesales_comment, r.commented_by, r.UPDATED_BY, r.UPLOADED_BY, toNumeric(r.AMOUNT_QUOTED) ?? 0,
      ],
    );
    n++;
  }
  counts.archive_installations = n;
}

// ── fine_mark_renewals → archive_renewals ──────────────────────────────────────
async function loadRenewals(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM fine_mark_renewals`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_renewals (
         id, legacy_id, installation_legacy_id, vehicle_reg, client_name, renewal_date,
         renewal_duration_years, amount_paid, sales_person, expiry_date, expiry_date_raw
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (legacy_id) DO UPDATE SET
         vehicle_reg = EXCLUDED.vehicle_reg, client_name = EXCLUDED.client_name,
         renewal_date = EXCLUDED.renewal_date, renewal_duration_years = EXCLUDED.renewal_duration_years,
         amount_paid = EXCLUDED.amount_paid, sales_person = EXCLUDED.sales_person,
         expiry_date = EXCLUDED.expiry_date, expiry_date_raw = EXCLUDED.expiry_date_raw`,
      [
        `arch-renew-${r.id}`, r.id, r.id, r.vehicle_reg, r.client_name, r.renewal_date,
        r.renewal_duration_years, toNumeric(r.amount_paid) ?? 0, r.sales, parseUsDate(r.expiry_date), r.expiry_date,
      ],
    );
    n++;
  }
  counts.archive_renewals = n;
}

// ── A_Gadgets → archive_gadgets ────────────────────────────────────────────────
async function loadGadgets(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM A_Gadgets`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_gadgets (imei, batch, gadget_type, price, imsi, arrival_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (imei) DO UPDATE SET
         batch = EXCLUDED.batch, gadget_type = EXCLUDED.gadget_type, price = EXCLUDED.price,
         imsi = EXCLUDED.imsi, arrival_date = EXCLUDED.arrival_date`,
      [r.Gadget_Imei, r.batch, r.Gadget_type, toNumeric(r.Gadget_PRICE), r.IMSI, r.arrival_date],
    );
    n++;
  }
  counts.archive_gadgets = n;
}

// ── IOTSIMCARDS → archive_sims ─────────────────────────────────────────────────
async function loadSims(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM IOTSIMCARDS`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_sims (id, legacy_id, msisdn, imsi, batch)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (legacy_id) DO UPDATE SET msisdn = EXCLUDED.msisdn, imsi = EXCLUDED.imsi, batch = EXCLUDED.batch`,
      [`arch-sim-${r.ID}`, r.ID, r.MSISDN, r.IMSI, r.batch],
    );
    n++;
  }
  counts.archive_sims = n;
}

// ── Technician_Allocations → archive_technician_allocations ────────────────────
async function loadTechnicianAllocations(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM Technician_Allocations`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_technician_allocations (id, legacy_id, gadget_imei, gadget_type, date_of_allocation, technician, imsi)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (legacy_id) DO UPDATE SET
         gadget_imei = EXCLUDED.gadget_imei, gadget_type = EXCLUDED.gadget_type,
         date_of_allocation = EXCLUDED.date_of_allocation, technician = EXCLUDED.technician, imsi = EXCLUDED.imsi`,
      [`arch-talloc-${r.allocation_id}`, r.allocation_id, r.Gadget_Imei, r.Gadget_type, r.date_of_allocation, r.technician, r.IMSI],
    );
    n++;
  }
  counts.archive_technician_allocations = n;
}

// ── invoices + invoice_items → archive_invoices + archive_invoice_items ────────
async function loadInvoicesAndItems(my: mysql.Connection, pg: pg.Pool) {
  const [invoices] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM invoices`);
  let ni = 0;
  for (const r of invoices) {
    await pg.query(
      `INSERT INTO archive_invoices (invoice_no, client_name, rep, invoice_date, vat_mode, subtotal, tax, total, file_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (invoice_no) DO UPDATE SET
         client_name = EXCLUDED.client_name, rep = EXCLUDED.rep, invoice_date = EXCLUDED.invoice_date,
         vat_mode = EXCLUDED.vat_mode, subtotal = EXCLUDED.subtotal, tax = EXCLUDED.tax,
         total = EXCLUDED.total, file_path = EXCLUDED.file_path`,
      [r.invoice_no, r.client_name, r.rep, r.date, r.vat_mode, toNumeric(r.subtotal) ?? 0, toNumeric(r.tax) ?? 0, toNumeric(r.total) ?? 0, r.file_path],
    );
    ni++;
  }
  counts.archive_invoices = ni;

  const [items] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM invoice_items`);
  let nii = 0;
  for (const r of items) {
    await pg.query(
      `INSERT INTO archive_invoice_items (
         id, legacy_id, invoice_no, item, description, quantity, rate, amount, vat, vat_amount,
         description_select, description_custom, display_rate
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (legacy_id) DO UPDATE SET
         invoice_no = EXCLUDED.invoice_no, item = EXCLUDED.item, description = EXCLUDED.description,
         quantity = EXCLUDED.quantity, rate = EXCLUDED.rate, amount = EXCLUDED.amount, vat = EXCLUDED.vat,
         vat_amount = EXCLUDED.vat_amount, description_select = EXCLUDED.description_select,
         description_custom = EXCLUDED.description_custom, display_rate = EXCLUDED.display_rate`,
      [
        `arch-invitem-${r.id}`, r.id, r.invoice_no, r.item, r.description, toNumeric(r.quantity), toNumeric(r.rate),
        toNumeric(r.amount), toNumeric(r.vat) ?? 0, toNumeric(r.vat_amount) ?? 0, r.description_select,
        r.description_custom, toNumeric(r.display_rate),
      ],
    );
    nii++;
  }
  counts.archive_invoice_items = nii;
}

// ── payments → archive_payments ────────────────────────────────────────────────
async function loadPayments(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM payments`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_payments (
         id, legacy_id, payment_method, payment_amount, payment_date, cheque_number, payment_status,
         bankers_commission, sales_commission, technician_commission, gadget_price
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (legacy_id) DO UPDATE SET
         payment_method = EXCLUDED.payment_method, payment_amount = EXCLUDED.payment_amount,
         payment_date = EXCLUDED.payment_date, cheque_number = EXCLUDED.cheque_number,
         payment_status = EXCLUDED.payment_status, bankers_commission = EXCLUDED.bankers_commission,
         sales_commission = EXCLUDED.sales_commission, technician_commission = EXCLUDED.technician_commission,
         gadget_price = EXCLUDED.gadget_price`,
      [
        `arch-pay-${r.payment_id}`, r.payment_id, r.payment_method, toNumeric(r.payment_amount), r.payment_date,
        r.cheque_number, r.payment_status, toNumeric(r.bankers_commission) ?? 0, toNumeric(r.sales_commission) ?? 0,
        toNumeric(r.technician_commission) ?? 0, toNumeric(r.gadget_price),
      ],
    );
    n++;
  }
  counts.archive_payments = n;
}

// ── speedgovernors → archive_speedgovernors ────────────────────────────────────
async function loadSpeedGovernors(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM speedgovernors`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_speedgovernors (id, legacy_id, installation_date, client_name, contact, reg_no, model, device_type, technician, sales_person, comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (legacy_id) DO UPDATE SET
         installation_date = EXCLUDED.installation_date, client_name = EXCLUDED.client_name, contact = EXCLUDED.contact,
         reg_no = EXCLUDED.reg_no, model = EXCLUDED.model, device_type = EXCLUDED.device_type,
         technician = EXCLUDED.technician, sales_person = EXCLUDED.sales_person, comments = EXCLUDED.comments`,
      [`arch-sg-${r.id}`, r.id, r.installation_date, r.client_name, r.contact, r.reg_no, r.model, r.device_type, r.technician, r.sales_person, r.comments],
    );
    n++;
  }
  counts.archive_speedgovernors = n;
}

// ── FINEMARKTICKETS → archive_tickets ──────────────────────────────────────────
async function loadTickets(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM FINEMARKTICKETS`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_tickets (
         id, legacy_id, ticket_number, client_phone, vehicle_reg, support_name, support_phone, ticket_reason,
         status, created_by, created_by_phone, created_date, created_at, updated_at, closed_by, action_taken, closed_at, ticket_type
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (legacy_id) DO UPDATE SET
         ticket_number = EXCLUDED.ticket_number, client_phone = EXCLUDED.client_phone, vehicle_reg = EXCLUDED.vehicle_reg,
         support_name = EXCLUDED.support_name, support_phone = EXCLUDED.support_phone, ticket_reason = EXCLUDED.ticket_reason,
         status = EXCLUDED.status, created_by = EXCLUDED.created_by, created_by_phone = EXCLUDED.created_by_phone,
         created_date = EXCLUDED.created_date, updated_at = EXCLUDED.updated_at, closed_by = EXCLUDED.closed_by,
         action_taken = EXCLUDED.action_taken, closed_at = EXCLUDED.closed_at, ticket_type = EXCLUDED.ticket_type`,
      [
        `arch-ticket-${r.id}`, r.id, r.ticket_number, r.client_phone, r.vehicle_reg, r.support_name, r.support_phone,
        r.ticket_reason, r.status, r.created_by, r.created_by_phone, r.created_date, r.created_at, r.updated_at,
        r.closed_by, r.action_taken, r.closed_at, r.ticket_type,
      ],
    );
    n++;
  }
  counts.archive_tickets = n;
}

// ── faulty_gadgets → archive_faulty_gadgets ────────────────────────────────────
async function loadFaultyGadgets(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM faulty_gadgets`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_faulty_gadgets (
         id, legacy_id, old_imei, installation_date_raw, client_name, sales_person, vehicle_reg, model,
         tracker_number, contact, bank_raw, technician, loan_duration, c_no, expiry_raw, imei, bank_branch,
         tracker_location, faulty_date
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (legacy_id) DO UPDATE SET
         old_imei = EXCLUDED.old_imei, client_name = EXCLUDED.client_name, vehicle_reg = EXCLUDED.vehicle_reg,
         imei = EXCLUDED.imei, faulty_date = EXCLUDED.faulty_date`,
      [
        `arch-faulty-${r.ID}`, r.ID, r.OLD_IMEI, r.INSTALLATION_DATE, r.CLIENT_NAME, r.SALES_PERSON, r.VEHICLE_REG,
        r.MODEL, r.TRACKER_NUMBER, r.CONTACT, r.Bank, r.TECHNICIAN, r.LOAN_DURATION, r.C_NO, r.expiray, r.IMEI,
        r.Bank_Branch, r.Tracker_Location, r.faulty_date,
      ],
    );
    n++;
  }
  counts.archive_faulty_gadgets = n;
}

// ── IMEI_Swap → archive_imei_swaps ─────────────────────────────────────────────
async function loadImeiSwaps(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM IMEI_Swap`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_imei_swaps (id, old_imei, new_imei, table_name, batch, change_timestamp)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ON CONSTRAINT uq_arch_imei_swap DO NOTHING`,
      [uuidv4(), r.old_imei, r.new_imei, r.table_name, r.batch, r.change_timestamp],
    );
    n++;
  }
  counts.archive_imei_swaps = n;
}

// ── finemarkfuelrecord → archive_fuel_records ──────────────────────────────────
async function loadFuelRecords(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM finemarkfuelrecord`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_fuel_records (id, legacy_id, installation_date, client_name, contact, reg_no, model, device_type, tracker_no, technician, sales_person, comments, logins)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (legacy_id) DO UPDATE SET
         installation_date = EXCLUDED.installation_date, client_name = EXCLUDED.client_name, contact = EXCLUDED.contact,
         reg_no = EXCLUDED.reg_no, model = EXCLUDED.model, device_type = EXCLUDED.device_type,
         tracker_no = EXCLUDED.tracker_no, technician = EXCLUDED.technician, sales_person = EXCLUDED.sales_person,
         comments = EXCLUDED.comments, logins = EXCLUDED.logins`,
      [
        `arch-fuel-${r.ID}`, r.ID, r.DATE_OF_INSTALLATION, r.CLIENT_NAME, r.CONTACT, r.REG_NO, r.MODEL,
        r.DEVICE_TYPE, r.TRACKER_NO, r.TECHNICIAN, r.SALES_PERSON, r.COMMENTS, r.LOGINS,
      ],
    );
    n++;
  }
  counts.archive_fuel_records = n;
}

// ── record10_audit → archive_record_audit ──────────────────────────────────────
async function loadRecordAudit(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM record10_audit`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_record_audit (id, legacy_id, installation_legacy_id, changed_by, changed_at, field_name, old_value, new_value, action_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (legacy_id) DO UPDATE SET
         installation_legacy_id = EXCLUDED.installation_legacy_id, changed_by = EXCLUDED.changed_by,
         changed_at = EXCLUDED.changed_at, field_name = EXCLUDED.field_name, old_value = EXCLUDED.old_value,
         new_value = EXCLUDED.new_value, action_summary = EXCLUDED.action_summary`,
      [
        `arch-audit-${r.audit_id}`, r.audit_id, r.record_id, r.changed_by, r.changed_at,
        r.field_name, r.old_value, r.new_value, r.action_summary,
      ],
    );
    n++;
  }
  counts.archive_record_audit = n;
}

// ── record10_archive (deletion log) → archive_removed_installations ────────────
async function loadRemovedInstallations(my: mysql.Connection, pg: pg.Pool) {
  const [rows] = await my.query<mysql.RowDataPacket[]>(`SELECT * FROM record10_archive`);
  let n = 0;
  for (const r of rows) {
    await pg.query(
      `INSERT INTO archive_removed_installations (id, legacy_id, original_legacy_id, client_name, vehicle_reg, imei, installation_date_raw, deleted_by, deletion_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (legacy_id) DO UPDATE SET
         original_legacy_id = EXCLUDED.original_legacy_id, client_name = EXCLUDED.client_name,
         vehicle_reg = EXCLUDED.vehicle_reg, imei = EXCLUDED.imei,
         installation_date_raw = EXCLUDED.installation_date_raw, deleted_by = EXCLUDED.deleted_by,
         deletion_date = EXCLUDED.deletion_date`,
      [
        `arch-removed-${r.archive_id}`, r.archive_id, r.original_ID, r.CLIENT_NAME, r.VEHICLE_REG, r.IMEI,
        r.INSTALLATION_DATE, r.DELETED_BY, r.DELETION_DATE,
      ],
    );
    n++;
  }
  counts.archive_removed_installations = n;
}

main();
