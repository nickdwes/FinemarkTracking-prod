/**
 * Retail Quote Automation
 *
 * When a technician assigns a device to a retail-customer installation ticket,
 * this service automatically materialises a linked Draft Quote + Pending-Approval
 * Proforma pre-populated with the device, partner pricing, vehicle and customer.
 *
 * If the technician swaps the device the same records are updated (idempotent).
 * When the installation is marked Completed the customer receives an email with
 * a one-time approval link for the proforma.  Either the customer or Finance
 * can then approve it, triggering the existing invoice-generation flow.
 */

import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { pgGet, pgAll, pgRun } from "../db.js";
import { IdGenerator } from "../utils/idGenerator.js";
import { sendMail } from "../utils/mailer.js";
import { buildProformaEmail } from "../utils/emailTemplates.js";
import { decryptField } from "./cryptoService.js";
import { createNotification } from "../routes/notifications.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const TAX_RATE   = 16; // Standard KRA VAT %
const PORTAL_BASE = (process.env.FRONTEND_URL || "https://portal.finemarktracking.co.ke").replace(/\/$/, "");

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Look up partner pricing for (partner, product, loan term). */
async function resolvePartnerPricing(
  partnerId:      string | null,
  productId:      string | null,
  loanTermMonths: number | null,
): Promise<{ devicePrice: number; installationFee: number; pricingMissing: boolean }> {
  if (!partnerId || !productId) {
    return { devicePrice: 0, installationFee: 0, pricingMissing: true };
  }
  const row = await pgGet(
    `SELECT device_price, installation_fee FROM partner_product_pricing
     WHERE partner_id = ? AND product_id = ? AND loan_term_months = ?`,
    [partnerId, productId, loanTermMonths ?? 0]
  ).catch(() => null);

  if (!row) return { devicePrice: 0, installationFee: 0, pricingMissing: true };
  return {
    devicePrice:     Number(row.device_price    || 0),
    installationFee: Number(row.installation_fee || 0),
    pricingMissing:  false,
  };
}

/** Insert line items into crm_quote_items for the given quote. */
async function insertQuoteItems(
  quoteId:         string,
  device:          any,
  devicePrice:     number,
  installationFee: number,
  now:             string,
): Promise<void> {
  // Device item
  await pgRun(
    `INSERT INTO crm_quote_items
       (id, quote_id, device_model, device_type, description, quantity,
        unit_price, total_price, stock_item_id, stock_item_ids,
        serial_numbers, imei_numbers, product_id, discount_pct, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      uuidv4(), quoteId,
      device.product_name || device.product_model || "GPS Tracker",
      device.product_model || null,
      device.serial_number ? `SN: ${device.serial_number}` : null,
      1, devicePrice, devicePrice,
      device.id,
      JSON.stringify([device.id]),
      JSON.stringify(device.serial_number ? [device.serial_number] : []),
      JSON.stringify(device.imei         ? [device.imei]          : []),
      device.product_id || null,
      0, now,
    ]
  );

  // Installation service item (only when fee > 0)
  if (installationFee > 0) {
    await pgRun(
      `INSERT INTO crm_quote_items
         (id, quote_id, device_model, device_type, description, quantity,
          unit_price, total_price, stock_item_id, stock_item_ids,
          serial_numbers, imei_numbers, product_id, discount_pct, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uuidv4(), quoteId,
        "Installation Service", "Service", null,
        1, installationFee, installationFee,
        null, "[]", "[]", "[]", null, 0, now,
      ]
    );
  }
}

