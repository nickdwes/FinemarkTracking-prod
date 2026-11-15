import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { pgGet, pgAll, pgRun } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/auth.js";
import { requireRole, ROLE_GROUPS } from "../middleware/rbac.js";
import { ok, created, errorResponse } from "../utils/responses.js";
import { auditLog } from "../services/auditService.js";
import { docBankConfigSchema, updateDocBankConfigSchema, brandProfileSchema } from "../utils/validators.js";
import { invalidateDocBrandCache } from "../utils/docBrand.js";

const router = Router();

// ── Tables ────────────────────────────────────────────────────────────────────
// Per-partner-bank document configuration: which company template (finemark |
// unique) and how VAT is presented on that bank's quote / proforma / invoice.
// Keyed by partner_id (same key as bank_financed_pricing); a protected 'DEFAULT'
// row is the catch-all for retail / unmatched documents.
(async () => {
  const now = new Date().toISOString();
  await pgRun(`
    CREATE TABLE IF NOT EXISTS doc_bank_configs (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      template TEXT NOT NULL DEFAULT 'finemark',
      vat_display TEXT NOT NULL DEFAULT 'auto',
      is_default BOOLEAN NOT NULL DEFAULT false,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`, []);
  // Standard "Bill To" address for this bank's invoices (config override; falls
  // back to the partner's postal address when blank).
  await pgRun(`ALTER TABLE doc_bank_configs ADD COLUMN IF NOT EXISTS bill_to_address TEXT`, []).catch(() => {});
  // Standard "Pay To" bank account shown in MODE OF PAYMENTS on this bank's
  // quotation / proforma / invoice (config override; falls back to bank_accounts).
  for (const col of ["pay_to_bank_name", "pay_to_branch", "pay_to_account_no", "pay_to_payee"]) {
    await pgRun(`ALTER TABLE doc_bank_configs ADD COLUMN IF NOT EXISTS ${col} TEXT`, []).catch(() => {});
  }

  await pgRun(`
    CREATE TABLE IF NOT EXISTS document_brand_profiles (
      brand_key TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      tagline TEXT, address TEXT, phone TEXT, email TEXT, website TEXT, pin TEXT,
      logo_filename TEXT,
      till TEXT, paybill TEXT, bank_name TEXT, bank_branch TEXT, bank_account_no TEXT, payee TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`, []);

  // Protected catch-all row → finemark + auto (preserves current behaviour)
  await pgRun(
    `INSERT INTO doc_bank_configs (id, partner_id, display_name, template, vat_display, is_default, sort_order, created_at, updated_at)
     VALUES (?, 'DEFAULT', 'Others (default)', 'finemark', 'auto', true, 999, ?, ?)
     ON CONFLICT (partner_id) DO NOTHING`,
    [uuidv4(), now, now]
  );

  // Seed a row for every bank that already has bank-financed pricing → finemark + inclusive,
  // pre-filling the standard bill-to address from the partner's postal address.
  await pgRun(
    `INSERT INTO doc_bank_configs (id, partner_id, display_name, template, vat_display, bill_to_address, is_default, sort_order, created_at, updated_at)
     SELECT gen_random_uuid()::text, bfp.partner_id, COALESCE(p.name, 'Bank'), 'finemark', 'inclusive', NULLIF(TRIM(p.postal_address), ''), false, 10, ?, ?
     FROM bank_financed_pricing bfp JOIN partners p ON p.id::text = bfp.partner_id
     ON CONFLICT (partner_id) DO NOTHING`,
    [now, now]
  );
  // Backfill the bill-to address on existing (already-seeded) bank rows that don't have one yet.
  await pgRun(
    `UPDATE doc_bank_configs c
        SET bill_to_address = NULLIF(TRIM(p.postal_address), ''), updated_at = ?
       FROM partners p
      WHERE p.id::text = c.partner_id
        AND c.is_default = false
        AND (c.bill_to_address IS NULL OR TRIM(c.bill_to_address) = '')
        AND NULLIF(TRIM(p.postal_address), '') IS NOT NULL`,
    [now]
  ).catch(() => {});
  // Backfill the "Pay To" account from the bank's linked bank_accounts row
  // (the account customers already pay into), only where not yet configured.
  await pgRun(
    `UPDATE doc_bank_configs c
        SET pay_to_bank_name  = COALESCE(NULLIF(TRIM(c.pay_to_bank_name), ''), ba.bank_name, ba.account_name),
            pay_to_branch     = COALESCE(NULLIF(TRIM(c.pay_to_branch), ''), NULLIF(TRIM(CONCAT_WS(' ', ba.branch, CASE WHEN ba.branch_code IS NOT NULL THEN CONCAT('(Code ', ba.branch_code, ')') END)), '')),
            pay_to_account_no = COALESCE(NULLIF(TRIM(c.pay_to_account_no), ''), ba.account_number::text),
            pay_to_payee      = COALESCE(NULLIF(TRIM(c.pay_to_payee), ''), ba.payee_name, ba.account_name),
            updated_at        = ?
       FROM bank_accounts ba
      WHERE ba.partner_id = c.partner_id
        AND ba.is_active = true
        AND COALESCE(ba.payment_method, 'bank') = 'bank'
        AND c.is_default = false
        AND (c.pay_to_account_no IS NULL OR TRIM(c.pay_to_account_no) = '')`,
    [now]
  ).catch(() => {});

  // Seed the two editable brand profiles
  await pgRun(
    `INSERT INTO document_brand_profiles
       (brand_key, company_name, tagline, address, phone, email, website, pin, logo_filename, till, paybill, bank_name, bank_branch, bank_account_no, payee, created_at, updated_at)
     VALUES ('finemark', 'Fine Mark Tracking Limited', 'Security in Every Mile', 'P.O. Box 12345-00100, Nairobi', '+254 700 000 000', 'info@finemark.co.ke', 'www.finemark.co.ke', 'P051961922E', 'finemark-logo.png', NULL, '4048569', NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT (brand_key) DO NOTHING`,
    [now, now]
  );
  await pgRun(
    `INSERT INTO document_brand_profiles
       (brand_key, company_name, tagline, address, phone, email, website, pin, logo_filename, till, paybill, bank_name, bank_branch, bank_account_no, payee, created_at, updated_at)
     VALUES ('unique', 'Unique Tracking Solutions Limited', 'Vehicle Tracking | Fleet Management | Fuel Management', 'Eastern Bypass, Titan Impex, 1st Floor, P.O. Box 716-00618, Nairobi', NULL, 'solutions@uniquetracking.co.ke', 'www.uniquetracking.co.ke', 'P051961922E', 'unique-tracking-logo.png', '695311', NULL, 'Equity Bank', 'Garden City Mall', '1750281157351', 'Unique Tracking Solutions Ltd', ?, ?)
     ON CONFLICT (brand_key) DO NOTHING`,
    [now, now]
  );
})().catch((e) => console.error("[doc_bank_configs] init:", e));

