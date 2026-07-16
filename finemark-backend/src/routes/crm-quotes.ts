import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, hasCrmFullVisibility, userCanAccessRecord } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { renderCommercialPdf } from "../utils/commercialPdfTemplate.js";
import { renderQuotePdf } from "../utils/quoteTemplate.js";
import { decryptField } from "../services/cryptoService.js";
import { sendMail } from "../utils/mailer.js";
import { buildQuoteEmail } from "../utils/emailTemplates.js";
import { IdGenerator } from "../utils/idGenerator.js";

const router = Router();
const QUOTE_HOLD_MS = 24 * 60 * 60 * 1000;

// ── Payment options builder ───────────────────────────────────────────────────
async function buildPaymentOptions(
  partnerName: string | null,
  vehicleReg: string | null,
): Promise<Array<{ label: string; value: string }>> {
  const reg = (vehicleReg || "").trim() || "(Vehicle Reg.)";
  const opts: Array<{ label: string; value: string }> = [
    { label: "MPESA PAYBILL",    value: `Paybill: 4048569 | Account: ${reg}` },
    { label: "MPESA TILL NUMBER", value: "Till: 5620852" },
  ];
  if (partnerName) {
    // Use the first significant word as the search key (e.g. "NCBA" from "NCBA Bank Kenya PLC")
    const key = partnerName.trim().split(/\s+/)[0];
    if (key) {
      const bankRow = await pgGet(
        `SELECT account_name, bank_name, account_number FROM bank_accounts
         WHERE is_active = true AND LOWER(bank_name) LIKE LOWER(?) ORDER BY created_at LIMIT 1`,
        [`%${key}%`]
      ).catch(() => null);
      if (bankRow) {
        opts.push({
          label: bankRow.bank_name
            ? `${bankRow.bank_name} — ${bankRow.account_name}`
            : bankRow.account_name,
          value: String(bankRow.account_number),
        });
      }
    }
  }
  return opts;
}

// ── Table bootstrap ──────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_quotes (
    id TEXT PRIMARY KEY,
    quote_no TEXT UNIQUE NOT NULL,
    customer_id TEXT NOT NULL,
    lead_id TEXT,
    sales_rep_id TEXT NOT NULL,
    sales_rep_email TEXT,
    service_type TEXT,
    status TEXT NOT NULL DEFAULT 'Draft',
    revision_no INTEGER NOT NULL DEFAULT 1,
    parent_quote_id TEXT,
    installation_cost REAL NOT NULL DEFAULT 0,
    subscription_fee REAL NOT NULL DEFAULT 0,
    tax_rate REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    expiry_date TEXT,
    notes TEXT,
    approved_at TEXT,
    approved_by TEXT,
    rejected_reason TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[crm_quotes] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS crm_quote_items (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL,
    device_model TEXT NOT NULL,
    device_type TEXT,
    description TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    total_price REAL NOT NULL DEFAULT 0,
    stock_item_id TEXT,
    stock_item_ids TEXT NOT NULL DEFAULT '[]',
    serial_numbers TEXT NOT NULL DEFAULT '[]',
    imei_numbers TEXT NOT NULL DEFAULT '[]',
    product_id TEXT,
    created_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[crm_quote_items] init:", e));

pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_quotes_customer ON crm_quotes(customer_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_quote_items_quote ON crm_quote_items(quote_id)`, []).catch(() => {});

// ── Quote edit history ─────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS crm_quote_edit_history (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL,
    edited_by_user_id TEXT,
    edited_by_name TEXT,
    edited_at TEXT NOT NULL,
    change_summary TEXT,
    before_snapshot TEXT NOT NULL,
    after_snapshot TEXT NOT NULL,
    before_total REAL,
    after_total REAL
  )
`, []).catch(e => console.error("[crm_quote_edit_history] init:", e));
pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_quote_edit_hist ON crm_quote_edit_history(quote_id)`, []).catch(() => {});

// ── Migrate: new quote item columns ────────────────────────────────────
setTimeout(async () => {
  for (const col of [
    "stock_item_ids TEXT NOT NULL DEFAULT '[]'",
    "serial_numbers TEXT NOT NULL DEFAULT '[]'",
    "imei_numbers TEXT NOT NULL DEFAULT '[]'",
    "product_id TEXT",
    "discount_pct REAL DEFAULT 0",
  ]) {
    await pgRun(`ALTER TABLE crm_quote_items ADD COLUMN IF NOT EXISTS ${col}`, []).catch(() => {});
  }
  // Vehicle columns on quotes and proformas
  await pgRun(`ALTER TABLE crm_quotes ADD COLUMN IF NOT EXISTS vehicle_id TEXT`, []).catch(() => {});
  await pgRun(`ALTER TABLE crm_quotes ADD COLUMN IF NOT EXISTS vehicle_registration TEXT`, []).catch(() => {});
  await pgRun(`ALTER TABLE crm_proforma_invoices ADD COLUMN IF NOT EXISTS vehicle_id TEXT`, []).catch(() => {});
  await pgRun(`ALTER TABLE crm_proforma_invoices ADD COLUMN IF NOT EXISTS vehicle_registration TEXT`, []).catch(() => {});
  // Partner pricing columns on quotes
  await pgRun(`ALTER TABLE crm_quotes ADD COLUMN IF NOT EXISTS partner_id TEXT`, []).catch(() => {});
  await pgRun(`ALTER TABLE crm_quotes ADD COLUMN IF NOT EXISTS loan_term_months INTEGER`, []).catch(() => {});
  // Retail auto-quote columns
  await pgRun(`ALTER TABLE crm_quotes ADD COLUMN IF NOT EXISTS installation_ticket_id TEXT`, []).catch(() => {});
  await pgRun(`ALTER TABLE crm_quotes ADD COLUMN IF NOT EXISTS auto_generated INTEGER NOT NULL DEFAULT 0`, []).catch(() => {});
  await pgRun(`ALTER TABLE crm_quotes ADD COLUMN IF NOT EXISTS pricing_missing INTEGER NOT NULL DEFAULT 0`, []).catch(() => {});
  await pgRun(`CREATE INDEX IF NOT EXISTS idx_crm_quotes_install_ticket ON crm_quotes(installation_ticket_id)`, []).catch(() => {});
  // Bill-to toggle — when true, print/PDF uses the linked bank partner's name
  // + bank_financed_pricing.bank_address instead of the customer's own details.
  await pgRun(`ALTER TABLE crm_quotes ADD COLUMN IF NOT EXISTS bill_to_bank INTEGER NOT NULL DEFAULT 0`, []).catch(() => {});
}, 1500);

function calcTotal(installCost: number, subFee: number, taxRate: number, discount: number, qty = 1) {
  const sub = (installCost + subFee) * qty;
  const afterDiscount = sub - discount;
  const tax = afterDiscount * (taxRate / 100);
  return Math.round((afterDiscount + tax) * 100) / 100;
}

function nextQuoteNo(): string {
  return IdGenerator.generateId("quote");
}

// ── ABAC: row-level ownership check ──────────────────────────────────────────
// Full-visibility roles bypass; KAM is scoped via the linked partner's account
// manager; everyone else must be the assigned rep or the original creator.
async function assertQuoteAccess(role: string, userId: string, quote: any): Promise<boolean> {
  if (hasCrmFullVisibility(role)) return true;
  let kamId: string | null = null;
  if (quote.partner_id) {
    const partner = await pgGet(`SELECT key_account_manager_id FROM partners WHERE id::text = ?`, [String(quote.partner_id)]);
    kamId = partner?.key_account_manager_id ?? null;
  }
  return userCanAccessRecord({
    role,
    userId,
    recordOwnerId: quote.sales_rep_id,
    recordCreatorId: quote.created_by_user_id,
    kamId,
  });
}

async function getItems(quoteId: string) {
  return pgAll(`SELECT * FROM crm_quote_items WHERE quote_id = ? ORDER BY created_at`, [quoteId]);
}

function mapItem(r: any) {
  return {
    id: r.id, quoteId: r.quote_id, deviceModel: r.device_model, deviceType: r.device_type,
    description: r.description, quantity: r.quantity, unitPrice: r.unit_price,
    totalPrice: r.total_price, stockItemId: r.stock_item_id,
    stockItemIds: (() => { try { return JSON.parse(r.stock_item_ids || "[]"); } catch { return []; } })(),
    serialNumbers: (() => { try { return JSON.parse(r.serial_numbers || "[]"); } catch { return []; } })(),
    imeiNumbers:   (() => { try { return JSON.parse(r.imei_numbers   || "[]"); } catch { return []; } })(),
    productId: r.product_id,
    discountPct: Number(r.discount_pct || 0),
    createdAt: r.created_at,
  };
}

function mapQuote(row: any, items: any[] = []) {
  return {
    id: row.id, quoteNo: row.quote_no, customerId: row.customer_id, leadId: row.lead_id,
    salesRepId: row.sales_rep_id, salesRepEmail: row.sales_rep_email, salesRepName: row.sales_rep_name || null,
    vehicleId: row.vehicle_id || null, vehicleRegistration: row.vehicle_registration || null,
    vehicleMake: row.vehicle_make || null, vehicleModel: row.vehicle_model || null,
    partnerId: row.partner_id || null, partnerName: row.partner_name || null,
    loanTermMonths: row.loan_term_months || null,
    billToBank: !!row.bill_to_bank,
    serviceType: row.service_type, status: row.status, revisionNo: row.revision_no,
    parentQuoteId: row.parent_quote_id,
    installationCost: row.installation_cost, subscriptionFee: row.subscription_fee,
    taxRate: row.tax_rate, discountAmount: row.discount_amount, totalAmount: row.total_amount,
    expiryDate: row.expiry_date, notes: row.notes,
    approvedAt: row.approved_at, approvedBy: row.approved_by, rejectedReason: row.rejected_reason,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
    items: items.map(mapItem),
  };
}

function collectStockIds(items: any[] = []): string[] {
  const ids = items.flatMap((item: any) => {
    if (Array.isArray(item?.stockItemIds)) return item.stockItemIds.map((id: any) => String(id || "").trim()).filter(Boolean);
    if (item?.stockItemId) return [String(item.stockItemId).trim()];
    return [];
  });
  return Array.from(new Set(ids));
}

async function ensureDevicesReservable(stockIds: string[], quoteId?: string) {
  if (!stockIds.length) return;
  const placeholders = stockIds.map(() => "?").join(",");
  const rows = await pgAll(
    `SELECT id,status,reservation_quote_id FROM inv_items WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    stockIds
  );

  const rowMap = new Map(rows.map((r: any) => [String(r.id), r]));
  const missing = stockIds.filter((id) => !rowMap.has(id));
  if (missing.length) {
    throw new Error(`Selected device(s) not found: ${missing.join(", ")}`);
  }

  const blocked = stockIds.filter((id) => {
    const row: any = rowMap.get(id);
    const isHeldByThisQuote = quoteId && row.status === "Reserved" && row.reservation_quote_id === quoteId;
    return !(row.status === "In Stock" || isHeldByThisQuote);
  });

  if (blocked.length) {
    throw new Error(`Selected device(s) are not available for reservation: ${blocked.join(", ")}`);
  }
}

