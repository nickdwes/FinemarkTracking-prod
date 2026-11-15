// Standard Kenyan VAT rate.
export const STANDARD_VAT_RATE = 16;

/**
 * Present a VAT-INCLUSIVE gross amount as a {subtotal(net), vatTotal, grandTotal(gross)}
 * breakdown for display on quotes/proformas. The gross is the price actually charged
 * (e.g. the bank/partner price, which already includes VAT); we back out the embedded
 * VAT so documents can itemise it without ever adding tax on top.
 *
 *   net = gross / (1 + rate/100)
 *   vat = gross - net           (defined as the remainder so net + vat === gross exactly)
 */
export function inclusiveBreakdown(gross: number, ratePct: number = STANDARD_VAT_RATE) {
  const g = Math.round((Number(gross) || 0) * 100) / 100;
  const net = Math.round((g / (1 + ratePct / 100)) * 100) / 100;
  const vatTotal = Math.round((g - net) * 100) / 100;
  return { subtotal: net, vatTotal, grandTotal: g, taxRate: ratePct };
}
