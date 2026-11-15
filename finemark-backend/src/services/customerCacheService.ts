import { pgAll } from "../db.js";
import { decryptField } from "./cryptoService.js";
import { cacheDeleteByPrefix, cacheGetOrSet } from "../utils/cache.js";

// ── In-memory cache for the by-phone customer dataset (5-min TTL) ─────────────
// Avoids a full DB scan + decrypt on every keystroke from the typeahead, and
// is reused as-is by customerDedupeService.ts (duplicate detection needs the
// exact same decrypted, flat dataset). Extracted out of crm-customers.ts so
// the two can share it without a circular import between a route file and a
// service file.
export type CachedRow = { id: string; accountNo: string; type: string; status: string; region: string;
                   displayName: string; phone: string; email: string; nationalId: string;
                   accountManagerEmail: string; vehicleRegs: string; };
const BY_PHONE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateCustomerCaches() {
  cacheDeleteByPrefix("customers:list:");
  cacheDeleteByPrefix("customers:by-phone:");
}

export async function getByPhoneRows(): Promise<CachedRow[]> {
  return cacheGetOrSet("customers:by-phone:rows", BY_PHONE_TTL_MS, async () => {
    // No LIMIT on any of these three — this cache exists specifically to hold
    // the ENTIRE current dataset in memory for typeahead search + duplicate
    // detection (customerDedupeService.ts). A silent row cap here means any
    // customer/contact/vehicle outside the cap simply never appears in search
    // and is invisible to dedup — with no error surfaced anywhere. (Found via
    // a real case: a customer created 2026-08-20 fell outside a since-removed
    // LIMIT 500 with no ORDER BY, making them unfindable in Certificate
    // Generation's Customer Lookup.) Re-add a cap only alongside pagination
    // logic that actually accounts for the excluded rows, not a bare number.
    const [rows, contacts, vehicles] = await Promise.all([
      pgAll(
        `SELECT c.id, c.account_no, c.type, c.status, c.region,
                COALESCE(ind.full_name, corp.company_name) AS display_name,
                ind.phone_enc, ind.email_enc, ind.national_id_enc,
                u.email AS account_manager_email
         FROM crm_customers c
         LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
         LEFT JOIN crm_corporate_profiles  corp ON corp.customer_id = c.id
         LEFT JOIN users u ON u.id = c.account_manager_id
         WHERE c.deleted_at IS NULL`, []
      ),
      pgAll(
        `SELECT cp.customer_id, cp.phone_enc, cp.email_enc, cp.name
         FROM crm_contact_persons cp WHERE cp.is_primary = 1`, []
      ),
      // Vehicle registrations (unencrypted) so the customer typeahead can also match by plate.
      pgAll(
        `SELECT customer_id, registration FROM crm_customer_vehicles
         WHERE deleted_at IS NULL AND registration IS NOT NULL AND registration <> ''`, []
      ),
    ]);
    const contactMap = new Map<string, { phone: string; email: string; name: string }>();
    for (const c of contacts) {
      if (!contactMap.has(c.customer_id)) {
        contactMap.set(c.customer_id, { phone: decryptField(c.phone_enc) || "", email: decryptField(c.email_enc) || "", name: c.name });
      }
    }
    const regMap = new Map<string, string[]>();
    for (const v of vehicles) {
      const reg = String(v.registration || "").toUpperCase().replace(/\s+/g, "");
      if (!reg) continue;
      const arr = regMap.get(v.customer_id) || [];
      if (!arr.includes(reg)) arr.push(reg);
      regMap.set(v.customer_id, arr);
    }
    return rows.map((row: any) => {
      const contact = contactMap.get(row.id);
      return {
        id: row.id,
        accountNo: row.account_no,
        type: row.type,
        status: row.status,
        region: row.region,
        displayName: row.display_name || contact?.name || "—",
        phone: (decryptField(row.phone_enc) || "").replace(/\s+/g, "") || (contact?.phone || "").replace(/\s+/g, "") || "—",
        email: decryptField(row.email_enc) || contact?.email || "—",
        nationalId: decryptField(row.national_id_enc) || "",
        accountManagerEmail: row.account_manager_email,
        vehicleRegs: (regMap.get(row.id) || []).join(" "),
      } as CachedRow;
    });
  });
}