async function reserveDevicesForQuote(
  stockIds: string[],
  quoteId: string,
  quoteNo: string,
  userId: string,
  userEmail: string,
  nowIso: string,
) {
  if (!stockIds.length) return;
  const reservedUntil = new Date(new Date(nowIso).getTime() + QUOTE_HOLD_MS).toISOString();

  for (const devId of stockIds) {
    await pgRun(
      `UPDATE inv_items
       SET status='Reserved', reserved_until=?, reservation_quote_id=?, updated_at=?
       WHERE id=? AND deleted_at IS NULL`,
      [reservedUntil, quoteId, nowIso, devId]
    );
    await pgRun(
      `INSERT INTO inv_movements (id,item_id,product_id,action,from_status,to_status,performed_by_user_id,performed_by_email,notes,created_at)
       SELECT ?,?,product_id,'QUOTE_RESERVED',status,'Reserved',?,?,?,? FROM inv_items WHERE id=?`,
      [uuidv4(), devId, userId, userEmail, `Reserved for quote ${quoteNo} (24h)`, nowIso, devId]
    );
  }
}

async function releaseQuoteReservations(
  quoteId: string,
  userId: string,
  userEmail: string,
  note: string,
  specificIds?: string[],
) {
  let rows: any[] = [];
  if (specificIds?.length) {
    const placeholders = specificIds.map(() => "?").join(",");
    rows = await pgAll(
      `SELECT id,product_id FROM inv_items
       WHERE id IN (${placeholders}) AND reservation_quote_id=? AND status='Reserved' AND deleted_at IS NULL`,
      [...specificIds, quoteId]
    );
  } else {
    rows = await pgAll(
      `SELECT id,product_id FROM inv_items
       WHERE reservation_quote_id=? AND status='Reserved' AND deleted_at IS NULL`,
      [quoteId]
    );
  }

  if (!rows.length) return;
  const now = new Date().toISOString();
  for (const row of rows) {
    await pgRun(
      `UPDATE inv_items SET status='In Stock', reserved_until=NULL, reservation_quote_id=NULL, updated_at=? WHERE id=?`,
      [now, row.id]
    );
    await pgRun(
      `INSERT INTO inv_movements (id,item_id,product_id,action,from_status,to_status,performed_by_user_id,performed_by_email,notes,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), row.id, row.product_id, "QUOTE_RELEASED", "Reserved", "In Stock", userId, userEmail, note, now]
    );
  }
}

async function refreshQuoteReservations(
  quoteId: string,
  quoteNo: string,
  desiredStockIds: string[],
  userId: string,
  userEmail: string,
  nowIso: string,
) {
  const currentRows = await pgAll(
    `SELECT id FROM inv_items WHERE reservation_quote_id=? AND status='Reserved' AND deleted_at IS NULL`,
    [quoteId]
  );
  const currentSet = new Set(currentRows.map((r: any) => String(r.id)));
  const desiredSet = new Set(desiredStockIds);

  const toRelease = [...currentSet].filter((id) => !desiredSet.has(id));
  const toKeep = [...currentSet].filter((id) => desiredSet.has(id));
  const toReserve = [...desiredSet].filter((id) => !currentSet.has(id));

  if (toReserve.length) {
    await ensureDevicesReservable(toReserve);
    await reserveDevicesForQuote(toReserve, quoteId, quoteNo, userId, userEmail, nowIso);
  }

  if (toKeep.length) {
    const reservedUntil = new Date(new Date(nowIso).getTime() + QUOTE_HOLD_MS).toISOString();
    const placeholders = toKeep.map(() => "?").join(",");
    await pgRun(
      `UPDATE inv_items SET reserved_until=?, updated_at=?
       WHERE id IN (${placeholders}) AND reservation_quote_id=? AND status='Reserved' AND deleted_at IS NULL`,
      [reservedUntil, nowIso, ...toKeep, quoteId]
    );
  }

  if (toRelease.length) {
    await releaseQuoteReservations(quoteId, userId, userEmail, `Released after quote ${quoteNo} items update`, toRelease);
  }
}

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales","Technical"]), async (req: AuthRequest, res) => {
  const { customerId, leadId, status, q, dateFrom, dateTo, rep, page = "1", pageSize = "50" } = req.query as any;
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const sizeNum = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (pageNum - 1) * sizeNum;

  const filters: string[] = ["q.deleted_at IS NULL"];
  const params: any[] = [];

  if (!hasCrmFullVisibility(req.user!.role)) { filters.push("q.sales_rep_id = ?"); params.push(req.user!.id); }
  if (customerId) { filters.push("q.customer_id = ?");                                                    params.push(customerId); }
  if (leadId)     { filters.push("q.lead_id = ?");                                                         params.push(leadId); }
  if (status)     { filters.push("q.status = ?");                                                          params.push(status); }
  if (q)          { filters.push("(q.quote_no ILIKE ? OR COALESCE(i.full_name, corp.company_name) ILIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
  if (dateFrom)   { filters.push("q.created_at >= ?");                                                     params.push(dateFrom); }
  if (dateTo)     { filters.push("q.created_at <= ?");                                                     params.push(dateTo + "T23:59:59.999Z"); }
  if (rep)        { filters.push("(u.name ILIKE ? OR q.sales_rep_email ILIKE ?)");                         params.push(`%${rep}%`, `%${rep}%`); }

  const joinClause = `JOIN crm_customers c ON c.id = q.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     LEFT JOIN users u ON u.id::text = q.sales_rep_id`;
  const where = `WHERE ${filters.join(" AND ")}`;
  const rows = await pgAll(
    `SELECT q.*,
            COALESCE(i.full_name, corp.company_name) as customer_name,
            u.name AS sales_rep_name,
            p.name AS partner_name
     FROM crm_quotes q
     ${joinClause}
     LEFT JOIN partners p ON p.id::text = q.partner_id
     ${where} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`,
    [...params, sizeNum, offset]
  );
  const totalRow = await pgGet(`SELECT COUNT(*) as total FROM crm_quotes q ${joinClause} ${where}`, params);

  const data = await Promise.all(rows.map(async r => ({
    ...mapQuote(r), customerName: r.customer_name,
    itemCount: Number((await pgGet(`SELECT COUNT(*) as cnt FROM crm_quote_items WHERE quote_id = ?`, [r.id]))?.cnt ?? 0),
  })));

  return ok(res, { data, meta: { total: Number(totalRow?.total ?? 0) } });
});

// ── POST / ─ create quote ─────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const {
    customerId, leadId, serviceType, items = [],
    installationCost = 0, subscriptionFee = 0, taxRate = 0, discountAmount = 0,
    expiryDate, notes, vehicleId, loanTermMonths,
  } = req.body;

  if (!customerId) return errorResponse(res, 400, "MISSING_FIELD", "customerId required.");
  // items are optional — quotes can be created with just the summary cost fields

  const cust = await pgGet("SELECT id FROM crm_customers WHERE id = ? AND deleted_at IS NULL", [customerId]);
  if (!cust) return errorResponse(res, 404, "NOT_FOUND", "Customer not found.");

  const requestedStockIds = collectStockIds(items);
  try {
    await ensureDevicesReservable(requestedStockIds);
  } catch (e: any) {
    return errorResponse(res, 409, "STOCK_NOT_AVAILABLE", e?.message || "Selected devices are not available.");
  }

  const now = new Date().toISOString();
  const id = uuidv4();
  const quoteNo = nextQuoteNo();

  // When line items are provided, derive the base cost from them
  let effectiveInstallCost = Number(installationCost);
  let effectiveSubFee = Number(subscriptionFee);
  if (items.length > 0) {
    effectiveInstallCost = items.reduce((sum: number, it: any) => {
      const stockIds: string[] = Array.isArray(it.stockItemIds) ? it.stockItemIds : (it.stockItemId ? [it.stockItemId] : []);
      const qty = stockIds.length > 0 ? stockIds.length : (Number(it.quantity) || 1);
      return sum + (qty * Number(it.unitPrice || 0));
    }, 0);
    effectiveSubFee = 0;
  }
  const total = calcTotal(effectiveInstallCost, effectiveSubFee, Number(taxRate), Number(discountAmount));

  // Lookup vehicle registration from the vehicles table if vehicleId provided
  let vehicleRegistration: string | null = null;
  let effectiveLoanTermMonths: number | null = loanTermMonths ? Number(loanTermMonths) : null;
  if (vehicleId) {
    const veh = await pgGet(`SELECT registration, loan_tenure_months FROM crm_customer_vehicles WHERE id = ?`, [vehicleId]).catch(() => null);
    vehicleRegistration = veh?.registration || null;
    // Auto-populate loan term from vehicle if not explicitly provided
    if (effectiveLoanTermMonths == null && veh?.loan_tenure_months) {
      effectiveLoanTermMonths = Number(veh.loan_tenure_months);
    }
  }

  // Auto-inherit partner_id from the linked lead
  let effectivePartnerId: string | null = null;
  if (leadId) {
    const lead = await pgGet(`SELECT partner_id FROM crm_leads WHERE id = ? AND deleted_at IS NULL`, [leadId]).catch(() => null);
    if (lead?.partner_id) effectivePartnerId = String(lead.partner_id);
  }

  await pgRun(
    `INSERT INTO crm_quotes
       (id,quote_no,customer_id,lead_id,sales_rep_id,sales_rep_email,service_type,status,revision_no,
        installation_cost,subscription_fee,tax_rate,discount_amount,total_amount,expiry_date,notes,
        vehicle_id,vehicle_registration,partner_id,loan_term_months,created_by_user_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,quoteNo,customerId,leadId||null,req.user!.id,req.user!.email,serviceType||null,"Draft",1,
     effectiveInstallCost,effectiveSubFee,taxRate,discountAmount,total,expiryDate||null,notes||null,
     vehicleId||null,vehicleRegistration,effectivePartnerId,effectiveLoanTermMonths,req.user!.id,now,now]
  );

  // Insert line items + reserve devices
  for (const item of items) {
    const stockIds: string[] = Array.isArray(item.stockItemIds) ? item.stockItemIds : (item.stockItemId ? [item.stockItemId] : []);
    const qty = stockIds.length > 0 ? stockIds.length : (Number(item.quantity) || 1);
    const itemTotal = qty * Number(item.unitPrice || 0);

    // Fetch serial/IMEI for display
    let serials: string[] = [];
    let imeis: string[] = [];
    if (stockIds.length > 0) {
      const placeholders = stockIds.map(() => "?").join(",");
      const devRows = await pgAll(`SELECT id, serial_number, imei FROM inv_items WHERE id IN (${placeholders})`, stockIds);
      serials = devRows.map((d: any) => d.serial_number).filter(Boolean);
      imeis   = devRows.map((d: any) => d.imei).filter(Boolean);
    }

    await pgRun(
      `INSERT INTO crm_quote_items
         (id,quote_id,device_model,device_type,description,quantity,unit_price,total_price,
          stock_item_id,stock_item_ids,serial_numbers,imei_numbers,product_id,discount_pct,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), id, item.deviceModel || item.productName || "—", item.deviceType || null,
       item.description || null, qty, item.unitPrice || 0, itemTotal,
       stockIds[0] || null, JSON.stringify(stockIds),
       JSON.stringify(serials), JSON.stringify(imeis),
       item.productId || null, Number(item.discountPct || 0), now]
    );

  }

  await reserveDevicesForQuote(requestedStockIds, id, quoteNo, req.user!.id, req.user!.email || "", now);

  // Link lead if provided
  if (leadId) {
    await pgRun(`UPDATE crm_leads SET converted_to_quote_id = ?, updated_at = ? WHERE id = ?`, [id, now, leadId]);
  }

  const quote = await pgGet("SELECT * FROM crm_quotes WHERE id = ?", [id]);
  const qItems = await getItems(id);
  auditLog(req, "QUOTE_CREATED", "crm_quotes", "Info", { quoteNo, customerId }).catch(console.error);
  return created(res, { data: { ...mapQuote(quote!, qItems) } }, "Quote created.");
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales","Technical"]), async (req: AuthRequest, res) => {
  const row = await pgGet(
    `SELECT q.*, COALESCE(i.full_name, corp.company_name) as customer_name,
            COALESCE(i.kra_pin_enc, corp.kra_pin_enc) as customer_kra_pin_enc,
            i.phone_enc as ind_phone_enc,
            i.email_enc as ind_email_enc,
            i.address_enc as ind_address_enc,
            corp.physical_address as corp_address,
            (SELECT cp.phone_enc FROM crm_contact_persons cp WHERE cp.customer_id = c.id ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) as corp_contact_phone_enc,
            (SELECT cp.email_enc FROM crm_contact_persons cp WHERE cp.customer_id = c.id ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) as corp_contact_email_enc,
            c.type as customer_type,
            u.name AS sales_rep_name,
            p.name AS partner_name,
            bfp.bank_address AS bank_address,
            v.make AS vehicle_make, v.model AS vehicle_model
     FROM crm_quotes q
     JOIN crm_customers c ON c.id = q.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     LEFT JOIN users u ON u.id::text = q.sales_rep_id
     LEFT JOIN partners p ON p.id::text = q.partner_id
     LEFT JOIN bank_financed_pricing bfp ON bfp.partner_id::text = q.partner_id
     LEFT JOIN crm_customer_vehicles v ON v.id = q.vehicle_id AND v.deleted_at IS NULL
     WHERE q.id = ? AND q.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, row))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }
  const items = await getItems(req.params.id);
  const customerKraPin = decryptField(row.customer_kra_pin_enc) || null;
  const customerPhone = decryptField(row.customer_type === 'individual' ? row.ind_phone_enc : row.corp_contact_phone_enc) || null;
  const customerEmail = decryptField(row.customer_type === 'individual' ? row.ind_email_enc : row.corp_contact_email_enc) || null;
  const customerAddress = row.customer_type === 'individual'
    ? (decryptField(row.ind_address_enc) || null)
    : (row.corp_address || null);
  return ok(res, { data: { ...mapQuote(row, items), customerName: row.customer_name, customerKraPin, customerPhone, customerEmail, customerAddress, bankAddress: row.bank_address || null } });
});

