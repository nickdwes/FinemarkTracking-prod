import { getByPhoneRows, CachedRow } from "./customerCacheService.js";
import { normalizeKePhoneStrict } from "../utils/validators.js";

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

export type MatchField = "name+phone" | "name+email";

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
  excludeCustomerId?: string
): Promise<DuplicateMatch[]> {
  const name = normalizeName(input.name);
  const phone = normalizePhoneForMatch(input.phone);
  const email = normalizeEmailForMatch(input.email);
  if (!name || (!phone && !email)) return [];

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
    if (matchedOn.length) {
      matches.push({
        customerId: row.id, accountNo: row.accountNo, type: row.type,
        displayName: row.displayName, phone: row.phone, email: row.email, matchedOn,
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
