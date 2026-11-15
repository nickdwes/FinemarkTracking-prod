import { pgGet, pgAll, pgRun } from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { createInvoice } from "./invoiceService.js";
import { createNotification } from "../routes/notifications.js";

const VAT_RATE_PCT = 16; // standard KRA VAT — partner pricing is quoted inclusive of this.

/**
 * Auto-fulfil a PARTNER-PRICED quotation the moment it is APPROVED:
 *   ensure a proforma exists → auto-approve it → generate the customer invoice,
 * with no manual intervention.
 *
 * This mirrors the invoice half of the manual Finance approval in
 * `crm-proforma.ts POST /:id/approve` — keep the VAT/invoice logic in sync with it.
 * Partner-priced quotes are retail leads that already own an RTL installation
 * ticket, so no NEW ticket is created here (we link the existing one).
 *
 * Silent no-op (never throws to the caller) for: non-partner quotes, or a proforma
 * that isn't Pending Approval (already processed). Idempotent — re-running after the
 * proforma is Approved does nothing.
 */
/**
 * The installation TICKET this proforma belongs to. Resolved from the proforma
 * itself — its ticket, else its lead, else its vehicle. The old code took the
 * customer's most recent retail lead regardless of vehicle, so a customer with
 * two machines had the WRONG ticket repointed onto this job's installation
 * record: that ticket then sat on a finished installation and could never
 * start (the job card never reached device selection). 236 customers have more
 * than one lead. When it stays ambiguous, link nothing rather than the wrong one.
 */