router.get("/:id/history", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const quote = await pgGet("SELECT sales_rep_id, created_by_user_id, partner_id FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, quote))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }
  const rows = await pgAll(
    `SELECT id, quote_id, edited_by_user_id, edited_by_name, edited_at, change_summary, before_total, after_total
     FROM crm_quote_edit_history WHERE quote_id = ? ORDER BY edited_at DESC`,
    [req.params.id]
  );
  return ok(res, { data: rows });
});

router.get("/:id/pdf", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales","Technical"]), async (req: AuthRequest, res) => {
  const row = await pgGet(
    `SELECT q.*, COALESCE(i.full_name, corp.company_name) as customer_name,
            COALESCE(i.kra_pin_enc, corp.kra_pin_enc) as customer_kra_pin_enc,
            i.phone_enc as ind_phone_enc,
            i.email_enc as ind_email_enc,
            i.address_enc as ind_address_enc,
            corp.physical_address as corp_address,
            (SELECT cp.phone_enc FROM crm_contact_persons cp WHERE cp.customer_id = c.id ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) as corp_contact_phone_enc,
            (SELECT cp.email_enc FROM crm_contact_persons cp WHERE cp.customer_id = c.id ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) as corp_contact_email_enc,
            c.type as customer_type,
            u.name AS sales_rep_name,
            p.name AS partner_name,
            bfp.bank_address AS bank_address
     FROM crm_quotes q
     JOIN crm_customers c ON c.id = q.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     LEFT JOIN users u ON u.id::text = q.sales_rep_id
     LEFT JOIN partners p ON p.id::text = q.partner_id
     LEFT JOIN bank_financed_pricing bfp ON bfp.partner_id::text = q.partner_id
     WHERE q.id = ? AND q.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, row))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }

  // ── Fetch installation ticket data for detail rows ─────────────────────────
  let ticketSalesRepName: string | null = null;
  let technicianName: string | null = null;
  let jobCardNo: string | null = null;
  let jobCardStatus: string | null = null;
  let installationDate: string | null = null;
  let installationTime: string | null = null;

  if (row.installation_ticket_id) {
    const it = await pgGet(
      "SELECT ticket_no, status, assigned_to_email, technician_signed_off_at, engineer_signed_off_at, assigned_at, retail_lead_id FROM installation_tickets WHERE id = ? AND deleted_at IS NULL",
      [row.installation_ticket_id]
    ).catch(() => null);
    if (it) {
      jobCardNo = it.ticket_no || null;
      jobCardStatus = it.status || null;
      // Technician name via assigned email → users table
      if (it.assigned_to_email) {
        const techUser = await pgGet("SELECT name FROM users WHERE email = ?", [it.assigned_to_email]).catch(() => null);
        technicianName = techUser?.name || it.assigned_to_email;
      }
      // Installation date/time from sign-off or assignment
      const installDt = it.technician_signed_off_at || it.engineer_signed_off_at || it.assigned_at || null;
      if (installDt) {
        const dt = new Date(installDt);
        installationDate = dt.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
        installationTime = dt.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", hour12: true });
      }
      // Override sales rep with the retail lead's rep (the person who submitted the lead)
      if (it.retail_lead_id) {
        const rl = await pgGet("SELECT sales_rep_id FROM retail_leads WHERE id = ?", [it.retail_lead_id]).catch(() => null);
        if (rl?.sales_rep_id) {
          const repUser = await pgGet("SELECT name FROM users WHERE id::text = ?", [String(rl.sales_rep_id)]).catch(() => null);
          if (repUser?.name) ticketSalesRepName = repUser.name;
        }
      }
    }
  }

  // Fetch vehicle details
  let vehicle: { registration?: string; make?: string; model?: string } | null = null;
  if (row.vehicle_id) {
    const veh = await pgGet(
      `SELECT registration, make, model FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL`,
      [row.vehicle_id]
    ).catch(() => null);
    if (veh) vehicle = { registration: veh.registration, make: veh.make, model: veh.model };
  } else if (row.vehicle_registration) {
    vehicle = { registration: row.vehicle_registration };
  }

  // Build M-Pesa + partner-matched bank payment options
  const paymentOptions = await buildPaymentOptions(
    row.partner_name || null,
    vehicle?.registration || row.vehicle_registration || null,
  );

  // Decrypt customer KRA PIN
  const customerKraPin = decryptField(row.customer_kra_pin_enc) || null;
  const customerPhone = decryptField(row.customer_type === 'individual' ? row.ind_phone_enc : row.corp_contact_phone_enc) || null;
  const customerEmail = decryptField(row.customer_type === 'individual' ? row.ind_email_enc : row.corp_contact_email_enc) || null;
  const customerAddress = row.customer_type === 'individual'
    ? (decryptField(row.ind_address_enc) || null)
    : (row.corp_address || null);

  // Bill-to-bank toggle — invoice the financing bank's registered address
  // instead of the customer's own contact details, for bank-financed deals.
  const billToName = row.bill_to_bank && row.partner_name ? row.partner_name : (row.customer_name || row.customer_id);
  const billToAddress = row.bill_to_bank && row.bank_address ? row.bank_address : customerAddress;
  const billToPhone = row.bill_to_bank ? null : customerPhone;
  const billToEmail = row.bill_to_bank ? null : customerEmail;
  const billToKraPin = row.bill_to_bank ? null : customerKraPin;

  const items = await getItems(req.params.id);
  const taxRate = Number(row.tax_rate || 0);

  const lineItems = items.length
    ? items.map((item: any, idx: number) => {
        const qty = Number(item.quantity || 1);
        const unitPrice = Number(item.unit_price || 0);
        const discPct = Number(item.discount_pct || 0);
        const lineBase = qty * unitPrice * (1 - discPct / 100);
        const vatAmt   = lineBase * (taxRate / 100);
        return {
          code:        item.device_model  || `ITM-${idx + 1}`,
          name:        item.device_type   || "",
          description: item.description  || "",
          quantity:    qty,
          unitPrice,
          discountPct: discPct,
          vatPct:      taxRate,
          lineTotal:   lineBase + vatAmt,
        };
      })
    : [{
        code: row.service_type || "SERVICE",
        name: row.service_type || "SERVICE",
        description: row.notes || "Service quotation",
        quantity: 1,
        unitPrice: Number(row.installation_cost || 0) + Number(row.subscription_fee || 0),
        discountPct: 0,
        vatPct: taxRate,
        lineTotal: Number(row.total_amount || 0),
      }];

  const rawSub    = items.reduce((s: number, i: any) => s + Number(i.unit_price || 0) * Number(i.quantity || 1), 0)
                    || (Number(row.installation_cost || 0) + Number(row.subscription_fee || 0));
  const discTotal = Number(row.discount_amount || 0);
  const subtotal  = rawSub - discTotal;
  const vatTotal  = subtotal * (taxRate / 100);
  const grandTotal = subtotal + vatTotal;

  const pdfBytes = await renderQuotePdf({
    documentNo:        row.quote_no,
    issueDate:         row.created_at,
    expiryDate:        row.expiry_date,
    customerName:      billToName,
    customerKraPin:    billToKraPin,
    customerPhone:     billToPhone,
    customerEmail:     billToEmail,
    customerAddress:   billToAddress,
    salesRep:          ticketSalesRepName || row.sales_rep_name || row.sales_rep_email || req.user?.email,
    technicianName:    technicianName || null,
    jobCardNo:         jobCardNo || null,
    jobCardStatus:     jobCardStatus || null,
    installationDate:  installationDate || null,
    installationTime:  installationTime || null,
    notes:             row.notes || "",
    subtotal,
    vatTotal,
    grandTotal,
    discountTotal:     discTotal > 0 ? discTotal : undefined,
    taxRate,
    vehicle,
    paymentOptions,
    lineItems,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.disposition === "attachment" ? "attachment" : "inline"}; filename="Quote_${row.quote_no}.pdf"`);
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  auditLog(req, "QUOTE_PDF_VIEWED", "crm_quotes", "Info", { quoteNo: row.quote_no }).catch(console.error);
  return res.send(Buffer.from(pdfBytes));
});