// ── DTO mappers ─────────────────────────────────────────────────────────────
const mapConfig = (r: any) => ({
  id: r.id,
  partnerId: r.partner_id,
  partnerName: r.partner_name || null,
  displayName: r.display_name,
  template: r.template,
  vatDisplay: r.vat_display,
  billToAddress: r.bill_to_address || null,
  payToBankName: r.pay_to_bank_name || null,
  payToBranch: r.pay_to_branch || null,
  payToAccountNo: r.pay_to_account_no || null,
  payToPayee: r.pay_to_payee || null,
  isDefault: !!r.is_default,
  sortOrder: Number(r.sort_order),
  updatedAt: r.updated_at,
});

const mapBrand = (r: any) => ({
  key: r.brand_key,
  companyName: r.company_name,
  tagline: r.tagline || null,
  address: r.address || null,
  phone: r.phone || null,
  email: r.email || null,
  website: r.website || null,
  pin: r.pin || null,
  logoFilename: r.logo_filename || null,
  till: r.till || null,
  paybill: r.paybill || null,
  bankName: r.bank_name || null,
  bankBranch: r.bank_branch || null,
  bankAccountNo: r.bank_account_no || null,
  payee: r.payee || null,
  updatedAt: r.updated_at,
});

const SELECT_JOIN = `
  SELECT c.*, p.name AS partner_name
  FROM doc_bank_configs c
  LEFT JOIN partners p ON p.id::text = c.partner_id
`;

