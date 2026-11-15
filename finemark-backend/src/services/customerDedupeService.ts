import { getByPhoneRows, CachedRow } from "./customerCacheService.js";
import { normalizeKePhoneStrict } from "../utils/validators.js";
import { pgAll, pgGet } from "../db.js";
import { decryptField } from "./cryptoService.js";

// Duplicate-customer detection — matches on (name + phone) OR (name + email),
// never phone-alone or email-alone (a shared line/inbox with a different name
// is more likely a family member or shared office contact than the same
// customer re-registered). Phone/email on crm_individual_profiles and
// crm_contact_persons are AES-256-GCM encrypted with a random IV per call
// (see cryptoService.ts) — there is no deterministic ciphertext to compare in
// SQL, so this reuses crm-customers.ts's existing decrypt-and-cache dataset
// (getByPhoneRows, 5-min TTL) rather than decrypting the whole table again.

export function normalizeName(v: unknown): string {
  if (typeof v !== "string" || isBlankSentinel(v)) return "";
  return v.trim().toLowerCase().replace(/\s+/g, " ");
}

// getByPhoneRows() (crm-customers.ts) fills missing name/phone/email with the
// literal placeholder "—" for display purposes — without this guard that
// placeholder gets treated as a real, matching value, so every customer with
// no phone/email on file would falsely "match" every other one that's also
// missing it. Never treat the sentinel as a real value to compare on.
function isBlankSentinel(v: string): boolean {
  return !v.trim() || v.trim() === "—";
}

// Best-effort: canonical 254XXXXXXXXX for real Kenyan numbers; falls back to
// a bare digit string for anything else already in the database that isn't
// strictly KE-formatted, so older/foreign records can still match each other
// consistently rather than being silently excluded from matching entirely.
export function normalizePhoneForMatch(v: unknown): string {
  if (typeof v !== "string" || isBlankSentinel(v)) return "";
  return normalizeKePhoneStrict(v) || v.replace(/\D/g, "");
}

export function normalizeEmailForMatch(v: unknown): string {
  if (typeof v !== "string" || isBlankSentinel(v)) return "";
  return v.trim().toLowerCase();
}

export type MatchField = "name+phone" | "name+email" | "name";

export interface DuplicateMatch {
  customerId: string;
  accountNo: string;
  type: string;
  displayName: string;
  phone: string;
  email: string;
  matchedOn: MatchField[];
}

// For a single candidate (about to be created) — used at the point of
// creation to block/warn or to silently link to the existing record instead
// of inserting a new one, depending on the caller (see the three creation
// entry points in retail-leads.ts, crm-leads.ts, crm-customers.ts).
export async function findDuplicateCustomers(
  input: { name?: string | null; phone?: string | null; email?: string | null },
  excludeCustomerId?: string,
  opts: { nameOnly?: boolean } = {},
): Promise<DuplicateMatch[]> {
  const name = normalizeName(input.name);
  const phone = normalizePhoneForMatch(input.phone);
  const email = normalizeEmailForMatch(input.email);
  // With opts.nameOnly (used by the unattended corporate retail-lead auto-link), a
  // normalised-name match alone is enough — corporate company names are specific, and
  // every repeat lead for the same company otherwise created a fresh customer because
  // its contact phone/email differed. Individuals stay strict (name + phone/email).
  if (!name || (!opts.nameOnly && !phone && !email)) return [];

  const rows = await getByPhoneRows();
  const matches: DuplicateMatch[] = [];
  for (const row of rows) {
    if (excludeCustomerId && row.id === excludeCustomerId) continue;
    if (normalizeName(row.displayName) !== name) continue;
    const rowPhone = normalizePhoneForMatch(row.phone);
    const rowEmail = normalizeEmailForMatch(row.email);
    const matchedOn: MatchField[] = [];
    if (phone && rowPhone && rowPhone === phone) matchedOn.push("name+phone");
    if (email && rowEmail && rowEmail === email) matchedOn.push("name+email");
    if (!matchedOn.length && opts.nameOnly) matchedOn.push("name");
    if (matchedOn.length) {
      matches.push({
        customerId: row.id, accountNo: row.accountNo, type: row.type,
        displayName: row.displayName, phone: row.phone, email: row.email, matchedOn,
      });
    }
  }
  return matches;
}