// ── PATCH /:id ─────────────────────────────────────────────────────────────────
router.patch("/:id", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const quote = await pgGet("SELECT * FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, quote))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }
  if (!["Draft","Sent"].includes(quote.status))
    return errorResponse(res, 409, "INVALID_STATE", "Only Draft/Sent quotes can be edited.");

  const { serviceType, installationCost, subscriptionFee, taxRate, discountAmount,
          expiryDate, notes, items, loanTermMonths, billToBank } = req.body;
  const now = new Date().toISOString();

  const ic = installationCost !== undefined ? Number(installationCost) : quote.installation_cost;
  const sf = subscriptionFee  !== undefined ? Number(subscriptionFee)  : quote.subscription_fee;
  const tr = taxRate           !== undefined ? Number(taxRate)           : quote.tax_rate;
  const da = discountAmount    !== undefined ? Number(discountAmount)    : quote.discount_amount;
  const ltm = loanTermMonths   !== undefined ? (loanTermMonths ? Number(loanTermMonths) : null) : quote.loan_term_months;
  const btb = billToBank       !== undefined ? (billToBank ? 1 : 0) : quote.bill_to_bank;
  const total = calcTotal(ic, sf, tr, da);

  // ── Snapshot before update for audit history ────────────────────────
  const beforeItems = await getItems(req.params.id);
  const beforeSnapshot = JSON.stringify({ ...quote, items: beforeItems });
  const changes: string[] = [];
  if (serviceType   !== undefined && serviceType   !== quote.service_type)      changes.push(`Service type: "${quote.service_type}" → "${serviceType}"`);
  if (installationCost !== undefined && ic          !== quote.installation_cost) changes.push(`Installation cost: ${quote.installation_cost} → ${ic}`);
  if (subscriptionFee  !== undefined && sf          !== quote.subscription_fee)  changes.push(`Subscription fee: ${quote.subscription_fee} → ${sf}`);
  if (taxRate          !== undefined && tr          !== quote.tax_rate)           changes.push(`Tax rate: ${quote.tax_rate}% → ${tr}%`);
  if (discountAmount   !== undefined && da          !== quote.discount_amount)    changes.push(`Discount: ${quote.discount_amount} → ${da}`);
  if (expiryDate       !== undefined && expiryDate  !== quote.expiry_date)        changes.push(`Expiry: ${quote.expiry_date || "none"} → ${expiryDate || "none"}`);
  if (notes            !== undefined && notes       !== quote.notes)              changes.push(`Notes updated`);
  if (loanTermMonths   !== undefined && ltm         !== quote.loan_term_months)   changes.push(`Loan term: ${quote.loan_term_months || "none"} → ${ltm || "none"} months`);
  if (billToBank       !== undefined && btb         !== quote.bill_to_bank)        changes.push(`Bill to: ${quote.bill_to_bank ? "Bank Partner" : "Customer"} → ${btb ? "Bank Partner" : "Customer"}`);
  if (items)                                                                      changes.push(`Line items replaced (${items.length} item${items.length !== 1 ? "s" : ""})`);

  await pgRun(
    `UPDATE crm_quotes SET service_type=?,installation_cost=?,subscription_fee=?,tax_rate=?,
      discount_amount=?,total_amount=?,expiry_date=?,notes=?,loan_term_months=?,bill_to_bank=?,updated_at=? WHERE id=?`,
    [serviceType??quote.service_type,ic,sf,tr,da,total,
     expiryDate??quote.expiry_date,notes??quote.notes,ltm,btb,now,req.params.id]
  );

  if (items) {
    const nextStockIds = collectStockIds(items);
    try {
      await ensureDevicesReservable(nextStockIds, req.params.id);
    } catch (e: any) {
      return errorResponse(res, 409, "STOCK_NOT_AVAILABLE", e?.message || "Selected devices are not available.");
    }

    await pgRun(`DELETE FROM crm_quote_items WHERE quote_id = ?`, [req.params.id]);
    for (const item of items) {
      const stockIds: string[] = Array.isArray(item.stockItemIds) ? item.stockItemIds : (item.stockItemId ? [item.stockItemId] : []);
      const qty = stockIds.length > 0 ? stockIds.length : (Number(item.quantity) || 1);
      const itemTotal = qty * Number(item.unitPrice||0);

      let serials: string[] = [];
      let imeis: string[] = [];
      if (stockIds.length > 0) {
        const placeholders = stockIds.map(() => "?").join(",");
        const devRows = await pgAll(`SELECT id, serial_number, imei FROM inv_items WHERE id IN (${placeholders})`, stockIds);
        serials = devRows.map((d: any) => d.serial_number).filter(Boolean);
        imeis   = devRows.map((d: any) => d.imei).filter(Boolean);
      }

      await pgRun(
        `INSERT INTO crm_quote_items
           (id,quote_id,device_model,device_type,description,quantity,unit_price,total_price,
            stock_item_id,stock_item_ids,serial_numbers,imei_numbers,product_id,discount_pct,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuidv4(),req.params.id,item.deviceModel || item.productName || "—",item.deviceType||null,item.description||null,
         qty,item.unitPrice||0,itemTotal,
         stockIds[0]||null,JSON.stringify(stockIds),JSON.stringify(serials),JSON.stringify(imeis),
         item.productId||null,Number(item.discountPct||0),now]
      );
    }

    await refreshQuoteReservations(req.params.id, quote.quote_no, nextStockIds, req.user!.id, req.user!.email || "", now);
  }

  // ── Write edit history record ────────────────────────────────────────
  const updatedItems = await getItems(req.params.id);
  const afterSnapshot = JSON.stringify({ ...quote, installation_cost: ic, subscription_fee: sf, tax_rate: tr, discount_amount: da, total_amount: total, service_type: serviceType ?? quote.service_type, expiry_date: expiryDate ?? quote.expiry_date, notes: notes ?? quote.notes, loan_term_months: ltm, items: updatedItems });
  if (changes.length > 0 || items) {
    await pgRun(
      `INSERT INTO crm_quote_edit_history (id,quote_id,edited_by_user_id,edited_by_name,edited_at,change_summary,before_snapshot,after_snapshot,before_total,after_total)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(), req.params.id, req.user!.id, req.user!.email || req.user!.id,
       now, changes.length > 0 ? changes.join("; ") : "Items updated",
       beforeSnapshot, afterSnapshot, quote.total_amount, total]
    ).catch(console.error);
  }

  const updated = await pgGet("SELECT * FROM crm_quotes WHERE id = ?", [req.params.id]);
  const qItems  = await getItems(req.params.id);
  auditLog(req, "QUOTE_EDITED", "crm_quotes", "Info", { quoteId: req.params.id, changes }).catch(console.error);
  return ok(res, { data: mapQuote(updated!, qItems) });
});