// ── Partner picker helper (for the admin "Add bank" dropdown) ─────────────────
router.get("/partners", requireAuth, requireRole(ROLE_GROUPS.DOC_CONFIG_ACCESS), async (_req, res) => {
  const rows = await pgAll(`SELECT id, name FROM partners WHERE deleted_at IS NULL ORDER BY name`);
  return ok(res, { data: rows.map((r: any) => ({ id: r.id, name: r.name })) });
});

// ── Brand profiles CRUD ───────────────────────────────────────────────────────
router.get("/brand-profiles", requireAuth, requireRole(ROLE_GROUPS.DOC_CONFIG_ACCESS), async (_req, res) => {
  const rows = await pgAll(`SELECT * FROM document_brand_profiles ORDER BY brand_key`);
  return ok(res, { data: rows.map(mapBrand) });
});

router.patch("/brand-profiles/:key", requireAuth, requireRole(ROLE_GROUPS.DOC_CONFIG_ACCESS), async (req: AuthRequest, res) => {
  if (req.params.key !== "finemark" && req.params.key !== "unique")
    return errorResponse(res, 404, "NOT_FOUND", "Unknown brand profile.");
  const parsed = brandProfileSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data as Record<string, any>;
  const cols: Record<string, string> = {
    companyName: "company_name", tagline: "tagline", address: "address", phone: "phone",
    email: "email", website: "website", pin: "pin", logoFilename: "logo_filename",
    till: "till", paybill: "paybill", bankName: "bank_name", bankBranch: "bank_branch",
    bankAccountNo: "bank_account_no", payee: "payee",
  };
  const setClauses: string[] = [];
  const params: any[] = [];
  for (const [k, col] of Object.entries(cols)) {
    if (d[k] !== undefined) { setClauses.push(`${col} = ?`); params.push(d[k] === "" ? null : d[k]); }
  }
  if (!setClauses.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No fields to update.");
  setClauses.push("updated_by_user_id = ?", "updated_at = ?");
  params.push(req.user?.id, new Date().toISOString(), req.params.key);
  await pgRun(`UPDATE document_brand_profiles SET ${setClauses.join(", ")} WHERE brand_key = ?`, params);
  invalidateDocBrandCache();
  auditLog(req, "DOC_BRAND_PROFILE_UPDATED", `document_brand_profile:${req.params.key}`, "Info", { key: req.params.key }).catch(console.error);
  const row = await pgGet(`SELECT * FROM document_brand_profiles WHERE brand_key = ?`, [req.params.key]);
  return ok(res, mapBrand(row), "Brand profile updated.");
});

// ── doc_bank_configs CRUD (mirrors certificates.ts bank-configs) ──────────────
router.get("/", requireAuth, requireRole(ROLE_GROUPS.DOC_CONFIG_ACCESS), async (_req, res) => {
  const rows = await pgAll(`${SELECT_JOIN} ORDER BY c.sort_order, c.display_name`);
  return ok(res, { data: rows.map(mapConfig) });
});

router.post("/", requireAuth, requireRole(ROLE_GROUPS.DOC_CONFIG_ACCESS), async (req: AuthRequest, res) => {
  const parsed = docBankConfigSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  if (d.partnerId === "DEFAULT") return errorResponse(res, 400, "VALIDATION_ERROR", "'DEFAULT' is reserved.");
  const partner = await pgGet(`SELECT id FROM partners WHERE id::text = ? AND deleted_at IS NULL`, [d.partnerId]);
  if (!partner) return errorResponse(res, 404, "NOT_FOUND", "Partner not found.");

  const now = new Date().toISOString();
  const id = uuidv4();
  const maxSort = await pgGet("SELECT COALESCE(MAX(sort_order), 0) AS m FROM doc_bank_configs WHERE is_default = false");
  try {
    await pgRun(
      `INSERT INTO doc_bank_configs (id, partner_id, display_name, template, vat_display, bill_to_address,
         pay_to_bank_name, pay_to_branch, pay_to_account_no, pay_to_payee, is_default, sort_order, updated_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?, ?, ?)`,
      [id, d.partnerId, d.displayName.trim(), d.template, d.vatDisplay, d.billToAddress?.trim() || null,
       d.payToBankName?.trim() || null, d.payToBranch?.trim() || null, d.payToAccountNo?.trim() || null, d.payToPayee?.trim() || null,
       d.sortOrder ?? (Number((maxSort as any)?.m || 0) + 10), req.user?.id, now, now]
    );
  } catch (error: any) {
    if (error?.code === "23505") return errorResponse(res, 409, "CONFLICT", "This partner already has a document configuration.");
    return errorResponse(res, 500, "INTERNAL", "Failed to save document configuration.");
  }
  invalidateDocBrandCache();
  auditLog(req, "DOC_BANK_CONFIG_CREATED", `doc_bank_config:${id}`, "Info", { partnerId: d.partnerId }).catch(console.error);
  const row = await pgGet(`${SELECT_JOIN} WHERE c.id = ?`, [id]);
  return created(res, mapConfig(row), "Document configuration added.");
});

router.patch("/:id", requireAuth, requireRole(ROLE_GROUPS.DOC_CONFIG_ACCESS), async (req: AuthRequest, res) => {
  const existing = await pgGet("SELECT * FROM doc_bank_configs WHERE id = ?", [req.params.id]);
  if (!existing) return errorResponse(res, 404, "NOT_FOUND", "Document configuration not found.");
  const parsed = updateDocBankConfigSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid input", parsed.error.flatten());
  const d = parsed.data;
  const now = new Date().toISOString();
  const setClauses: string[] = [];
  const params: any[] = [];
  const maybeSet = (col: string, val: any) => { if (val !== undefined) { setClauses.push(`${col} = ?`); params.push(val); } };
  // partner_id / is_default are immutable here (the default row keeps 'DEFAULT')
  maybeSet("display_name", d.displayName?.trim());
  maybeSet("template", d.template);
  maybeSet("vat_display", d.vatDisplay);
  if (d.billToAddress !== undefined) maybeSet("bill_to_address", d.billToAddress?.trim() || null);
  if (d.payToBankName !== undefined) maybeSet("pay_to_bank_name", d.payToBankName?.trim() || null);
  if (d.payToBranch !== undefined) maybeSet("pay_to_branch", d.payToBranch?.trim() || null);
  if (d.payToAccountNo !== undefined) maybeSet("pay_to_account_no", d.payToAccountNo?.trim() || null);
  if (d.payToPayee !== undefined) maybeSet("pay_to_payee", d.payToPayee?.trim() || null);
  maybeSet("sort_order", d.sortOrder);
  if (!setClauses.length) return errorResponse(res, 400, "VALIDATION_ERROR", "No fields to update.");
  setClauses.push("updated_by_user_id = ?", "updated_at = ?");
  params.push(req.user?.id, now, req.params.id);
  await pgRun(`UPDATE doc_bank_configs SET ${setClauses.join(", ")} WHERE id = ?`, params);
  invalidateDocBrandCache();
  auditLog(req, "DOC_BANK_CONFIG_UPDATED", `doc_bank_config:${req.params.id}`, "Info", d).catch(console.error);
  const row = await pgGet(`${SELECT_JOIN} WHERE c.id = ?`, [req.params.id]);
  return ok(res, mapConfig(row), "Document configuration updated.");
});

router.delete("/:id", requireAuth, requireRole(ROLE_GROUPS.DOC_CONFIG_ACCESS), async (req: AuthRequest, res) => {
  const existing = await pgGet("SELECT * FROM doc_bank_configs WHERE id = ?", [req.params.id]);
  if (!existing) return errorResponse(res, 404, "NOT_FOUND", "Document configuration not found.");
  if (existing.is_default) return errorResponse(res, 400, "VALIDATION_ERROR", "The default \"Others\" row can't be deleted, only edited.");
  await pgRun("DELETE FROM doc_bank_configs WHERE id = ?", [req.params.id]);
  invalidateDocBrandCache();
  auditLog(req, "DOC_BANK_CONFIG_DELETED", `doc_bank_config:${req.params.id}`, "Info", { partnerId: existing.partner_id }).catch(console.error);
  return ok(res, { id: req.params.id }, "Document configuration removed.");
});

export default router;