// Live (uncached) duplicate check for the human-facing CREATE path.
// getByPhoneRows() is a 5-min cache — a customer created moments ago (within
// the same cache window) can slip past findDuplicateCustomers and a duplicate
// gets created. Display name is PLAINTEXT (crm_individual_profiles.full_name
// / crm_corporate_profiles.company_name), so we filter to the handful of same-name
// candidates in SQL, then decrypt only those to confirm phone/email — accurate and
// cheap, with no cache lag. Same match rules as findDuplicateCustomers.
export async function findDuplicateCustomersLive(
  input: { name?: string | null; phone?: string | null; email?: string | null },
  opts: { nameOnly?: boolean } = {},
): Promise<DuplicateMatch[]> {
  const name = normalizeName(input.name);
  const phone = normalizePhoneForMatch(input.phone);
  const email = normalizeEmailForMatch(input.email);
  if (!name || (!opts.nameOnly && !phone && !email)) return [];

  // Name-scoped: normalise the stored display name the same way normalizeName does
  // (trim → lowercase → collapse internal whitespace) and compare to the input name.
  const rows = await pgAll(
    `SELECT c.id, c.account_no, c.type,
            COALESCE(ind.full_name, corp.company_name) AS display_name,
            ind.phone_enc AS ind_phone_enc, ind.email_enc AS ind_email_enc
       FROM crm_customers c
       LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
       LEFT JOIN crm_corporate_profiles  corp ON corp.customer_id = c.id
      WHERE c.deleted_at IS NULL
        AND TRIM(LOWER(REGEXP_REPLACE(COALESCE(ind.full_name, corp.company_name), '\\s+', ' ', 'g'))) = ?`,
    [name],
  );

  const matches: DuplicateMatch[] = [];
  for (const row of rows as any[]) {
    let rowPhone = normalizePhoneForMatch(decryptField(row.ind_phone_enc));
    let rowEmail = normalizeEmailForMatch(decryptField(row.ind_email_enc));
    // Fall back to the primary contact person when the profile has no phone/email.
    if ((!rowPhone && phone) || (!rowEmail && email)) {
      const cp = await pgGet(
        `SELECT phone_enc, email_enc FROM crm_contact_persons WHERE customer_id = ? ORDER BY is_primary DESC, created_at LIMIT 1`,
        [row.id],
      ).catch(() => null);
      if (cp) {
        rowPhone = rowPhone || normalizePhoneForMatch(decryptField(cp.phone_enc));
        rowEmail = rowEmail || normalizeEmailForMatch(decryptField(cp.email_enc));
      }
    }
    const matchedOn: MatchField[] = [];
    if (phone && rowPhone && rowPhone === phone) matchedOn.push("name+phone");
    if (email && rowEmail && rowEmail === email) matchedOn.push("name+email");
    if (!matchedOn.length && opts.nameOnly) matchedOn.push("name");
    if (matchedOn.length) {
      matches.push({
        customerId: row.id, accountNo: row.account_no, type: row.type,
        displayName: row.display_name || "—",
        phone: decryptField(row.ind_phone_enc) || "—",
        email: decryptField(row.ind_email_enc) || "—",
        matchedOn,
      });
    }
  }
  return matches;
}

export interface DuplicateCluster {
  matchedOn: MatchField[];
  customers: Array<Pick<CachedRow, "id" | "accountNo" | "type" | "displayName" | "phone" | "email">>;
}

// Whole-table scan — for an initial audit of existing data, not called on any
// request path (O(n^2) pairwise comparison within each name group; fine at
// the current ~70-customer scale, not meant for a hot path at 10x+ that size).
export async function scanAllCustomersForDuplicates(): Promise<DuplicateCluster[]> {
  const rows = await getByPhoneRows();
  const clusters: DuplicateCluster[] = [];
  const consumed = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (consumed.has(a.id)) continue;
    const aName = normalizeName(a.displayName);
    if (!aName) continue;
    const aPhone = normalizePhoneForMatch(a.phone);
    const aEmail = normalizeEmailForMatch(a.email);
    const group: CachedRow[] = [a];
    const matchedOnSet = new Set<MatchField>();

    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      if (consumed.has(b.id)) continue;
      if (normalizeName(b.displayName) !== aName) continue;
      const bPhone = normalizePhoneForMatch(b.phone);
      const bEmail = normalizeEmailForMatch(b.email);
      let matched = false;
      if (aPhone && bPhone && aPhone === bPhone) { matchedOnSet.add("name+phone"); matched = true; }
      if (aEmail && bEmail && aEmail === bEmail) { matchedOnSet.add("name+email"); matched = true; }
      if (matched) { group.push(b); consumed.add(b.id); }
    }

    if (group.length > 1) {
      consumed.add(a.id);
      clusters.push({
        matchedOn: [...matchedOnSet],
        customers: group.map((g) => ({ id: g.id, accountNo: g.accountNo, type: g.type, displayName: g.displayName, phone: g.phone, email: g.email })),
      });
    }
  }
  return clusters;
}