// ── POST /:id/items ───────────────────────────────────────────────────────────
router.post("/:id/items", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const quote = await pgGet("SELECT * FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, quote))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }
  if (!["Draft","Sent"].includes(quote.status))
    return errorResponse(res, 409, "INVALID_STATE", "Only Draft/Sent quotes can have items added.");

  const { deviceModel, deviceType, description, quantity = 1, unitPrice = 0, productId, stockItemIds } = req.body;
  if (!deviceModel) return errorResponse(res, 400, "MISSING_FIELD", "deviceModel required.");

  const stockIds: string[] = Array.isArray(stockItemIds) ? stockItemIds : [];
  const qty = stockIds.length > 0 ? stockIds.length : (Number(quantity) || 1);
  const itemTotal = qty * Number(unitPrice || 0);

  let serials: string[] = [];
  let imeis: string[] = [];
  if (stockIds.length > 0) {
    try { await ensureDevicesReservable(stockIds, req.params.id); } catch (e: any) {
      return errorResponse(res, 409, "STOCK_NOT_AVAILABLE", e?.message || "Selected devices are not available.");
    }
    const placeholders = stockIds.map(() => "?").join(",");
    const devRows = await pgAll(`SELECT id, serial_number, imei FROM inv_items WHERE id IN (${placeholders})`, stockIds);
    serials = devRows.map((d: any) => d.serial_number).filter(Boolean);
    imeis   = devRows.map((d: any) => d.imei).filter(Boolean);
  }

  const now = new Date().toISOString();
  const itemId = uuidv4();
  await pgRun(
    `INSERT INTO crm_quote_items
       (id,quote_id,device_model,device_type,description,quantity,unit_price,total_price,
        stock_item_id,stock_item_ids,serial_numbers,imei_numbers,product_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [itemId, req.params.id, deviceModel, deviceType || null, description || null,
     qty, Number(unitPrice || 0), itemTotal,
     stockIds[0] || null, JSON.stringify(stockIds),
     JSON.stringify(serials), JSON.stringify(imeis),
     productId || null, now]
  );

  if (stockIds.length > 0) {
    await reserveDevicesForQuote(stockIds, req.params.id, quote.quote_no, req.user!.id, req.user!.email || "", now);
  }

  // Recalculate quote total from items
  const allItems = await getItems(req.params.id);
  const newInstallCost = allItems.reduce((sum: number, i: any) => sum + Number(i.total_price || 0), 0);
  const newTotal = calcTotal(newInstallCost, 0, Number(quote.tax_rate), Number(quote.discount_amount));
  await pgRun(
    `UPDATE crm_quotes SET installation_cost=?, subscription_fee=0, total_amount=?, updated_at=? WHERE id=?`,
    [newInstallCost, newTotal, now, req.params.id]
  );

  return created(res, { data: mapItem({ ...await pgGet(`SELECT * FROM crm_quote_items WHERE id = ?`, [itemId]) }) }, "Item added.");
});

// ── POST /:id/send ────────────────────────────────────────────────────────────
router.post("/:id/send", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const row = await pgGet(
    `SELECT q.*, COALESCE(i.full_name, corp.company_name) as customer_name,
            p.name AS partner_name
     FROM crm_quotes q
     JOIN crm_customers c ON c.id = q.customer_id
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     LEFT JOIN partners p ON p.id::text = q.partner_id
     WHERE q.id = ? AND q.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, row))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }
  if (!['Draft','Sent'].includes(row.status)) return errorResponse(res, 409, "INVALID_STATE", "Quote cannot be sent in its current state.");

  const { toEmail } = req.body as { toEmail?: string };

  if (toEmail) {
    // Build PDF using new standalone renderer
    const items = await getItems(req.params.id);
    const taxRate = Number(row.tax_rate || 0);

    // Fetch vehicle + bank accounts for email PDF too
    let vehicle: { registration?: string; make?: string; model?: string } | null = null;
    if (row.vehicle_id) {
      const veh = await pgGet(`SELECT registration, make, model FROM crm_customer_vehicles WHERE id = ? AND deleted_at IS NULL`, [row.vehicle_id]).catch(() => null);
      if (veh) vehicle = { registration: veh.registration, make: veh.make, model: veh.model };
    } else if (row.vehicle_registration) {
      vehicle = { registration: row.vehicle_registration };
    }
    const paymentOptions = await buildPaymentOptions(
      row.partner_name || null,
      vehicle?.registration || row.vehicle_registration || null,
    );

    const lineItems = items.length
      ? items.map((item: any, idx: number) => {
          const qty = Number(item.quantity || 1);
          const unitPrice = Number(item.unit_price || 0);
          const discPct = Number(item.discount_pct || 0);
          const lineBase = qty * unitPrice * (1 - discPct / 100);
          return { code: item.device_model || `ITM-${idx+1}`, name: item.device_type || "", description: item.description || "", quantity: qty, unitPrice, discountPct: discPct, vatPct: taxRate, lineTotal: lineBase * (1 + taxRate / 100) };
        })
      : [{ code: row.service_type || "SERVICE", name: row.service_type || "SERVICE", description: row.notes || "Service quotation", quantity: 1, unitPrice: Number(row.installation_cost||0)+Number(row.subscription_fee||0), discountPct: 0, vatPct: taxRate, lineTotal: Number(row.total_amount||0) }];

    const rawSub    = items.reduce((s: number, i: any) => s + Number(i.unit_price||0)*Number(i.quantity||1), 0) || (Number(row.installation_cost||0)+Number(row.subscription_fee||0));
    const discTotal = Number(row.discount_amount || 0);
    const subtotal  = rawSub - discTotal;
    const vatTotal  = subtotal * (taxRate / 100);
    const grandTotal = subtotal + vatTotal;

    const pdfBytes = await renderQuotePdf({
      documentNo: row.quote_no, issueDate: row.created_at, expiryDate: row.expiry_date,
      customerName: row.customer_name || row.customer_id, salesRep: row.sales_rep_name || req.user?.email,
      notes: row.notes || "", subtotal, vatTotal, grandTotal, discountTotal: discTotal > 0 ? discTotal : undefined,
      taxRate, vehicle, paymentOptions, lineItems,
    });

    const customer = row.customer_name || "Customer";
    const htmlBody = buildQuoteEmail({
      customerName: customer,
      quoteNo: row.quote_no,
      grandTotal,
      expiryDate: row.expiry_date,
      salesRep: row.sales_rep_name || row.sales_rep_email || req.user?.email,
      notes: row.notes,
    });

    try {
      await sendMail({
        from: "Finemark Tracking <customer@finemarktracking.co.ke>",
        to: toEmail,
        subject: `Quotation ${row.quote_no} – Finemark Tracking`,
        html: htmlBody,
        attachments: [{ filename: `Quote_${row.quote_no}.pdf`, content: Buffer.from(pdfBytes), contentType: "application/pdf" }],
      });
    } catch (mailErr: any) {
      return errorResponse(res, 500, "MAIL_FAILED", mailErr.message || "Failed to send email.");
    }
  }

  if (row.status === "Draft") {
    await pgRun(`UPDATE crm_quotes SET status='Sent', updated_at=? WHERE id=?`, [new Date().toISOString(), req.params.id]);
  }
  auditLog(req, "QUOTE_SENT", "crm_quotes", "Info", { quoteId: req.params.id, toEmail: toEmail || null }).catch(console.error);
  return ok(res, { message: toEmail ? "Quote sent by email." : "Quote marked as Sent." });
});