/** Insert line items into crm_proforma_items for the given proforma. */
async function insertProformaItems(
  proformaId:      string,
  device:          any,
  devicePrice:     number,
  installationFee: number,
  now:             string,
): Promise<void> {
  await pgRun(
    `INSERT INTO crm_proforma_items
       (id, proforma_id, device_model, device_type, description,
        quantity, unit_price, total_price, stock_item_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      uuidv4(), proformaId,
      device.product_name || device.product_model || "GPS Tracker",
      device.product_model || null,
      device.serial_number ? `SN: ${device.serial_number}` : null,
      1, devicePrice, devicePrice,
      device.id, now,
    ]
  );

  if (installationFee > 0) {
    await pgRun(
      `INSERT INTO crm_proforma_items
         (id, proforma_id, device_model, device_type, description,
          quantity, unit_price, total_price, stock_item_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        uuidv4(), proformaId,
        "Installation Service", "Service", null,
        1, installationFee, installationFee,
        null, now,
      ]
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface RetailQuoteResult {
  quoteId:        string;
  proformaId:     string;
  quoteNo:        string;
  proformaNo:     string;
  isNew:          boolean;
  pricingMissing: boolean;
}

/**
 * Create (or update) a Draft Quote + Pending-Approval Proforma linked to a
 * retail installation ticket.  Safe to call multiple times — if a quote
 * already exists for this ticket it is updated in-place rather than duplicated.
 */
export async function materializeRetailQuoteForTicket(
  ticketId: string,
  actor:    { userId: string; email: string },
): Promise<RetailQuoteResult> {
  const now = new Date().toISOString();

  // ── 1. Load ticket with retail-lead + vehicle context ─────────────────────
  const ticket = await pgGet(
    `SELECT it.*,
            rl.partner_id      AS lead_partner_id,
            rl.product_id      AS lead_product_id,
            rlv.loan_term_months AS lead_loan_term_months,
            c.affiliate_partner_id AS customer_partner_id
     FROM installation_tickets it
     LEFT JOIN retail_leads          rl  ON rl.id  = it.retail_lead_id
     LEFT JOIN retail_lead_vehicles  rlv ON rlv.lead_id = rl.id
     LEFT JOIN crm_customers         c   ON c.id   = it.customer_id
     WHERE it.id = ? AND it.deleted_at IS NULL`,
    [ticketId]
  );
  if (!ticket) throw new Error(`[retailQuoteAuto] Ticket ${ticketId} not found`);
  if (!ticket.assigned_device_id) throw new Error(`[retailQuoteAuto] Ticket ${ticketId} has no assigned device`);

  // ── 2. Load device + product catalog row ──────────────────────────────────
  const device = await pgGet(
    `SELECT i.id, i.serial_number, i.imei, i.product_id,
            p.product_name, p.product_code,
            p.device_model AS product_model
     FROM inv_items i
     LEFT JOIN inv_product_catalog p ON p.id = i.product_id
     WHERE i.id = ?`,
    [ticket.assigned_device_id]
  );
  if (!device) throw new Error(`[retailQuoteAuto] Device ${ticket.assigned_device_id} not found`);

  // ── 3. Resolve partner + pricing ──────────────────────────────────────────
  const partnerId      = ticket.lead_partner_id || ticket.customer_partner_id || null;
  const productId      = device.product_id || ticket.lead_product_id || null;
  const loanTermMonths = ticket.lead_loan_term_months ? Number(ticket.lead_loan_term_months) : null;

  const { devicePrice, installationFee, pricingMissing } =
    await resolvePartnerPricing(partnerId, productId, loanTermMonths);

  // ── 4. Load vehicle ───────────────────────────────────────────────────────
  const vehicle = ticket.vehicle_id
    ? await pgGet(
        `SELECT id, registration, make, model
         FROM crm_customer_vehicles WHERE id = ?`,
        [ticket.vehicle_id]
      ).catch(() => null)
    : null;

  // ── 5. Compute totals ─────────────────────────────────────────────────────
  const subtotal   = devicePrice + installationFee;
  const vatAmount  = Math.round(subtotal * (TAX_RATE / 100) * 100) / 100;
  const total      = Math.round((subtotal + vatAmount) * 100) / 100;
  const expiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const pricingNote = pricingMissing
    ? "Awaiting partner pricing — Sales Rep to update before sending."
    : null;

  // ── 6. Check for an existing auto-quote for this ticket ───────────────────
  const existingQuote = await pgGet(
    `SELECT id, quote_no FROM crm_quotes
     WHERE installation_ticket_id = ? AND deleted_at IS NULL LIMIT 1`,
    [ticketId]
  );

  let quoteId:    string;
  let quoteNo:    string;
  let proformaId: string;
  let proformaNo: string;
  let isNew = false;

  if (existingQuote) {
    // ── UPDATE path ─────────────────────────────────────────────────────────
    quoteId  = existingQuote.id;
    quoteNo  = existingQuote.quote_no;

    await pgRun(
      `UPDATE crm_quotes
       SET installation_cost  = ?,
           subscription_fee   = ?,
           tax_rate           = ?,
           total_amount       = ?,
           vehicle_id         = ?,
           vehicle_registration = ?,
           partner_id         = ?,
           loan_term_months   = ?,
           notes              = ?,
           pricing_missing    = ?,
           updated_at         = ?
       WHERE id = ?`,
      [
        devicePrice, installationFee, TAX_RATE, total,
        vehicle?.id || null, vehicle?.registration || null,
        partnerId, loanTermMonths,
        pricingNote, pricingMissing ? 1 : 0, now,
        quoteId,
      ]
    );

    // Replace quote items with fresh set (device may have changed)
    await pgRun(`DELETE FROM crm_quote_items WHERE quote_id = ?`, [quoteId]);
    await insertQuoteItems(quoteId, device, devicePrice, installationFee, now);

    // Locate linked proforma
    const pfRow = await pgGet(
      `SELECT id, proforma_no FROM crm_proforma_invoices
       WHERE installation_ticket_id = ? AND deleted_at IS NULL LIMIT 1`,
      [ticketId]
    );
    proformaId = pfRow?.id        ?? "";
    proformaNo = pfRow?.proforma_no ?? "";

    if (proformaId) {
      await pgRun(
        `UPDATE crm_proforma_invoices
         SET installation_cost  = ?,
             subscription_fee   = ?,
             tax_rate           = ?,
             total_amount       = ?,
             vehicle_id         = ?,
             vehicle_registration = ?,
             notes              = ?,
             pricing_missing    = ?,
             updated_at         = ?
         WHERE id = ?`,
        [
          devicePrice, installationFee, TAX_RATE, total,
          vehicle?.id || null, vehicle?.registration || null,
          pricingNote, pricingMissing ? 1 : 0, now,
          proformaId,
        ]
      );
      await pgRun(`DELETE FROM crm_proforma_items WHERE proforma_id = ?`, [proformaId]);
      await insertProformaItems(proformaId, device, devicePrice, installationFee, now);
    }
  } else {
    // ── CREATE path ─────────────────────────────────────────────────────────
    isNew     = true;
    quoteId   = uuidv4();
    quoteNo   = IdGenerator.generateId("quote");    // QTE-XXXXXXXX
    proformaNo = quoteNo.replace(/^QTE-/i, "PFI-"); // PFI-XXXXXXXX (same suffix)
    proformaId = uuidv4();

    // Resolve the sales rep from the retail lead (not the technician actor)
    let salesRepId    = actor.userId;
    let salesRepEmail = actor.email;
    if (ticket.retail_lead_id) {
      const rl = await pgGet("SELECT sales_rep_id, sales_rep_name FROM retail_leads WHERE id = ?", [ticket.retail_lead_id]).catch(() => null);
      if (rl?.sales_rep_id) {
        salesRepId = String(rl.sales_rep_id);
        const repUser = await pgGet("SELECT email FROM users WHERE id::text = ?", [salesRepId]).catch(() => null);
        salesRepEmail = repUser?.email || salesRepEmail;
      }
    }

    // Insert quote
    await pgRun(
      `INSERT INTO crm_quotes
         (id, quote_no, customer_id, lead_id, sales_rep_id, sales_rep_email,
          service_type, status, revision_no,
          installation_cost, subscription_fee, tax_rate, discount_amount, total_amount,
          expiry_date, notes,
          vehicle_id, vehicle_registration, partner_id, loan_term_months,
          installation_ticket_id, auto_generated, pricing_missing,
          created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        quoteId, quoteNo, ticket.customer_id,
        null, salesRepId, salesRepEmail,
        "GPS Tracking Installation", "Draft", 1,
        devicePrice, installationFee, TAX_RATE, 0, total,
        expiryDate, pricingNote,
        vehicle?.id || null, vehicle?.registration || null,
        partnerId, loanTermMonths,
        ticketId, 1, pricingMissing ? 1 : 0,
        actor.userId, now, now,
      ]
    );
    await insertQuoteItems(quoteId, device, devicePrice, installationFee, now);

    // Insert proforma
    await pgRun(
      `INSERT INTO crm_proforma_invoices
         (id, proforma_no, customer_id, quote_id, lead_id, sales_rep_id, status,
          installation_cost, subscription_fee, tax_rate, discount_amount, total_amount,
          notes, vehicle_id, vehicle_registration,
          installation_ticket_id, auto_generated, pricing_missing,
          created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        proformaId, proformaNo, ticket.customer_id,
        quoteId, null, salesRepId, "Pending Approval",
        devicePrice, installationFee, TAX_RATE, 0, total,
        pricingNote,
        vehicle?.id || null, vehicle?.registration || null,
        ticketId, 1, pricingMissing ? 1 : 0,
        actor.userId, now, now,
      ]
    );
    await insertProformaItems(proformaId, device, devicePrice, installationFee, now);

    // Back-link ticket → proforma (so sendProformaApprovalLinkForTicket can find it)
    await pgRun(
      `UPDATE installation_tickets SET proforma_id = ?, updated_at = ? WHERE id = ?`,
      [proformaId, now, ticketId]
    ).catch(console.error);

    // Link retail_lead → quote
    if (ticket.retail_lead_id) {
      await pgRun(
        `UPDATE retail_leads SET quote_id = ?, updated_at = ? WHERE id = ?`,
        [quoteId, now, ticket.retail_lead_id]
      ).catch(console.error);
    }
  }

  // ── 7. Notifications ──────────────────────────────────────────────────────
  createNotification({
    targetRole: "Sales",
    type: "quote",
    title: `Auto-quote ${isNew ? "created" : "updated"}: ${quoteNo}`,
    body: `Quote & proforma auto-generated for ${ticket.customer_name || ticket.customer_id} (ticket ${ticket.ticket_no}).${pricingMissing ? " ⚠ Partner pricing not found — items at KES 0." : ""}`,
    link: `crm-quote-detail.html?id=${quoteId}`,
  }).catch(console.error);

  if (pricingMissing) {
    createNotification({
      targetRole: "Finance",
      type: "warning",
      title: `Auto-quote missing pricing: ${quoteNo}`,
      body: `Quote ${quoteNo} for ${ticket.customer_name || ticket.customer_id} was created with no partner pricing. Items are KES 0 — update before sending to customer.`,
      link: `crm-quote-detail.html?id=${quoteId}`,
    }).catch(console.error);
  }

  return { quoteId, proformaId, quoteNo, proformaNo, isNew, pricingMissing };
}

/**
 * Send a one-time customer approval link for the proforma linked to the given
 * installation ticket.  Called when the ticket is marked Completed.
 * Best-effort — failures are logged but do not throw.
 */
export async function sendProformaApprovalLinkForTicket(ticketId: string): Promise<void> {
  const now = new Date().toISOString();

  const ticket = await pgGet(
    `SELECT proforma_id, ticket_no FROM installation_tickets WHERE id = ? AND deleted_at IS NULL`,
    [ticketId]
  );
  if (!ticket?.proforma_id) {
    console.warn(`[retailQuoteAuto] No proforma_id on ticket ${ticketId} — approval link skipped.`);
    return;
  }

  const pf = await pgGet(
    `SELECT p.*,
            COALESCE(ind.full_name, corp.company_name) AS customer_name,
            u.name AS sales_rep_name,
            COALESCE(ind.email_enc, corp.email_enc)    AS email_enc
     FROM crm_proforma_invoices p
     JOIN crm_customers c ON c.id = p.customer_id
     LEFT JOIN crm_individual_profiles ind ON ind.customer_id = c.id
     LEFT JOIN crm_corporate_profiles  corp ON corp.customer_id = c.id
     LEFT JOIN users u ON u.id = p.sales_rep_id
     WHERE p.id = ? AND p.deleted_at IS NULL`,
    [ticket.proforma_id]
  );
  if (!pf) return;

  const customerEmail = pf.email_enc ? decryptField(pf.email_enc) : null;
  if (!customerEmail || customerEmail === "—") {
    console.warn(`[retailQuoteAuto] No customer email for proforma ${pf.proforma_no} — approval link skipped.`);
    return;
  }

  const items = await pgAll(
    `SELECT * FROM crm_proforma_items WHERE proforma_id = ? ORDER BY created_at`,
    [pf.id]
  );

  // Generate one-time approval token (30-day expiry)
  const rawToken  = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();

  await pgRun(
    `INSERT INTO crm_proforma_approval_tokens (id, proforma_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), pf.id, tokenHash, expiresAt, now]
  );

  const approvalUrl = `${PORTAL_BASE}/crm-proforma-approve.html?token=${rawToken}`;

  const htmlBody = buildProformaEmail({
    customerName:     pf.customer_name || "Customer",
    proformaNo:       pf.proforma_no,
    totalAmount:      pf.total_amount,
    installationCost: pf.installation_cost,
    subscriptionFee:  pf.subscription_fee,
    taxRate:          pf.tax_rate,
    discountAmount:   pf.discount_amount,
    salesRep:         pf.sales_rep_name || null,
    status:           pf.status,
    notes:            pf.notes,
    items: items.map((it: any) => ({
      deviceModel: it.device_model,
      deviceType:  it.device_type,
      quantity:    it.quantity,
      unitPrice:   it.unit_price,
      totalPrice:  it.total_price,
    })),
    approvalUrl,
  });

  await sendMail({
    from:    "Finemark Tracking <customer@finemarktracking.co.ke>",
    to:      customerEmail,
    subject: `Your Installation is Complete — Please Review & Approve: ${pf.proforma_no}`,
    html:    htmlBody,
    text:    `Dear ${pf.customer_name || "Customer"},\n\nYour vehicle installation is complete. Please review and approve your proforma invoice ${pf.proforma_no} for KES ${Number(pf.total_amount).toLocaleString()}.\n\nApproval link: ${approvalUrl}\n\nWarm regards,\nFine Mark Tracking Limited`,
  }).catch((e: any) => console.error("[retailQuoteAuto] approval email send failed:", e?.message));

  createNotification({
    targetRole: "Sales",
    type:       "info",
    title:      `Approval link sent: ${pf.proforma_no}`,
    body:       `Customer approval link emailed for ${pf.proforma_no} on completion of ticket ${ticket.ticket_no}.`,
    link:       `crm-proforma.html?id=${pf.id}`,
  }).catch(console.error);
}

/**
 * Auto-generate a Draft quote for a retail lead financed through a bank in
 * bank_financed_pricing — a flat annual tracking-installation charge billed
 * to the bank, independent of which specific device ends up installed
 * (unlike materializeRetailQuoteForTicket()'s per-device pricing above).
 * Called right after ticket creation in POST /retail/leads/:id/submit.
 *
 * Deliberately does NOT set installation_ticket_id on the quote it creates —
 * that field is what materializeRetailQuoteForTicket() uses to find "the"
 * quote for a ticket, and letting it adopt this one would mean a later
 * device assignment silently overwrites this bank-rate line item with
 * device-specific partner pricing, corrupting a price that's supposed to be
 * flat-rate-by-bank regardless of device. The two automations intentionally
 * stay independent; if a ticket both has a bank-financed lead AND later gets
 * a device assigned, both quotes can coexist rather than one clobbering the
 * other silently.
 *
 * Silent no-op (not an error) when the lead isn't bank-financed, has no
 * matching pricing row, or already has a quote — submission must never fail
 * because of this.
 */
export async function materializeBankFinancedQuoteForLead(
  leadId: string,
  actor: { userId: string; email: string },
): Promise<{ quoteId: string; quoteNo: string } | null> {
  const lead = await pgGet(
    `SELECT rl.*, rlv.loan_term_months, rlv.registration, rlv.chassis_no
     FROM retail_leads rl
     LEFT JOIN retail_lead_vehicles rlv ON rlv.lead_id = rl.id
     WHERE rl.id = ? AND rl.deleted_at IS NULL`,
    [leadId]
  );
  if (!lead) return null;
  if (lead.quote_id) return null; // already quoted — never overwrite
  if (!lead.partner_id || !lead.customer_id || !lead.loan_term_months) return null;

  const years = Math.min(6, Math.max(1, Math.ceil(Number(lead.loan_term_months) / 12)));
  const pricing = await pgGet(
    `SELECT bank_address, year_1, year_2, year_3, year_4, year_5, year_6 FROM bank_financed_pricing WHERE partner_id::text = ?`,
    [String(lead.partner_id)]
  );
  const yearCols = [pricing?.year_1, pricing?.year_2, pricing?.year_3, pricing?.year_4, pricing?.year_5, pricing?.year_6];
  const price = pricing ? yearCols[years - 1] : null;
  if (price == null) {
    console.log(`[bankFinancedQuoteAuto] No bank-financed price for lead ${leadId} (partner ${lead.partner_id}, ${years}yr) — skipped.`);
    return null;
  }

  const now = new Date().toISOString();
  const quoteId = uuidv4();
  const quoteNo = IdGenerator.generateId("quote");
  const vehicleRef = lead.registration || lead.chassis_no || "the vehicle";
  const termLabel = years === 1 ? "1 year" : `${years} years`;
  const description = `Supply and installation of a vehicle tracking system for ${vehicleRef}, for a bank financing period of ${termLabel}.`;

  const taxRate = TAX_RATE;
  const total = Math.round(Number(price) * (1 + taxRate / 100) * 100) / 100;

  await pgRun(
    `INSERT INTO crm_quotes
       (id, quote_no, customer_id, lead_id, sales_rep_id, sales_rep_email,
        service_type, status, revision_no,
        installation_cost, subscription_fee, tax_rate, discount_amount, total_amount,
        partner_id, loan_term_months, bill_to_bank,
        auto_generated, pricing_missing,
        created_by_user_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      quoteId, quoteNo, lead.customer_id, leadId, lead.sales_rep_id, actor.email,
      "Bank Financed Vehicle Tracking Installation", "Draft", 1,
      Number(price), 0, taxRate, 0, total,
      lead.partner_id, Number(lead.loan_term_months), 1,
      1, 0,
      actor.userId, now, now,
    ]
  );

  await pgRun(
    `INSERT INTO crm_quote_items
       (id, quote_id, device_model, device_type, description, quantity, unit_price, total_price,
        stock_item_ids, serial_numbers, imei_numbers, discount_pct, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uuidv4(), quoteId, "VTI", "Vehicle Tracking", description, 1, Number(price), Number(price), "[]", "[]", "[]", 0, now]
  );

  await pgRun(`UPDATE retail_leads SET quote_id = ?, updated_at = ? WHERE id = ?`, [quoteId, now, leadId]);

  createNotification({
    targetRole: "BDM",
    type: "quote",
    title: `Bank-financed quote created: ${quoteNo}`,
    body: `Draft quote auto-generated for ${lead.customer_name} (${termLabel} @ bank rate). Ready for BDM approval.`,
    link: `crm-quote-detail.html?id=${quoteId}`,
  }).catch(console.error);

  return { quoteId, quoteNo };
}
