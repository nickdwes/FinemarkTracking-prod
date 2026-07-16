import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";

const router = Router();

// ── Table bootstrap ───────────────────────────────────────────────────────────
pgRun(`
  CREATE TABLE IF NOT EXISTS inv_product_categories (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`, []).catch(e => console.error("[inv_product_categories] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_product_catalog (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL,
    product_code TEXT NOT NULL UNIQUE,
    product_name TEXT NOT NULL,
    device_model TEXT NOT NULL,
    manufacturer TEXT,
    vendor TEXT,
    supplier_id TEXT,
    country_of_origin TEXT,
    description TEXT,
    warranty_months INTEGER NOT NULL DEFAULT 12,
    installation_notes TEXT,
    purchase_price REAL,
    sale_price REAL,
    installation_price REAL,
    subscription_price REAL,
    max_discount_pct REAL NOT NULL DEFAULT 10,
    min_margin_pct REAL NOT NULL DEFAULT 20,
    reorder_level INTEGER NOT NULL DEFAULT 5,
    max_stock_level INTEGER NOT NULL DEFAULT 100,
    active INTEGER NOT NULL DEFAULT 1,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`, []).catch(e => console.error("[inv_product_catalog] init:", e));

pgRun(`
  CREATE TABLE IF NOT EXISTS inv_suppliers (
    id TEXT PRIMARY KEY,
    supplier_name TEXT NOT NULL,
    contact_person TEXT, email TEXT, phone TEXT, country TEXT,
    distributor_level TEXT, contract_reference TEXT, notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_by_user_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
  )
`, []).catch(e => console.error("[inv_suppliers] init:", e));

// ── Migrate inv_suppliers: add extended columns if they don't exist ─────────
setTimeout(async () => {
  const newCols: string[] = [
    "business_reg_no TEXT", "tax_id TEXT", "supplier_category TEXT",
    "head_office_address TEXT", "website TEXT",
    "job_title TEXT", "alt_phone TEXT",
    "finance_contact_person TEXT", "finance_email TEXT", "finance_phone TEXT",
    "bank_name TEXT", "account_name TEXT", "account_number TEXT",
    "swift_code TEXT", "currency TEXT",
    "advance_payment_pct REAL", "credit_period_days INTEGER", "payment_method TEXT",
    "shipping_origin TEXT", "lead_time_days INTEGER",
    "shipping_methods TEXT", "preferred_freight_forwarder TEXT",
    "min_order_quantity INTEGER", "product_categories_supplied TEXT",
    "certifications TEXT", "warranty_terms TEXT",
    "return_policy TEXT", "defective_unit_procedure TEXT",
    "contract_start_date TEXT", "contract_expiry_date TEXT",
    "sla_response_time TEXT", "sla_replacement_time TEXT",
    "blacklist_status INTEGER DEFAULT 0", "approved_vendor INTEGER DEFAULT 1",
    "compliance_documents TEXT",
    "procurement_rating INTEGER", "quality_rating INTEGER",
    "delivery_rating INTEGER", "pricing_rating INTEGER",
    "preferred_products TEXT", "batch_numbers_info TEXT", "serial_range_info TEXT",
    "last_purchase_date TEXT", "total_purchase_value REAL",
    "outstanding_balance REAL", "credit_limit REAL",
    "avg_delivery_days REAL", "fulfillment_rate REAL",
    "defective_rate REAL", "warranty_claim_rate REAL",
  ];
  for (const col of newCols) {
    const colName = col.split(" ")[0];
    await pgRun(`ALTER TABLE inv_suppliers ADD COLUMN IF NOT EXISTS ${col}`, []).catch(() => {});
  }
}, 1000);

pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_catalog_category ON inv_product_catalog(category_id)`, []).catch(() => {});
pgRun(`CREATE INDEX IF NOT EXISTS idx_inv_catalog_code ON inv_product_catalog(product_code)`, []).catch(() => {});

// ── Migrate: add sales-catalogue columns ─────────────────────────────────────
setTimeout(async () => {
  for (const col of [
    "key_features TEXT",
    "talking_points TEXT",
    "tech_specs TEXT",
    "target_segment TEXT",
    "identifier_type TEXT NOT NULL DEFAULT 'both'",
    "quotation_description TEXT",
    "requires_sim BOOLEAN NOT NULL DEFAULT true",
  ]) {
    await pgRun(`ALTER TABLE inv_product_catalog ADD COLUMN IF NOT EXISTS ${col}`, []).catch(() => {});
  }
}, 1200);

// ── Seed default categories ───────────────────────────────────────────────────
const DEFAULT_CATS = [
  { code: "VT", prefix: "VT", name: "Vehicle Tracking" },
  { code: "CT", prefix: "CT", name: "Cargo Tracking" },
  { code: "FM", prefix: "FM", name: "Fuel Management" },
  { code: "DC", prefix: "DC", name: "Dashboard Cameras" },
  { code: "AT", prefix: "AT", name: "Anti Theft & Alarm" },
  { code: "SG", prefix: "SG", name: "Speed Governors" },
];
setTimeout(async () => {
  for (const c of DEFAULT_CATS) {
    const exists = await pgGet("SELECT id FROM inv_product_categories WHERE code = ?", [c.code]).catch(() => null);
    if (!exists) {
      const now = new Date().toISOString();
      await pgRun(
        `INSERT INTO inv_product_categories (id,code,prefix,name,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), c.code, c.prefix, c.name, now, now]
      ).catch(() => {});
    }
  }
}, 1500);

// ── helper: generate next product code for a category ─────────────────────────
async function nextProductCode(categoryId: string): Promise<string> {
  const cat = await pgGet("SELECT prefix FROM inv_product_categories WHERE id = ?", [categoryId]);
  if (!cat) throw new Error("Category not found.");
  const last = await pgGet(
    `SELECT product_code FROM inv_product_catalog WHERE category_id = ? ORDER BY product_code DESC LIMIT 1`,
    [categoryId]
  );
  let seq = 1;
  if (last) {
    const num = parseInt(last.product_code.replace(cat.prefix, ""), 10);
    if (!isNaN(num)) seq = num + 1;
  }
  return `${cat.prefix}${String(seq).padStart(3, "0")}`;
}

// ────────────────────────────────────────────────────────────────────────────────
// CATEGORIES
// ────────────────────────────────────────────────────────────────────────────────
router.get("/categories", requireAuth, async (_req, res) => {
  const rows = await pgAll("SELECT * FROM inv_product_categories WHERE active = 1 ORDER BY name", []);
  return ok(res, { data: rows });
});

router.post("/categories", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const { code, prefix, name, description } = req.body;
  if (!code || !prefix || !name)
    return errorResponse(res, 400, "MISSING_FIELD", "code, prefix, and name are required.");
  const now = new Date().toISOString();
  const id = uuidv4();
  await pgRun(
    `INSERT INTO inv_product_categories (id,code,prefix,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    [id, code.toUpperCase(), prefix.toUpperCase(), name, description || null, now, now]
  );
  const row = await pgGet("SELECT * FROM inv_product_categories WHERE id = ?", [id]);
  auditLog(req, "INV_CATEGORY_CREATED", "inv_product_categories", "Info", { code }).catch(console.error);
  return created(res, { data: row }, "Category created.");
});

// ────────────────────────────────────────────────────────────────────────────────
// SUPPLIERS
// ────────────────────────────────────────────────────────────────────────────────
router.get("/suppliers", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement", "Sales", "Finance"]), async (_req, res) => {
  try {
    const rows = await pgAll("SELECT * FROM inv_suppliers WHERE deleted_at IS NULL ORDER BY supplier_name", []);
    return ok(res, { data: rows });
  } catch (e: any) {
    return errorResponse(res, 500, "DB_ERROR", e.message || "Failed to load suppliers.");
  }
});

router.post("/suppliers", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req: AuthRequest, res) => {
  const {
    supplierName, businessRegNo, taxId, supplierCategory,
    contactPerson, jobTitle, phone, altPhone, email, country,
    financeContactPerson, financeEmail, financePhone,
    bankName, accountName, accountNumber, swiftCode, currency,
    advancePaymentPct, creditPeriodDays, paymentMethod,
    distributorLevel, shippingOrigin, leadTimeDays, shippingMethods,
    preferredFreightForwarder, minOrderQuantity, productCategoriesSupplied,
    certifications, warrantyTerms, returnPolicy, defectiveUnitProcedure,
    contractReference, contractStartDate, contractExpiryDate,
    slaResponseTime, slaReplacementTime,
    blacklistStatus, approvedVendor, complianceDocuments,
    procurementRating, qualityRating, deliveryRating, pricingRating,
    preferredProducts, batchNumbersInfo, serialRangeInfo,
    headOfficeAddress, website, notes,
  } = req.body;
  if (!supplierName) return errorResponse(res, 400, "MISSING_FIELD", "supplierName required.");
  try {
    const now = new Date().toISOString();
    const id = uuidv4();
    await pgRun(
      `INSERT INTO inv_suppliers
         (id,supplier_name,contact_person,email,phone,country,distributor_level,contract_reference,notes,created_by_user_id,created_at,updated_at,
          business_reg_no,tax_id,supplier_category,head_office_address,website,
          job_title,alt_phone,finance_contact_person,finance_email,finance_phone,
          bank_name,account_name,account_number,swift_code,currency,
          advance_payment_pct,credit_period_days,payment_method,
          shipping_origin,lead_time_days,shipping_methods,preferred_freight_forwarder,min_order_quantity,product_categories_supplied,
          certifications,warranty_terms,return_policy,defective_unit_procedure,
          contract_start_date,contract_expiry_date,sla_response_time,sla_replacement_time,
          blacklist_status,approved_vendor,compliance_documents,
          procurement_rating,quality_rating,delivery_rating,pricing_rating,
          preferred_products,batch_numbers_info,serial_range_info)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, supplierName, contactPerson||null, email||null, phone||null, country||null,
        distributorLevel||null, contractReference||null, notes||null, req.user!.id, now, now,
        businessRegNo||null, taxId||null, supplierCategory||null, headOfficeAddress||null, website||null,
        jobTitle||null, altPhone||null, financeContactPerson||null, financeEmail||null, financePhone||null,
        bankName||null, accountName||null, accountNumber||null, swiftCode||null, currency||null,
        advancePaymentPct||null, creditPeriodDays||null, paymentMethod||null,
        shippingOrigin||null, leadTimeDays||null, shippingMethods||null, preferredFreightForwarder||null,
        minOrderQuantity||null, productCategoriesSupplied||null,
        certifications||null, warrantyTerms||null, returnPolicy||null, defectiveUnitProcedure||null,
        contractStartDate||null, contractExpiryDate||null, slaResponseTime||null, slaReplacementTime||null,
        blacklistStatus ? 1 : 0, approvedVendor === false ? 0 : 1, complianceDocuments||null,
        procurementRating||null, qualityRating||null, deliveryRating||null, pricingRating||null,
        preferredProducts||null, batchNumbersInfo||null, serialRangeInfo||null,
      ]
    );
    const row = await pgGet("SELECT * FROM inv_suppliers WHERE id = ?", [id]);
    auditLog(req, "INV_SUPPLIER_CREATED", "inv_suppliers", "Info", { supplierName }).catch(console.error);
    return created(res, { data: row }, "Supplier created.");
  } catch (e: any) {
    return errorResponse(res, 500, "DB_ERROR", e.message || "Failed to create supplier.");
  }
});

router.get("/suppliers/:id", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req, res) => {
  try {
    const row = await pgGet("SELECT * FROM inv_suppliers WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Supplier not found.");
    return ok(res, { data: row });
  } catch (e: any) {
    return errorResponse(res, 500, "DB_ERROR", e.message || "Failed to load supplier.");
  }
});

router.patch("/suppliers/:id", requireAuth, requireRole(["Admin", "InventoryManager", "Procurement"]), async (req: AuthRequest, res) => {
  try {
    const row = await pgGet("SELECT id FROM inv_suppliers WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Supplier not found.");
    const {
      supplierName, businessRegNo, taxId, supplierCategory,
      contactPerson, jobTitle, phone, altPhone, email, country,
      financeContactPerson, financeEmail, financePhone,
      bankName, accountName, accountNumber, swiftCode, currency,
      advancePaymentPct, creditPeriodDays, paymentMethod,
      distributorLevel, shippingOrigin, leadTimeDays, shippingMethods,
      preferredFreightForwarder, minOrderQuantity, productCategoriesSupplied,
      certifications, warrantyTerms, returnPolicy, defectiveUnitProcedure,
      contractReference, contractStartDate, contractExpiryDate,
      slaResponseTime, slaReplacementTime,
      blacklistStatus, approvedVendor, complianceDocuments,
      procurementRating, qualityRating, deliveryRating, pricingRating,
      preferredProducts, batchNumbersInfo, serialRangeInfo,
      headOfficeAddress, website, notes,
      lastPurchaseDate, totalPurchaseValue, outstandingBalance, creditLimit,
      avgDeliveryDays, fulfillmentRate, defectiveRate, warrantyClaimRate, active,
    } = req.body;
    const now = new Date().toISOString();
    await pgRun(
      `UPDATE inv_suppliers SET
         supplier_name=COALESCE(?,supplier_name), contact_person=COALESCE(?,contact_person),
         email=COALESCE(?,email), phone=COALESCE(?,phone), country=COALESCE(?,country),
         distributor_level=COALESCE(?,distributor_level), contract_reference=COALESCE(?,contract_reference),
         notes=COALESCE(?,notes),
         business_reg_no=COALESCE(?,business_reg_no), tax_id=COALESCE(?,tax_id),
         supplier_category=COALESCE(?,supplier_category), head_office_address=COALESCE(?,head_office_address),
         website=COALESCE(?,website), job_title=COALESCE(?,job_title), alt_phone=COALESCE(?,alt_phone),
         finance_contact_person=COALESCE(?,finance_contact_person), finance_email=COALESCE(?,finance_email),
         finance_phone=COALESCE(?,finance_phone),
         bank_name=COALESCE(?,bank_name), account_name=COALESCE(?,account_name),
         account_number=COALESCE(?,account_number), swift_code=COALESCE(?,swift_code),
         currency=COALESCE(?,currency), advance_payment_pct=COALESCE(?,advance_payment_pct),
         credit_period_days=COALESCE(?,credit_period_days), payment_method=COALESCE(?,payment_method),
         shipping_origin=COALESCE(?,shipping_origin), lead_time_days=COALESCE(?,lead_time_days),
         shipping_methods=COALESCE(?,shipping_methods),
         preferred_freight_forwarder=COALESCE(?,preferred_freight_forwarder),
         min_order_quantity=COALESCE(?,min_order_quantity),
         product_categories_supplied=COALESCE(?,product_categories_supplied),
         certifications=COALESCE(?,certifications), warranty_terms=COALESCE(?,warranty_terms),
         return_policy=COALESCE(?,return_policy), defective_unit_procedure=COALESCE(?,defective_unit_procedure),
         contract_start_date=COALESCE(?,contract_start_date), contract_expiry_date=COALESCE(?,contract_expiry_date),
         sla_response_time=COALESCE(?,sla_response_time), sla_replacement_time=COALESCE(?,sla_replacement_time),
         blacklist_status=COALESCE(?,blacklist_status), approved_vendor=COALESCE(?,approved_vendor),
         compliance_documents=COALESCE(?,compliance_documents),
         procurement_rating=COALESCE(?,procurement_rating), quality_rating=COALESCE(?,quality_rating),
         delivery_rating=COALESCE(?,delivery_rating), pricing_rating=COALESCE(?,pricing_rating),
         preferred_products=COALESCE(?,preferred_products), batch_numbers_info=COALESCE(?,batch_numbers_info),
         serial_range_info=COALESCE(?,serial_range_info),
         last_purchase_date=COALESCE(?,last_purchase_date), total_purchase_value=COALESCE(?,total_purchase_value),
         outstanding_balance=COALESCE(?,outstanding_balance), credit_limit=COALESCE(?,credit_limit),
         avg_delivery_days=COALESCE(?,avg_delivery_days), fulfillment_rate=COALESCE(?,fulfillment_rate),
         defective_rate=COALESCE(?,defective_rate), warranty_claim_rate=COALESCE(?,warranty_claim_rate),
         active=COALESCE(?,active), updated_at=? WHERE id=?`,
      [
        supplierName||null, contactPerson||null, email||null, phone||null, country||null,
        distributorLevel||null, contractReference||null, notes||null,
        businessRegNo||null, taxId||null, supplierCategory||null, headOfficeAddress||null,
        website||null, jobTitle||null, altPhone||null,
        financeContactPerson||null, financeEmail||null, financePhone||null,
        bankName||null, accountName||null, accountNumber||null, swiftCode||null, currency||null,
        advancePaymentPct||null, creditPeriodDays||null, paymentMethod||null,
        shippingOrigin||null, leadTimeDays||null, shippingMethods||null,
        preferredFreightForwarder||null, minOrderQuantity||null, productCategoriesSupplied||null,
        certifications||null, warrantyTerms||null, returnPolicy||null, defectiveUnitProcedure||null,
        contractStartDate||null, contractExpiryDate||null, slaResponseTime||null, slaReplacementTime||null,
        blacklistStatus !== undefined ? (blacklistStatus ? 1 : 0) : null,
        approvedVendor !== undefined ? (approvedVendor ? 1 : 0) : null,
        complianceDocuments||null,
        procurementRating||null, qualityRating||null, deliveryRating||null, pricingRating||null,
        preferredProducts||null, batchNumbersInfo||null, serialRangeInfo||null,
        lastPurchaseDate||null, totalPurchaseValue||null, outstandingBalance||null, creditLimit||null,
        avgDeliveryDays||null, fulfillmentRate||null, defectiveRate||null, warrantyClaimRate||null,
        active !== undefined ? (active ? 1 : 0) : null, now, req.params.id,
      ]
    );
    auditLog(req, "INV_SUPPLIER_UPDATED", "inv_suppliers", "Info", { id: req.params.id }).catch(console.error);
    return ok(res, null, "Supplier updated.");
  } catch (e: any) {
    return errorResponse(res, 500, "DB_ERROR", e.message || "Failed to update supplier.");
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// PRODUCT CATALOG
// ────────────────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const { categoryId, q, active } = req.query as any;
  const filters = ["p.deleted_at IS NULL"];
  const params: any[] = [];
  if (categoryId) { filters.push("p.category_id = ?"); params.push(categoryId); }
  if (active !== undefined) { filters.push("p.active = ?"); params.push(active === "false" ? 0 : 1); }
  if (q) { filters.push("(p.product_name LIKE ? OR p.product_code LIKE ? OR p.device_model LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  try {
    const rows = await pgAll(
      `SELECT p.*, c.name as category_name, c.prefix as category_prefix, s.supplier_name
       FROM inv_product_catalog p
       JOIN inv_product_categories c ON c.id = p.category_id
       LEFT JOIN inv_suppliers s ON s.id = p.supplier_id
       WHERE ${filters.join(" AND ")} ORDER BY p.product_code`,
      params
    );
    const stockMap: Record<string, any> = {};
    if (rows.length) {
      const ids = rows.map(r => `'${r.id}'`).join(",");
      const stockRows = await pgAll(
        `SELECT product_id, status, COUNT(*) as cnt FROM inv_items
         WHERE product_id IN (${ids}) AND deleted_at IS NULL GROUP BY product_id, status`,
        []
      );
      for (const s of stockRows) {
        if (!stockMap[s.product_id]) stockMap[s.product_id] = {};
        stockMap[s.product_id][s.status] = Number(s.cnt);
      }
    }
    return ok(res, {
      data: rows.map(r => ({
        ...r,
        purchase_price: Number(r.purchase_price),
        sale_price: Number(r.sale_price),
        stock: stockMap[r.id] || {},
        in_stock_count: (stockMap[r.id]?.["In Stock"] || 0),
      })),
    });
  } catch (e: any) {
    return errorResponse(res, 500, "DB_ERROR", e.message || "Failed to load products.");
  }
});

router.post("/", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const {
    categoryId, productName, deviceModel, manufacturer, vendor, supplierId,
    countryOfOrigin, description, warrantyMonths, installationNotes,
    purchasePrice, salePrice, installationPrice, subscriptionPrice,
    maxDiscountPct, minMarginPct, reorderLevel, maxStockLevel,
    keyFeatures, talkingPoints, techSpecs, targetSegment,
    identifierType, quotationDescription, requiresSim,
  } = req.body;
  if (!categoryId || !productName || !deviceModel)
    return errorResponse(res, 400, "MISSING_FIELD", "categoryId, productName, and deviceModel are required.");
  const VALID_ID_TYPES = ["imei", "serial", "both"];
  const resolvedIdType = VALID_ID_TYPES.includes(identifierType) ? identifierType : "both";
  try {
    const productCode = await nextProductCode(categoryId);
    const now = new Date().toISOString();
    const id = uuidv4();
    await pgRun(
      `INSERT INTO inv_product_catalog
         (id,category_id,product_code,product_name,device_model,manufacturer,vendor,supplier_id,
          country_of_origin,description,warranty_months,installation_notes,purchase_price,sale_price,
          installation_price,subscription_price,max_discount_pct,min_margin_pct,reorder_level,
          max_stock_level,key_features,talking_points,tech_specs,target_segment,identifier_type,
          quotation_description,requires_sim,created_by_user_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, categoryId, productCode, productName, deviceModel, manufacturer||null, vendor||null,
       supplierId||null, countryOfOrigin||null, description||null,
       warrantyMonths||12, installationNotes||null,
       purchasePrice||null, salePrice||null, installationPrice||null, subscriptionPrice||null,
       maxDiscountPct||10, minMarginPct||20,
       reorderLevel||5, maxStockLevel||100,
       keyFeatures||null, talkingPoints||null, techSpecs||null, targetSegment||null, resolvedIdType,
       quotationDescription||null, requiresSim === false ? false : true,
       req.user!.id, now, now]
    );
    const row = await pgGet(
      `SELECT p.*, c.name as category_name FROM inv_product_catalog p
       JOIN inv_product_categories c ON c.id = p.category_id WHERE p.id = ?`, [id]
    );
    auditLog(req, "INV_PRODUCT_CREATED", "inv_product_catalog", "Info", { productCode }).catch(console.error);
    return created(res, { data: row }, `Product ${productCode} created.`);
  } catch (e: any) {
    return errorResponse(res, 500, "DB_ERROR", e.message || "Failed to create product.");
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const row = await pgGet(
      `SELECT p.*, c.name as category_name, c.prefix as category_prefix, s.supplier_name
       FROM inv_product_catalog p
       JOIN inv_product_categories c ON c.id = p.category_id
       LEFT JOIN inv_suppliers s ON s.id = p.supplier_id
       WHERE p.id = ? AND p.deleted_at IS NULL`, [req.params.id]
    );
    if (!row) return errorResponse(res, 404, "NOT_FOUND", "Product not found.");
    return ok(res, { data: row });
  } catch (e: any) {
    return errorResponse(res, 500, "DB_ERROR", e.message || "Failed to load product.");
  }
});

router.patch("/:id", requireAuth, requireRole(ROLE_GROUPS.INVENTORY_FULL), async (req: AuthRequest, res) => {
  const row = await pgGet("SELECT id FROM inv_product_catalog WHERE id = ? AND deleted_at IS NULL", [req.params.id]);
  if (!row) return errorResponse(res, 404, "NOT_FOUND", "Product not found.");
  const {
    productName, deviceModel, manufacturer, vendor, supplierId, countryOfOrigin, description,
    warrantyMonths, installationNotes, purchasePrice, salePrice, installationPrice,
    subscriptionPrice, maxDiscountPct, minMarginPct, reorderLevel, maxStockLevel, active,
    keyFeatures, talkingPoints, techSpecs, targetSegment, identifierType, quotationDescription,
    requiresSim,
  } = req.body;
  const VALID_ID_TYPES = ["imei", "serial", "both"];
  const now = new Date().toISOString();
  await pgRun(
    `UPDATE inv_product_catalog SET
       product_name=COALESCE(?,product_name), device_model=COALESCE(?,device_model),
       manufacturer=COALESCE(?,manufacturer), vendor=COALESCE(?,vendor),
       supplier_id=COALESCE(?,supplier_id), country_of_origin=COALESCE(?,country_of_origin),
       description=COALESCE(?,description), warranty_months=COALESCE(?,warranty_months),
       installation_notes=COALESCE(?,installation_notes), purchase_price=COALESCE(?,purchase_price),
       sale_price=COALESCE(?,sale_price), installation_price=COALESCE(?,installation_price),
       subscription_price=COALESCE(?,subscription_price), max_discount_pct=COALESCE(?,max_discount_pct),
       min_margin_pct=COALESCE(?,min_margin_pct), reorder_level=COALESCE(?,reorder_level),
       max_stock_level=COALESCE(?,max_stock_level), active=COALESCE(?,active),
       key_features=COALESCE(?,key_features), talking_points=COALESCE(?,talking_points),
       tech_specs=COALESCE(?,tech_specs), target_segment=COALESCE(?,target_segment),
       identifier_type=COALESCE(?,identifier_type),
       quotation_description=COALESCE(?,quotation_description),
       requires_sim=COALESCE(?,requires_sim),
       updated_at=?
     WHERE id=?`,
    [productName||null, deviceModel||null, manufacturer||null, vendor||null, supplierId||null,
     countryOfOrigin||null, description||null, warrantyMonths||null, installationNotes||null,
     purchasePrice||null, salePrice||null, installationPrice||null, subscriptionPrice||null,
     maxDiscountPct||null, minMarginPct||null, reorderLevel||null, maxStockLevel||null,
     active !== undefined ? (active ? 1 : 0) : null,
     keyFeatures||null, talkingPoints||null, techSpecs||null, targetSegment||null,
     (identifierType && VALID_ID_TYPES.includes(identifierType)) ? identifierType : null,
     quotationDescription||null,
     requiresSim !== undefined ? (requiresSim ? true : false) : null,
     now, req.params.id]
  );
  auditLog(req, "INV_PRODUCT_UPDATED", "inv_product_catalog", "Info", { id: req.params.id }).catch(console.error);
  return ok(res, null, "Product updated.");
});

export default router;