// ── POST /:id/accept ──────────────────────────────────────────────────────────
router.post("/:id/accept", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const quote = await pgGet("SELECT * FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, quote))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }
  if (quote.status !== "Sent") return errorResponse(res, 409, "INVALID_STATE", "Only Sent quotes can be accepted.");

  await pgRun(`UPDATE crm_quotes SET status='Accepted', approved_at=?, approved_by=?, updated_at=? WHERE id=?`,
    [new Date().toISOString(), req.user!.email, new Date().toISOString(), req.params.id]);
  auditLog(req, "QUOTE_ACCEPTED", "crm_quotes", "Info", { quoteId: req.params.id }).catch(console.error);
  return ok(res, { message: "Quote accepted." });
});

// ── POST /:id/bdm-approve ──────────────────────────────────────────────────────
// Internal approval path for bank-financed (or any) quotes that don't need a
// customer round-trip — a BDM signs off directly from Draft (or Sent),
// skipping the customer-acceptance step, and the quote becomes eligible for
// convert-to-proforma exactly as if the customer had accepted it.
router.post("/:id/bdm-approve", requireAuth, requireRole(["Admin", "BDM", "BDMCorporate"]), async (req: AuthRequest, res) => {
  const quote = await pgGet("SELECT * FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, quote))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }
  if (!["Draft", "Sent"].includes(quote.status)) {
    return errorResponse(res, 409, "INVALID_STATE", "Only Draft or Sent quotes can be BDM-approved.");
  }

  await pgRun(`UPDATE crm_quotes SET status='Accepted', approved_at=?, approved_by=?, updated_at=? WHERE id=?`,
    [new Date().toISOString(), `${req.user!.email} (BDM approval, not sent to customer)`, new Date().toISOString(), req.params.id]);
  auditLog(req, "QUOTE_BDM_APPROVED", "crm_quotes", "Info", { quoteId: req.params.id }).catch(console.error);
  return ok(res, { message: "Quote approved internally — ready to convert to proforma." });
});

// ── POST /:id/reject ──────────────────────────────────────────────────────────
router.post("/:id/reject", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const quote = await pgGet("SELECT * FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, quote))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }
  await pgRun(`UPDATE crm_quotes SET status='Rejected', rejected_reason=?, updated_at=? WHERE id=?`,
    [req.body.reason || null, new Date().toISOString(), req.params.id]);
  await releaseQuoteReservations(
    req.params.id,
    req.user!.id,
    req.user!.email || "",
    `Released after quote ${quote.quote_no} rejection`
  );
  return ok(res, { message: "Quote rejected." });
});

// ── POST /:id/revise ──────────────────────────────────────────────────────────
router.post("/:id/revise", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const quote = await pgGet("SELECT * FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, quote))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }

  const now = new Date().toISOString();
  const newId = uuidv4();
  const newQuoteNo = nextQuoteNo();
  await pgRun(
    `INSERT INTO crm_quotes
       (id,quote_no,customer_id,lead_id,sales_rep_id,sales_rep_email,service_type,status,revision_no,
        parent_quote_id,installation_cost,subscription_fee,tax_rate,discount_amount,total_amount,
        expiry_date,notes,vehicle_id,vehicle_registration,partner_id,loan_term_months,created_by_user_id,created_at,updated_at)
     SELECT ?,?,customer_id,lead_id,sales_rep_id,sales_rep_email,service_type,'Draft',revision_no+1,
            ?,installation_cost,subscription_fee,tax_rate,discount_amount,total_amount,
            expiry_date,notes,vehicle_id,vehicle_registration,partner_id,loan_term_months,?,?,?
     FROM crm_quotes WHERE id=?`,
    [newId,newQuoteNo,quote.id,req.user!.id,now,now,quote.id]
  );
  // Copy line items
  const items = await getItems(quote.id);
  for (const item of items) {
    await pgRun(
      `INSERT INTO crm_quote_items
         (id,quote_id,device_model,device_type,description,quantity,unit_price,total_price,
          stock_item_id,stock_item_ids,serial_numbers,imei_numbers,product_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuidv4(),newId,item.device_model,item.device_type,item.description,item.quantity,item.unit_price,item.total_price,
        item.stock_item_id || null, item.stock_item_ids || "[]", item.serial_numbers || "[]", item.imei_numbers || "[]", item.product_id || null, now]
    );
  }
  const revisedUntil = new Date(Date.now() + QUOTE_HOLD_MS).toISOString();
  await pgRun(
    `UPDATE inv_items SET reservation_quote_id=?, reserved_until=?, updated_at=?
     WHERE reservation_quote_id=? AND status='Reserved' AND deleted_at IS NULL`,
    [newId, revisedUntil, now, quote.id]
  );
  await pgRun(`UPDATE crm_quotes SET status='Superseded', updated_at=? WHERE id=?`, [now, quote.id]);

  const newQuote = await pgGet("SELECT * FROM crm_quotes WHERE id = ?", [newId]);
  const newItems = await getItems(newId);
  auditLog(req, "QUOTE_REVISED", "crm_quotes", "Info", { originalId: quote.id, newId }).catch(console.error);
  return created(res, { data: mapQuote(newQuote!, newItems) }, "Quote revision created.");
});

// ── POST /:id/convert-to-proforma ─────────────────────────────────────────────
router.post("/:id/convert-to-proforma", requireAuth, requireRole(["Admin","Finance","BDM", "BDMCorporate","CorporateSales","Sales","Telesales","FieldSales"]), async (req: AuthRequest, res) => {
  const quote = await pgGet("SELECT * FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!quote) return errorResponse(res, 404, "NOT_FOUND", "Quote not found.");
  if (!(await assertQuoteAccess(req.user!.role, req.user!.id, quote))) {
    return errorResponse(res, 403, "FORBIDDEN", "You do not have access to this quote.");
  }
  if (quote.status !== "Accepted")
    return errorResponse(res, 409, "INVALID_STATE", "Only Accepted quotes can be converted to proforma.");

  // Check proforma not already generated from this quote
  const existing = await pgGet(
    `SELECT id FROM crm_proforma_invoices WHERE quote_id = ? AND deleted_at IS NULL`, [quote.id]
  ).catch(() => null);
  if (existing) return errorResponse(res, 409, "ALREADY_EXISTS", "Proforma already generated for this quote.");

  const now = new Date().toISOString();
  const pfId = uuidv4();
  const lastPF = await pgGet(`SELECT proforma_no FROM crm_proforma_invoices ORDER BY created_at DESC LIMIT 1`, []).catch(() => null);
  let pfSeq = 1;
  if (lastPF?.proforma_no) { const m = lastPF.proforma_no.match(/-(\d+)$/); if (m) pfSeq = parseInt(m[1],10)+1; }
  const proformaNo = `PF-${String(pfSeq).padStart(5,"0")}`;

  await pgRun(
    `INSERT INTO crm_proforma_invoices
       (id,proforma_no,customer_id,quote_id,lead_id,sales_rep_id,status,
        installation_cost,subscription_fee,tax_rate,discount_amount,total_amount,
        notes,vehicle_id,vehicle_registration,created_by_user_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [pfId,proformaNo,quote.customer_id,quote.id,quote.lead_id,quote.sales_rep_id,"Pending Approval",
     quote.installation_cost,quote.subscription_fee,quote.tax_rate,quote.discount_amount,quote.total_amount,
     quote.notes,quote.vehicle_id||null,quote.vehicle_registration||null,req.user!.id,now,now]
  ).catch(async () => {
    // Table may not exist yet — create it first
    await pgRun(`
      CREATE TABLE IF NOT EXISTS crm_proforma_invoices (
        id TEXT PRIMARY KEY, proforma_no TEXT UNIQUE NOT NULL, customer_id TEXT NOT NULL,
        quote_id TEXT, lead_id TEXT, sales_rep_id TEXT, status TEXT NOT NULL DEFAULT 'Draft',
        installation_cost REAL DEFAULT 0, subscription_fee REAL DEFAULT 0,
        tax_rate REAL DEFAULT 0, discount_amount REAL DEFAULT 0, total_amount REAL DEFAULT 0,
        notes TEXT, approved_by TEXT, approved_at TEXT, rejected_by TEXT, rejected_at TEXT,
        rejected_reason TEXT, converted_to_installation_id TEXT,
        vehicle_id TEXT, vehicle_registration TEXT,
        created_by_user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      )`, []);
    await pgRun(
      `INSERT INTO crm_proforma_invoices
         (id,proforma_no,customer_id,quote_id,lead_id,sales_rep_id,status,
          installation_cost,subscription_fee,tax_rate,discount_amount,total_amount,
          notes,vehicle_id,vehicle_registration,created_by_user_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [pfId,proformaNo,quote.customer_id,quote.id,quote.lead_id,quote.sales_rep_id,"Pending Approval",
       quote.installation_cost,quote.subscription_fee,quote.tax_rate,quote.discount_amount,quote.total_amount,
       quote.notes,quote.vehicle_id||null,quote.vehicle_registration||null,req.user!.id,now,now]
    );
  });

  // Copy items — propagate stock/serial/IMEI data for installation job-sheet
  const items = await getItems(quote.id);
  // Ensure proforma items table has the extended device-tracking columns
  await pgRun(`ALTER TABLE crm_proforma_items ADD COLUMN IF NOT EXISTS stock_item_ids TEXT NOT NULL DEFAULT '[]'`, []).catch(() => {});
  await pgRun(`ALTER TABLE crm_proforma_items ADD COLUMN IF NOT EXISTS serial_numbers TEXT NOT NULL DEFAULT '[]'`, []).catch(() => {});
  await pgRun(`ALTER TABLE crm_proforma_items ADD COLUMN IF NOT EXISTS imei_numbers TEXT NOT NULL DEFAULT '[]'`, []).catch(() => {});
  for (const item of items) {
    await pgRun(
      `INSERT INTO crm_proforma_items
         (id,proforma_id,device_model,device_type,description,quantity,unit_price,total_price,
          stock_item_id,stock_item_ids,serial_numbers,imei_numbers,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING`,
      [uuidv4(),pfId,item.device_model,item.device_type,item.description,item.quantity,item.unit_price,item.total_price,
       item.stock_item_id,
       item.stock_item_ids || '[]',
       item.serial_numbers || '[]',
       item.imei_numbers   || '[]',
       now]
    ).catch(() => {});
  }

  auditLog(req, "QUOTE_CONVERTED_TO_PF", "crm_quotes", "Info", { quoteId: quote.id, proformaId: pfId }).catch(console.error);
  return created(res, { data: { proformaId: pfId, proformaNo } }, "Proforma invoice created.");
});

export default router;
