import { pgGet } from "../db.js";

// Resolves, for a commercial document (quote / proforma / invoice), which company
// brand (letterhead + payment identity) and which VAT presentation to use, based on
// the document's partner bank. Backed by doc_bank_configs + document_brand_profiles
// (see routes/doc-bank-configs.ts). Presentation only — never touches stored totals.

export type BrandProfile = {
  key: "finemark" | "unique";
  companyName: string;
  tagline: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  pin: string | null;
  logoFilename: string | null;
  till: string | null;
  paybill: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankAccountNo: string | null;
  payee: string | null;
};

export type VatDisplay = "auto" | "inclusive" | "inclusive_hidden" | "exclusive" | "zero_rated" | "none";

export type ResolvedDocBrand = {
  template: "finemark" | "unique";
  vatDisplay: VatDisplay;
  brand: BrandProfile;
  displayName: string | null;
  /** True when a partner-specific bank config matched (not the default/fallback). */
  isBank: boolean;
  /** Standard "Bill To" name for bank-financed documents (the bank's official name). */
  billToName: string | null;
  /** Standard "Bill To" address for the bank (config override → partner postal address). */
  billToAddress: string | null;
};

// Ultimate fallback if the tables aren't seeded yet — matches the historical
// hardcoded Finemark letterhead in quoteTemplate.ts, so behaviour is unchanged.
const FALLBACK_FINEMARK: BrandProfile = {
  key: "finemark",
  companyName: "Fine Mark Tracking Limited",
  tagline: "Security in Every Mile",
  address: "P.O. Box 12345-00100, Nairobi",
  phone: "+254 700 000 000",
  email: "info@finemark.co.ke",
  website: "www.finemark.co.ke",
  pin: "P051961922E",
  logoFilename: "finemark-logo.png",
  till: null, paybill: null, bankName: null, bankBranch: null, bankAccountNo: null, payee: null,
};

const _cache = new Map<string, ResolvedDocBrand>();
export function invalidateDocBrandCache(): void { _cache.clear(); }

function mapBrandRow(r: any): BrandProfile {
  return {
    key: r.brand_key === "unique" ? "unique" : "finemark",
    companyName: r.company_name,
    tagline: r.tagline ?? null,
    address: r.address ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    website: r.website ?? null,
    pin: r.pin ?? null,
    logoFilename: r.logo_filename ?? null,
    till: r.till ?? null,
    paybill: r.paybill ?? null,
    bankName: r.bank_name ?? null,
    bankBranch: r.bank_branch ?? null,
    bankAccountNo: r.bank_account_no ?? null,
    payee: r.payee ?? null,
  };
}

export async function loadBrand(key: "finemark" | "unique"): Promise<BrandProfile> {
  const row = await pgGet(`SELECT * FROM document_brand_profiles WHERE brand_key = ?`, [key]).catch(() => null);
  if (row) return mapBrandRow(row);
  return FALLBACK_FINEMARK;
}

export async function resolveDocBrand(
  partnerId: string | null | undefined,
  overrideTemplate?: string | null,
): Promise<ResolvedDocBrand> {
  const cacheKey = `${partnerId || "none"}|${overrideTemplate || ""}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;

  let cfg: any = null;
  let isBank = false;
  if (partnerId) {
    cfg = await pgGet(`SELECT * FROM doc_bank_configs WHERE partner_id = ?`, [String(partnerId)]).catch(() => null);
    if (cfg && !cfg.is_default) isBank = true;
  }
  if (!cfg) {
    cfg = await pgGet(`SELECT * FROM doc_bank_configs WHERE is_default = true LIMIT 1`).catch(() => null);
  }

  const cfgTemplate: "finemark" | "unique" = cfg?.template === "unique" ? "unique" : "finemark";
  const template: "finemark" | "unique" =
    overrideTemplate === "finemark" || overrideTemplate === "unique" ? overrideTemplate : cfgTemplate;
  const vatDisplay: VatDisplay =
    ["auto", "inclusive", "inclusive_hidden", "exclusive", "zero_rated", "none"].includes(cfg?.vat_display) ? cfg.vat_display : "auto";
  const brand = await loadBrand(template);

  // Standard bill-to for a bank-financed document: bank name + its official address.
  // Address prefers the config override, falling back to the partner's postal address.
  let billToName: string | null = null;
  let billToAddress: string | null = null;
  if (isBank && partnerId) {
    const partner = await pgGet(`SELECT name, postal_address FROM partners WHERE id::text = ? AND deleted_at IS NULL`, [String(partnerId)]).catch(() => null);
    billToName = cfg?.display_name || partner?.name || null;
    const rawAddr = (cfg?.bill_to_address && String(cfg.bill_to_address).trim()) || partner?.postal_address || null;
    billToAddress = rawAddr ? String(rawAddr).replace(/\r?\n/g, ", ").replace(/,\s*$/, "").trim() : null;
  }

  const resolved: ResolvedDocBrand = { template, vatDisplay, brand, displayName: cfg?.display_name ?? null, isBank, billToName, billToAddress };
  _cache.set(cacheKey, resolved);
  return resolved;
}