async function resolveProformaTicket(pf: any) {
  const SEL = "SELECT id, ticket_no, vi_installation_id FROM installation_tickets WHERE";
  if (pf.installation_ticket_id) {
    const t = await pgGet<any>(`${SEL} id = ? AND deleted_at IS NULL`, [pf.installation_ticket_id]).catch(() => null);
    if (t) return t;
  }
  if (pf.lead_id) {
    const t = await pgGet<any>(
      `SELECT t.id, t.ticket_no, t.vi_installation_id
         FROM retail_leads l
         JOIN installation_tickets t ON t.ticket_no = l.installation_ticket_no AND t.deleted_at IS NULL
        WHERE l.id = ? AND l.deleted_at IS NULL LIMIT 1`,
      [pf.lead_id],
    ).catch(() => null);
    if (t) return t;
  }
  if (pf.vehicle_id) {
    const t = await pgGet<any>(`${SEL} vehicle_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [pf.vehicle_id]).catch(() => null);
    if (t) return t;
  }
  // Fall back to the customer's lead only when they have exactly one.
  const leads = await pgAll<any>(
    `SELECT installation_ticket_no FROM retail_leads
      WHERE customer_id = ? AND deleted_at IS NULL AND installation_ticket_no IS NOT NULL
      ORDER BY created_at DESC LIMIT 2`,
    [pf.customer_id],
  ).catch(() => []);
  if (leads.length === 1) {
    return await pgGet<any>(`${SEL} ticket_no = ? AND deleted_at IS NULL`, [leads[0].installation_ticket_no]).catch(() => null);
  }
  return null;
}

export async function autoFulfilPartnerQuote(
  quoteId: string,
  actor: { id: string; email: string },
): Promise<{ proformaId: string; invoiceId: string | null; invoiceNumber: string | null } | null> {
  const quote = await pgGet<any>("SELECT * FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [quoteId]);
  if (!quote) return null;
  // Only partner-priced quotations auto-fulfil (partner_id set, or VAT-inclusive partner pricing).
  if (!quote.partner_id && !quote.vat_inclusive) return null;
  // Never auto-create a real invoice from an unpriced quote — this was the actual
  // source of a batch of real KES-0 invoices (job-card completion calls this with
  // no user in the loop to catch it, unlike the accept/bdm-approve HTTP endpoints,
  // which have their own explicit guard). Silent no-op, same contract as the
  // partner-id check above: leaves the quote/proforma as-is for Sales to price.
  if (quote.pricing_missing) return null;

  const now = new Date().toISOString();

  // ── 1. Ensure a Pending-Approval proforma exists ───────────────────────────
  // Per-device partner quotes already have one (from retailQuoteAutomation); the
  // bank-financed path does not, so create it here.
  let pf = await pgGet<any>("SELECT * FROM crm_proforma_invoices WHERE quote_id = ? AND deleted_at IS NULL", [quoteId]);
  if (!pf) {
    const pfId = uuidv4();
    const proformaNo = /^QTE-/i.test(quote.quote_no) ? quote.quote_no.replace(/^QTE-/i, "PFI-") : `PFI-${quote.quote_no}`;
    await pgRun(
      `INSERT INTO crm_proforma_invoices
         (id, proforma_no, customer_id, quote_id, lead_id, sales_rep_id, status,
          installation_cost, subscription_fee, tax_rate, discount_amount, total_amount,
          notes, vehicle_id, vehicle_registration, vat_inclusive,
          created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [pfId, proformaNo, quote.customer_id, quote.id, quote.lead_id, quote.sales_rep_id, "Pending Approval",
       quote.installation_cost, quote.subscription_fee, quote.tax_rate, quote.discount_amount, quote.total_amount,
       quote.notes, quote.vehicle_id || null, quote.vehicle_registration || null, quote.vat_inclusive ? 1 : 0,
       actor.id, now, now],
    );
    const qItems = await pgAll<any>("SELECT * FROM crm_quote_items WHERE quote_id = ? ORDER BY created_at", [quote.id]);
    for (const it of qItems) {
      await pgRun(
        `INSERT INTO crm_proforma_items
           (id, proforma_id, device_model, device_type, description, quantity, unit_price, total_price,
            stock_item_ids, serial_numbers, imei_numbers, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), pfId, it.device_model, it.device_type, it.description, it.quantity, it.unit_price, it.total_price,
         it.stock_item_ids || "[]", it.serial_numbers || "[]", it.imei_numbers || "[]", now],
      ).catch(() => {});
    }
    pf = await pgGet<any>("SELECT * FROM crm_proforma_invoices WHERE id = ?", [pfId]);
  }
  if (!pf) return null;
  if (pf.status !== "Pending Approval") {
    return { proformaId: pf.id, invoiceId: pf.invoice_id || null, invoiceNumber: null };
  }

  // ── 2. Auto-approve the proforma (bypasses maker-checker by design) ─────────
  await pgRun(
    `UPDATE crm_proforma_invoices SET status='Approved', approved_by=?, approved_at=?, approval_method='auto_partner', updated_at=? WHERE id=?`,
    [`${actor.email} (auto — partner quote approval)`, now, now, pf.id],
  );

  // ── 3. Generate the customer invoice (mirrors crm-proforma /:id/approve) ────
  const pfItems = await pgAll<any>("SELECT * FROM crm_proforma_items WHERE proforma_id = ? ORDER BY created_at", [pf.id]);
  const custRow = await pgGet<any>(
    `SELECT COALESCE(i.full_name, corp.company_name) AS name
     FROM crm_customers c
     LEFT JOIN crm_individual_profiles i ON i.customer_id = c.id
     LEFT JOIN crm_corporate_profiles corp ON corp.customer_id = c.id
     WHERE c.id = ?`,
    [pf.customer_id],
  );
  const customerName = custRow?.name || "Customer";

  // Partner (vat_inclusive) proformas carry tax_rate=0 but ARE 16% VAT-inclusive.
  const VAT_RATE = (pf.vat_inclusive ? VAT_RATE_PCT : Number(pf.tax_rate || 0)) / 100;
  const grossTotal = Number(pf.total_amount || 0);
  const subtotal = VAT_RATE > 0 ? grossTotal / (1 + VAT_RATE) : grossTotal;
  const vatTotal = grossTotal - subtotal;
  const today = now.slice(0, 10);
  const dueDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const derivedInvoiceNo = /^PFI-/i.test(pf.proforma_no) ? String(pf.proforma_no).replace(/^PFI-/i, "INV-") : undefined;

  let invoiceId: string | null = null;
  let invoiceNumber: string | null = null;
  try {
    const inv = await createInvoice({
      invoiceNumber: derivedInvoiceNo, customer: customerName, vatMode: "exclusive",
      taxDate: today, subtotal, vatTotal, total: grossTotal, amount: grossTotal,
      currency: "KES", status: "Unpaid", issuedOn: today, dueOn: dueDate,
      details: { proformaNo: pf.proforma_no, source: "partner_quote_auto_approval" },
    } as any);
    invoiceId = inv.id;
    invoiceNumber = inv.invoiceNumber;
    for (const it of pfItems) {
      const lineVat = VAT_RATE > 0
        ? (pf.vat_inclusive ? Number(it.total_price) - Number(it.total_price) / (1 + VAT_RATE) : Number(it.total_price) * VAT_RATE)
        : 0;
      await pgRun(
        `INSERT INTO invoice_items (id, invoice_id, item, description, qty, rate, amount, vat) VALUES (?,?,?,?,?,?,?,?)`,
        // description column must carry the line's real description (e.g. "Vehicle
        // installation for the loan duration of 3 years"), not the device_type — the
        // latter overwrote it and the invoice PDF then only showed "Vehicle Tracking".
        [uuidv4(), inv.id, it.device_model, it.description || it.device_type || null, it.quantity, Number(it.unit_price), Number(it.total_price), lineVat],
      );
    }
    await pgRun(`UPDATE crm_proforma_invoices SET invoice_id=?, updated_at=? WHERE id=?`, [inv.id, now, pf.id]);
    const salesRepUser = pf.sales_rep_id ? await pgGet<any>("SELECT email FROM users WHERE id = ?", [pf.sales_rep_id]) : null;
    await pgRun(
      `UPDATE invoices SET customer_id=?, quote_id=?, proforma_id=?, sales_person=?, updated_at=? WHERE id=?`,
      [pf.customer_id, pf.quote_id || null, pf.id, salesRepUser?.email || null, now, inv.id],
    ).catch((e: any) => console.error("[partnerQuoteFulfilment] invoice FK update failed:", e?.message));
  } catch (e: any) {
    console.error("[partnerQuoteFulfilment] invoice creation failed:", e?.message);
  }

  // ── 4. vi_installation + link the existing RTL installation ticket ──────────
  // Reuse the vehicle's existing installation if one already exists (a completed job,
  // or an active one). Blindly inserting a fresh stub here duplicates the real
  // installation and repoints the RTL ticket away from the completed record onto an
  // empty Pending row — the exact drift that produced the orphaned-stub cleanup.
  const rtlTicket = await resolveProformaTicket(pf);
  // This job's own record first. Otherwise only a record for the same vehicle
  // that NO other ticket already owns — reusing a claimed one is what left two
  // tickets sharing a single installation (65 records, 15 tickets unstartable).
  let instId: string | null = rtlTicket?.vi_installation_id || null;
  if (!instId && pf.vehicle_id) {
    const existingInst = await pgGet<any>(
      `SELECT v.id FROM vi_installations v
        WHERE v.vehicle_id = ? AND v.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM installation_tickets t
             WHERE t.vi_installation_id = v.id AND t.deleted_at IS NULL
               AND (?::text IS NULL OR t.id <> ?::text))
        ORDER BY (v.completed_at IS NOT NULL) DESC, v.completed_at DESC NULLS LAST, v.created_at DESC
        LIMIT 1`,
      [pf.vehicle_id, rtlTicket?.id ?? null, rtlTicket?.id ?? null],
    ).catch(() => null);
    instId = existingInst?.id || null;
  }
  if (!instId) {
    instId = uuidv4();
    await pgRun(
      `INSERT INTO vi_installations (id, vehicle_id, customer_id, ticket_ref, status, stage, created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?, 'Pending', 0, ?, ?, ?)`,
      [instId, pf.vehicle_id || null, pf.customer_id, pf.proforma_no, actor.id, now, now],
    ).catch((e: any) => console.error("[partnerQuoteFulfilment] vi_installation failed:", e?.message));
  }
  await pgRun(`UPDATE crm_proforma_invoices SET converted_to_installation_id=?, updated_at=? WHERE id=?`, [instId, now, pf.id]).catch(() => {});
  if (rtlTicket?.ticket_no) {
    // instId now resolves to the vehicle's real installation when one exists, so this
    // links the ticket to the completed record (idempotent) instead of clobbering it;
    // COALESCE keeps an existing invoice_id when this run has none.
    await pgRun(
      `UPDATE installation_tickets SET vi_installation_id=?, invoice_id=COALESCE(?, invoice_id), updated_at=? WHERE ticket_no=?`,
      [instId, invoiceId || null, now, rtlTicket.ticket_no],
    ).catch((e: any) => console.error("[partnerQuoteFulfilment] RTL ticket link failed:", e?.message));

    // Mirror the ticket's status onto the vi_installation. When this fulfilment runs
    // on job COMPLETION, the PATCH /:id/status completion-mirror already ran — but the
    // vi_installation didn't exist yet (created just above), so it was skipped, leaving
    // the vi at 'Pending' while the ticket is 'Completed'. Reconcile it here (idempotent).
    if (instId) {
      const linkedTicket = await pgGet<any>(
        "SELECT status FROM installation_tickets WHERE ticket_no = ? AND deleted_at IS NULL",
        [rtlTicket.ticket_no],
      ).catch(() => null);
      if (linkedTicket?.status === "Completed") {
        await pgRun(
          `UPDATE vi_installations SET status='Completed', stage=7, completed_at=COALESCE(completed_at, ?), updated_at=? WHERE id=? AND status <> 'Completed'`,
          [now, now, instId],
        ).catch(() => {});
      }
    }
  }

  createNotification({
    targetRole: "Finance",
    type: "invoice",
    title: `Invoice auto-generated: ${invoiceNumber || pf.proforma_no}`,
    body: `Partner-priced quote ${quote.quote_no} approved → proforma ${pf.proforma_no} auto-approved and invoice ${invoiceNumber || "(pending)"} created for KES ${grossTotal.toLocaleString()}.`,
    link: invoiceId ? `invoice-detail.html?id=${invoiceId}` : "crm-proforma.html",
  }).catch(() => {});

  return { proformaId: pf.id, invoiceId, invoiceNumber };
}

/**
 * Job-card completion trigger for partner-priced quotes: when a retail installation
 * ticket is marked Completed, the linked partner-priced quotation is auto-APPROVED
 * (status → Accepted) and then fulfilled end-to-end (proforma → auto-approve →
 * invoice) with no manual step. Bank-financed / partner deals are billed at a fixed
 * partner rate, so completing the install is the signal to invoice.
 *
 * Resolves the quote via the retail lead (retail_leads.quote_id), falling back to the
 * ticket's own auto-quote (crm_quotes.installation_ticket_id). Silent no-op for
 * non-partner quotes or a quote already in a terminal state; safe to call repeatedly.
 */
export async function autoApprovePartnerQuoteForCompletedTicket(
  ticket: { id: string; retail_lead_id: string | null },
  actor: { id: string; email: string },
): Promise<{ quoteId: string; approved: boolean } | null> {
  let quoteId: string | null = null;
  if (ticket.retail_lead_id) {
    const rl = await pgGet<any>("SELECT quote_id FROM retail_leads WHERE id = ?", [ticket.retail_lead_id]).catch(() => null);
    quoteId = rl?.quote_id || null;
  }
  if (!quoteId) {
    const q = await pgGet<any>(
      "SELECT id FROM crm_quotes WHERE installation_ticket_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
      [ticket.id],
    ).catch(() => null);
    quoteId = q?.id || null;
  }
  if (!quoteId) return null;

  const quote = await pgGet<any>("SELECT * FROM crm_quotes WHERE id = ? AND deleted_at IS NULL", [quoteId]);
  if (!quote) return null;
  // Only partner-priced quotations auto-approve on job completion.
  if (!quote.partner_id && !quote.vat_inclusive) return null;
  // Don't mark an unpriced quote "Accepted" — nobody actually accepted anything,
  // and autoFulfilPartnerQuote below would no-op anyway. Leave it as Draft/Sent
  // so it still surfaces as needing pricing rather than looking falsely settled.
  if (quote.pricing_missing) return null;

  const now = new Date().toISOString();
  let approved = false;
  // 1. Auto-approve the quotation (unless already accepted or terminal).
  if (!["Accepted", "Rejected", "Superseded"].includes(quote.status)) {
    await pgRun(
      `UPDATE crm_quotes SET status='Accepted', approved_at=?, approved_by=?, updated_at=? WHERE id=?`,
      [now, `${actor.email} (auto — job card completed)`, now, quoteId],
    );
    approved = true;
  }

  // 2. Proforma → auto-approve → invoice (idempotent).
  await autoFulfilPartnerQuote(quoteId, actor);
  return { quoteId, approved };
}
