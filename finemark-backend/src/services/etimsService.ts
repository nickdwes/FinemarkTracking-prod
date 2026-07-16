/**
 * KRA eTIMS Integration Service
 *
 * Interfaces with the live KRA eTIMS endpoint.
 *
 * .env keys:
 *   ETIMS_GATEWAY_URL     e.g. https://etims.kra.go.ke
 *   ETIMS_DEVICE_ID       from device registration
 *   ETIMS_API_KEY         from device registration
 *   ETIMS_TAXPAYER_PIN    Finemark KRA PIN (default P051961922E)
 */

const GATEWAY_URL  = process.env.ETIMS_GATEWAY_URL  || "";
const DEVICE_ID    = process.env.ETIMS_DEVICE_ID    || "";
const API_KEY      = process.env.ETIMS_API_KEY      || "";
const TAXPAYER_PIN = process.env.ETIMS_TAXPAYER_PIN || "P051961922E";

export interface EtimsItem {
  name: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;  // 16 or 0
}

export interface EtimsInvoicePayload {
  invoiceNumber: string;
  sellerPin: string;
  buyerPin?: string;
  date: string;
  totalAmount: number;
  vatAmount: number;
  items: EtimsItem[];
}

export interface EtimsResult {
  invoiceControlNumber: string;
  receiptNumber: string;
  timestamp: string;
  signatureMethod?: string;
}

/**
 * Submit a signed invoice to the eTIMS gateway.
 * Returns the fiscal identifiers { invoiceControlNumber, receiptNumber, timestamp }.
 */
export async function submitToEtims(payload: EtimsInvoicePayload): Promise<EtimsResult> {
  // Round monetary amounts to 2 dp to avoid floating-point serialisation mismatches
  const normalised: EtimsInvoicePayload = {
    ...payload,
    totalAmount: Math.round(payload.totalAmount * 100) / 100,
    vatAmount:   Math.round(payload.vatAmount   * 100) / 100,
  };

  const resp = await fetch(`${GATEWAY_URL}/api/v1/invoices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-device-id":  DEVICE_ID,
      "x-api-key":    API_KEY,
      "taxpayer-pin": normalised.sellerPin,
    },
    body: JSON.stringify(normalised),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");

    // 409 DUPLICATE_INVOICE means it was already submitted — fetch the existing record
    if (resp.status === 409 && body.includes("DUPLICATE_INVOICE")) {
      const invoiceSvcUrl = process.env.ETIMS_INVOICE_SVC_URL || "http://localhost:8005";
      const existing = await fetch(`${invoiceSvcUrl}/api/v1/invoices/${normalised.invoiceNumber}`).catch(() => null);
      if (existing && existing.ok) {
        const ex = (await existing.json()) as {
          control_number: string;
          receipt_number: string;
          created_at: string;
        };
        return {
          invoiceControlNumber: ex.control_number,
          receiptNumber:        ex.receipt_number,
          timestamp:            ex.created_at,
        };
      }
    }

    throw new Error(`eTIMS gateway error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as {
    status: string;
    invoiceControlNumber: string;
    receiptNumber: string;
    timestamp: string;
    signatureMethod?: string;
  };

  return {
    invoiceControlNumber: data.invoiceControlNumber,
    receiptNumber:        data.receiptNumber,
    timestamp:            data.timestamp,
    signatureMethod:      data.signatureMethod,
  };
}

/**
 * Build an EtimsInvoicePayload from a Finemark invoice + its items.
 */
export function buildEtimsPayload(invoice: {
  invoiceNumber: string;
  buyerPin?: string | null;
  total: number;
  vatTotal: number;
  items: Array<{ item: string; description?: string | null; qty: number; rate: number; vat: number }>;
}): EtimsInvoicePayload {
  const payload: EtimsInvoicePayload = {
    invoiceNumber: invoice.invoiceNumber,
    sellerPin:     TAXPAYER_PIN,
    date:          new Date().toISOString(),
    totalAmount:   Number(invoice.total),
    vatAmount:     Number(invoice.vatTotal),
    items: invoice.items.map(it => ({
      name:      [it.item, it.description].filter(Boolean).join(" — "),
      quantity:  Number(it.qty),
      unitPrice: Number(it.rate),
      vatRate:   Number(it.vat) > 0 ? 16 : 0,
    })),
  };
  // Only include buyerPin when present so it matches the serialised body
  if (invoice.buyerPin) payload.buyerPin = invoice.buyerPin;
  return payload;
}

export function isEtimsConfigured(): boolean {
  return Boolean(DEVICE_ID && API_KEY);
}
