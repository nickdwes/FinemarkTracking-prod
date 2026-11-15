import { pgGet, pgAll, pgRun } from "../db.js";

/**
 * Non-inventory ("service") products: products whose category has
 * tracks_inventory = false (e.g. the seeded "Services" category, SV).
 * They can be quoted / invoiced but never hold stock — no inv_items, no
 * serials/IMEIs, no SIM pairing, no reorder alerts, no purchase orders.
 */

/** SQL predicate (alias of inv_product_categories) — true for stock-tracked categories. */
export const CAT_TRACKS_INVENTORY = (alias = "c") => `COALESCE(${alias}.tracks_inventory, true) = true`;

/** SQL predicate for a product alias — true when its category tracks inventory. */
export const PRODUCT_TRACKS_INVENTORY = (productAlias = "p") =>
  `NOT EXISTS (SELECT 1 FROM inv_product_categories nsc WHERE nsc.id = ${productAlias}.category_id AND nsc.tracks_inventory = false)`;

export async function isNonStockProduct(productId: string | null | undefined): Promise<boolean> {
  if (!productId) return false;
  const row: any = await pgGet(
    `SELECT c.tracks_inventory FROM inv_product_catalog p
     JOIN inv_product_categories c ON c.id = p.category_id WHERE p.id = ?`,
    [String(productId)]
  ).catch(() => null);
  return !!row && row.tracks_inventory === false;
}

export const NON_STOCK_MESSAGE =
  "This is a service product (no inventory). It cannot be received into stock, issued or put on a purchase order.";

/* ── Service-only installation tickets ─────────────────────────────────────────
 * A ticket is "service only" (no gadget required) when everything sold on it is
 * a non-inventory product. Detected from, in order:
 *   1. product lines on the linked quote(s) — ticket / proforma / invoice / retail lead
 *      quote, plus any productId inside devices_json. ALL product lines must be
 *      services (a mixed quote still needs a gadget). Custom free-text lines are ignored.
 *   2. otherwise the ticket's product category (corporate tickets / retail leads)
 *      matching a no-inventory category by name or code.
 * Detection only ever turns the flag ON; switching it off is a deliberate manual act. */
export async function detectServiceOnlyTicket(ticketId: string): Promise<boolean> {
  const t: any = await pgGet(
    `SELECT it.quote_id, it.proforma_id, it.invoice_id, it.retail_lead_id, it.devices_json, it.product_category,
            pf.quote_id AS pf_quote_id, inv.quote_id AS inv_quote_id, rl.quote_id AS rl_quote_id,
            rl.product_category_name AS rl_category
     FROM installation_tickets it
     LEFT JOIN crm_proforma_invoices pf ON pf.id = it.proforma_id
     LEFT JOIN invoices inv ON inv.id = it.invoice_id
     LEFT JOIN retail_leads rl ON rl.id = it.retail_lead_id
     WHERE it.id = ?`, [ticketId]
  ).catch(() => null);
  if (!t) return false;

  const productIds = new Set<string>();
  const quoteIds = [t.quote_id, t.pf_quote_id, t.inv_quote_id, t.rl_quote_id].filter(Boolean).map(String);
  for (const qid of new Set(quoteIds)) {
    const items = await pgAll(`SELECT product_id FROM crm_quote_items WHERE quote_id = ? AND product_id IS NOT NULL`, [qid]).catch(() => []);
    for (const it of items as any[]) if (it.product_id) productIds.add(String(it.product_id));
  }
  try {
    for (const d of JSON.parse(t.devices_json || "[]")) if (d?.productId) productIds.add(String(d.productId));
  } catch { /* ignore malformed devices_json */ }

  if (productIds.size) {
    const ids = [...productIds];
    const rows = await pgAll(
      `SELECT p.id, COALESCE(c.tracks_inventory, true) AS tracks
       FROM inv_product_catalog p LEFT JOIN inv_product_categories c ON c.id = p.category_id
       WHERE p.id IN (${ids.map(() => "?").join(",")})`, ids
    ).catch(() => []);
    return (rows as any[]).length > 0 && (rows as any[]).every((r) => r.tracks === false);
  }

  const cat = String(t.product_category || t.rl_category || "").trim();
  if (!cat) return false;
  const hit = await pgGet(
    `SELECT id FROM inv_product_categories WHERE tracks_inventory = false AND (LOWER(name) = LOWER(?) OR UPPER(code) = UPPER(?)) LIMIT 1`,
    [cat, cat]
  ).catch(() => null);
  return !!hit;
}

/** Sets service_only = true when detection says so. Returns the effective flag. */
export async function markServiceOnlyIfApplicable(ticketId: string): Promise<boolean> {
  const cur: any = await pgGet(`SELECT service_only, service_only_locked FROM installation_tickets WHERE id = ?`, [ticketId]).catch(() => null);
  if (!cur) return false;
  if (cur.service_only === true) return true;
  if (cur.service_only_locked === true) return false;   // a person explicitly switched it off
  if (!(await detectServiceOnlyTicket(ticketId))) return false;
  await pgRun(`UPDATE installation_tickets SET service_only = true WHERE id = ?`, [ticketId]).catch(() => {});
  return true;
}
