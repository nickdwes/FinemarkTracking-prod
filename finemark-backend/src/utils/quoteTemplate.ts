/**
 * Standalone Quote / Proforma Invoice PDF renderer.
 * Generates a fully-drawn A4 PDF without relying on a template file.
 * Uses pdf-lib only — no external browser or HTML required.
 */
import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import type { BrandProfile } from "./docBrand.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type QuoteLineItem = {
  code?: string;
  name?: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  vatPct?: number;
  lineTotal: number;
  // invoice-mode extras
  vatAmount?: number;
  totalAmount?: number;
};

export type RenderQuotePdfInput = {
  documentTitle?: string;
  documentNoLabel?: string;
  /** 'quote' (default) = quote/proforma column layout; 'invoice' = invoice column layout */
  mode?: "quote" | "invoice";
  documentNo: string;
  issueDate?: string | null;
  /** Labelled 'Expiry Date' in quote mode, 'Due Date' in invoice mode */
  expiryDate?: string | null;
  /** Job card ticket number (shown in all modes) */
  jobCardNo?: string | null;
  /** Job card status — 'Completed', 'In Progress', 'Pending' etc. (shown as badge) */
  jobCardStatus?: string | null;
  /** Invoice payment status — 'Paid', 'Unpaid', 'PartiallyPaid', 'Overdue' (invoice mode only, shown as badge) */
  status?: string | null;
  /** Full name of the person who prepared the invoice (invoice mode only) */
  preparedBy?: string | null;
  /** Installation date (formatted string) */
  installationDate?: string | null;
  /** Installation time (formatted string) */
  installationTime?: string | null;
  /** Technician name */
  technicianName?: string | null;
  customerName: string;
  customerKraPin?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  customerAddress?: string | null;
  salesRep?: string | null;
  notes?: string | null;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  discountTotal?: number;
  taxRate?: number;
  vatInclusive?: boolean;
  /** Company letterhead + payment identity. Omit → Finemark defaults (unchanged). */
  brand?: BrandProfile | null;
  /** VAT presentation. 'auto' (default) preserves the passed numbers + vatInclusive labels.
   *  'inclusive_hidden' embeds VAT in the prices and shows only a single TOTAL (no VAT line/column). */
  vatDisplay?: "auto" | "inclusive" | "inclusive_hidden" | "exclusive" | "zero_rated" | "none";
  vehicle?: { registration?: string; make?: string; model?: string } | null;
  paymentOptions?: Array<{ label: string; value: string }>;
  lineItems: QuoteLineItem[];
};

// ── Constants ────────────────────────────────────────────────────────────────

const W = 595.28;   // A4 width (pt)
const H = 841.89;   // A4 height (pt)
const LM = 28;      // left margin
const RM = 28;      // right margin
const CW = W - LM - RM; // content width ≈ 539pt

// BLUE / LBLUE / LGREY are resolved per-brand inside renderQuotePdf (Finemark blue
// vs Unique Tracking orange) — see the "Brand theme" block there.
const WHITE  = rgb(1, 1, 1);
const MGREY  = rgb(0.72, 0.72, 0.72);   // border colour
const DARK   = rgb(0.08, 0.08, 0.08);   // near-black text
const GREY   = rgb(0.39, 0.44, 0.54);   // muted subtext

const COMPANY_NAME    = "Fine Mark Tracking Limited";
const COMPANY_ADDR    = "P.O. Box 12345-00100, Nairobi";
const COMPANY_PHONE   = "+254 700 000 000";
const COMPANY_EMAIL   = "info@finemark.co.ke";
const COMPANY_WEBSITE = "www.finemark.co.ke";
const COMPANY_PIN     = "P051961922E";

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (d?: string | null): string => {
  if (!d) return "—";
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split("-");
  return `${day}-${m}-${y}`;
};

// pdf-lib's WinAnsi encoding (used by the Standard fonts here) can only encode
// CP1252 characters. Free-text fields pasted from Word routinely carry glyphs it
// can't render, which throws "WinAnsi cannot encode …" and aborts PDF generation
// entirely (e.g. a raw newline "0x000a", or a Symbol/Wingdings bullet "0xf0b7"
// that Word emits for bullet lists). We normalise those so the document renders
// instead of failing:
//   1. control chars (incl. newlines) → a single space (one-line render, matching trunc()).
//   2. Private-Use-Area glyphs (Word's Symbol/Wingdings bullets) → a real "•".
//   3. any remaining non-WinAnsi character → dropped, so pdf-lib can never throw.
// The allow-list below is exactly the set of Unicode code points CP1252/WinAnsi maps.
const WINANSI_SAFE = /[^\x20-\x7E\xA0-\xFF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/g;
const sanitizeText = (s: string): string =>
  String(s)
    .replace(/[\x00-\x1F\x7F]+/g, " ")     // control chars (incl. newlines) → space
    .replace(/[\uE000-\uF8FF]/g, "\u2022")     // Symbol/Wingdings PUA bullets -> bullet
    .replace(WINANSI_SAFE, "")             // strip anything WinAnsi still can't encode
    .trim();

function text(
  page: PDFPage, txt: string | number | null | undefined,
  x: number, y: number,
  font: PDFFont, size: number, color = DARK,
): void {
  if (txt == null || txt === "") return;
  const s = sanitizeText(String(txt));
  if (!s) return;
  page.drawText(s, { x, y, size, font, color });
}

function textRight(
  page: PDFPage, txt: string | number | null | undefined,
  rightX: number, y: number,
  font: PDFFont, size: number, color = DARK,
): void {
  if (txt == null || txt === "") return;
  const s = sanitizeText(String(txt));
  if (!s) return;
  const w = font.widthOfTextAtSize(s, size);
  page.drawText(s, { x: rightX - w, y, size, font, color });
}

function textCenter(
  page: PDFPage, txt: string | number | null | undefined,
  boxX: number, boxW: number, y: number,
  font: PDFFont, size: number, color = DARK,
): void {
  if (txt == null || txt === "") return;
  const s = sanitizeText(String(txt));
  if (!s) return;
  const w = font.widthOfTextAtSize(s, size);
  page.drawText(s, { x: boxX + (boxW - w) / 2, y, size, font, color });
}

function fillRect(page: PDFPage, x: number, y: number, w: number, h: number, color: ReturnType<typeof rgb>): void {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

function borderRect(page: PDFPage, x: number, y: number, w: number, h: number, lw = 0.6, bc = MGREY): void {
  page.drawRectangle({ x, y, width: w, height: h, borderWidth: lw, borderColor: bc });
}

function hLine(page: PDFPage, x1: number, x2: number, y: number, lw = 0.4): void {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: lw, color: MGREY });
}

function vLine(page: PDFPage, x: number, y1: number, y2: number, lw = 0.4): void {
  page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: lw, color: MGREY });
}

// Truncate string so it fits in the given column width
function trunc(s: string, font: PDFFont, size: number, maxW: number): string {
  s = sanitizeText(s);
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  let out = s;
  while (out.length > 1 && font.widthOfTextAtSize(out + "…", size) > maxW) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

// ── Main renderer ─────────────────────────────────────────────────────────────

export async function renderQuotePdf(input: RenderQuotePdfInput): Promise<Uint8Array> {
  const mode = input.mode || "quote";

  // ── Brand (letterhead + payment) ──
  // When NO brand is supplied (legacy callers) fall back to the historical Finemark
  // constants. When a brand IS supplied, use its fields as-is — empty optional fields
  // stay empty (omitted below) rather than borrowing Finemark's values.
  const hasBrand = !!input.brand;
  const brand = {
    key: input.brand?.key || "finemark",
    companyName: input.brand?.companyName || COMPANY_NAME,
    tagline: hasBrand ? (input.brand?.tagline ?? null) : "Security in Every Mile",
    address: hasBrand ? (input.brand?.address ?? null) : COMPANY_ADDR,
    phone: hasBrand ? (input.brand?.phone ?? null) : COMPANY_PHONE,
    email: hasBrand ? (input.brand?.email ?? null) : COMPANY_EMAIL,
    website: hasBrand ? (input.brand?.website ?? null) : COMPANY_WEBSITE,
    pin: hasBrand ? (input.brand?.pin ?? null) : COMPANY_PIN,
    logoFilename: input.brand?.logoFilename || "finemark-logo.png",
    till: input.brand?.till || null,
    paybill: input.brand?.paybill || null,
    bankName: input.brand?.bankName || null,
    bankBranch: input.brand?.bankBranch || null,
    bankAccountNo: input.brand?.bankAccountNo || null,
    payee: input.brand?.payee || null,
  };

  // ── Brand theme ──
  // Finemark documents keep the historical blue; Unique Tracking documents use the
  // orange palette of the Unique Tracking certificate paper (assets/templates/Unique
  // paper.pdf). These shadow the module-level BLUE/LBLUE/LGREY for the rest of this
  // renderer, so every header bar / table head / total / footer re-themes at once.
  // Presentation only — no totals are touched.
  const isUnique = brand.key === "unique";
  const BLUE  = isUnique ? rgb(0.871, 0.471, 0.035) : rgb(0.184, 0.235, 0.576); // #de7809 vs #2f3c93
  // LBLUE is only the footer strap text; use a light peach on unique so it stays legible on the orange footer.
  const LBLUE = isUnique ? rgb(1.000, 0.871, 0.749) : rgb(0.184, 0.663, 0.875); // #FFDEBF vs #2fa9df
  const LGREY = isUnique ? rgb(1.000, 0.953, 0.917) : rgb(0.945, 0.957, 0.984); // #FFF3EA vs #f1f4fb

  // ── VAT presentation — display-only; 'auto' preserves the passed numbers exactly ──
  const vd = input.vatDisplay || "auto";
  let dispSub = input.subtotal, dispVat = input.vatTotal, dispGrand = input.grandTotal;
  let dispInclusiveLabel = !!input.vatInclusive;
  let zeroRated = false;
  // hideVat: VAT is embedded in the prices and NOT itemised anywhere (no VAT column,
  // no Amount-excl/VAT summary rows) — the customer sees inclusive prices + one TOTAL.
  let hideVat = false;
  // noVat: NO VAT treatment at all — the amounts are shown exactly as stored (no VAT
  // backed out, none added, no VAT line/column) and the total is labelled plainly
  // "TOTAL" (not "TOTAL (VAT INCL.)"). Distinct from inclusive_hidden, which still
  // embeds/labels VAT, and from zero_rated, which prints a "VAT (0%)" line.
  let noVat = false;
  if (vd === "inclusive" || vd === "inclusive_hidden") {
    const gross = input.grandTotal;
    dispSub = Math.round((gross / 1.16) * 100) / 100;
    dispVat = Math.round((gross - dispSub) * 100) / 100;
    dispGrand = gross;
    dispInclusiveLabel = true;
    if (vd === "inclusive_hidden") hideVat = true;
  } else if (vd === "exclusive") {
    dispInclusiveLabel = false;
  } else if (vd === "zero_rated") {
    dispSub = input.grandTotal;
    dispVat = 0;
    dispGrand = input.grandTotal;
    dispInclusiveLabel = false;
    zeroRated = true;
  } else if (vd === "none") {
    dispSub = input.grandTotal;
    dispVat = 0;
    dispGrand = input.grandTotal;
    dispInclusiveLabel = false;
    hideVat = true;   // no VAT column / breakdown rows
    noVat = true;     // amounts shown as-is; plain "TOTAL" label
  }

  const pdfDoc = await PDFDocument.create();
  const page   = pdfDoc.addPage([W, H]);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // cursor tracks the current TOP Y (from bottom), moving downwards
  let cursor = H - 12;

  // ── SECTION 1: Header ─────────────────────────────────────────────────────

  // Thin blue brand bar at very top
  fillRect(page, 0, H - 5, W, 5, BLUE);

  // Row 1: Logo + Company name (left) + Address (right)
  const hRow1H = 44;
  const row1Top = cursor - 8; // a little below the bar
  const row1Y   = row1Top - hRow1H;

  // Embed logo — preserve aspect ratio (some brand logos are wide wordmarks that
  // already contain the company name; those suppress the separate name text).
  const logoH = 38;
  let drawnLogoW = logoH;   // fallback spacing if the logo fails to load
  let logoIsWordmark = false;
  try {
    const logoPath = path.join(process.cwd(), "assets", brand.logoFilename);
    const logoPngBytes = fs.readFileSync(logoPath);
    const logoImg = await pdfDoc.embedPng(logoPngBytes);
    const nat = logoImg.scale(1);
    const aspect = nat.width / nat.height;
    logoIsWordmark = aspect > 1.6;              // wide logo = wordmark (name baked in)
    const maxW = logoIsWordmark ? 150 : logoH;
    const s = Math.min(logoH / nat.height, maxW / nat.width);
    const dw = nat.width * s, dh = nat.height * s;
    page.drawImage(logoImg, { x: LM, y: row1Top - dh, width: dw, height: dh });
    drawnLogoW = dw;
  } catch (_e) { /* logo file missing — skip silently */ }
  const textX = LM + drawnLogoW + 6;

  if (!logoIsWordmark) {
    text(page, brand.companyName, textX, row1Top - 16, bold, 13, BLUE);
    if (brand.tagline) text(page, brand.tagline, textX, row1Top - 28, font, 7, GREY);
  }

  const rx = W - RM;
  if (brand.address) textRight(page, brand.address,        rx, row1Top - 10, font, 6.5, DARK);
  if (brand.phone)   textRight(page, `M: ${brand.phone}`,   rx, row1Top - 19, font, 6.5, DARK);
  if (brand.email)   textRight(page, `E: ${brand.email}`,   rx, row1Top - 28, font, 6.5, DARK);
  if (brand.website) textRight(page, `W: ${brand.website}`, rx, row1Top - 37, font, 6.5, DARK);
  if (brand.pin)     textRight(page, `PIN: ${brand.pin}`,   rx, row1Top - 47, font, 6.5, BLUE);

  cursor = row1Y - 6;

  // Row 2: Document title centered
  const hRow2H = 18;
  const row2Y  = cursor - hRow2H;
  textCenter(page, input.documentTitle || "QUOTATION", LM, CW, row2Y + 4, bold, 12, BLUE);

  cursor = row2Y - 4;

  // Divider line
  page.drawLine({ start: { x: LM, y: cursor }, end: { x: W - RM, y: cursor }, thickness: 1.5, color: BLUE });

  cursor -= 10;

  // ── SECTION 2: Customer Info (left) + Quote Details (right) ───────────────
  const custW   = Math.floor(CW * 0.54);
  const quoteW  = CW - custW - 6;
  const custX   = LM;
  const quoteX  = LM + custW + 6;

  // Build shared rows used across all document types
  const sharedRows: [string, string, string?][] = [
    ["Sales Representative:",  input.salesRep        || "—"],
    ["Technician:",            input.technicianName  || "—"],
    ["Job Card No:",           input.jobCardNo       || "—"],
    ["Job Card Status:",       input.jobCardStatus   || "—", input.jobCardStatus   || ""],
    ["Installation Date:",     input.installationDate ? `${input.installationDate}${input.installationTime ? " " + input.installationTime : ""}` : "—"],
  ];

  // Quote details rows — all modes share the common block; invoice mode appends payment status + prepared by
  const detailRows: [string, string, string?][] = mode === "invoice"
    ? [
        [input.documentNoLabel || "Invoice No:", input.documentNo || "—"],
        ["Invoice Date:",  fmtDate(input.issueDate)],
        ["Due Date:",  fmtDate(input.expiryDate)],
        ...sharedRows,
        ["Invoice Payment Status:", input.status || "—", input.status || ""],
      ]
    : [
        [input.documentNoLabel || "Quotation No:", input.documentNo || "—"],
        ["Date:",         fmtDate(input.issueDate)],
        ["Expiry Date:",  fmtDate(input.expiryDate)],
        ...sharedRows,
      ];

  const dRowH   = 18;
  const infoH   = dRowH * detailRows.length;   // dynamic height based on row count
  const infoY   = cursor - infoH;
  const dLabelW = Math.floor(quoteW * 0.45);

  // Customer box (height matches detail table)
  fillRect(page, custX, infoY, custW, infoH, WHITE);
  fillRect(page, custX, infoY + infoH - 16, custW, 16, LGREY);
  text(page, "BILL TO", custX + 5, infoY + infoH - 11, bold, 7.5, DARK);
  hLine(page, custX, custX + custW, infoY + infoH - 16);
  // Customer name
  const custNameStr = trunc(input.customerName || "—", bold, 10, custW - 10);
  text(page, custNameStr, custX + 5, infoY + infoH - 29, bold, 10, DARK);
  // Address / P.O. Box
  let custLineY = infoY + infoH - 43;
  const custLineStep = 12;
  if (input.customerAddress) {
    text(page, trunc(input.customerAddress, font, 8, custW - 10), custX + 5, custLineY, font, 8, DARK);
    custLineY -= custLineStep;
  }
  // Phone
  if (input.customerPhone) {
    text(page, `Tel: ${input.customerPhone}`, custX + 5, custLineY, font, 8, DARK);
    custLineY -= custLineStep;
  }
  // Email
  if (input.customerEmail) {
    text(page, trunc(`Email: ${input.customerEmail}`, font, 8, custW - 10), custX + 5, custLineY, font, 8, DARK);
    custLineY -= custLineStep;
  }
  // KRA PIN
  if (input.customerKraPin) {
    text(page, `PIN: ${input.customerKraPin}`, custX + 5, custLineY, font, 8, DARK);
  }
  borderRect(page, custX, infoY, custW, infoH);

  // Helper: status badge colour
  const statusColor = (s: string) => {
    const sl = s.toLowerCase();
    if (sl === "paid")          return rgb(0.06, 0.55, 0.18);   // green
    if (sl === "partiallypaid") return rgb(0.85, 0.45, 0.0);    // amber
    if (sl === "overdue")       return rgb(0.72, 0.05, 0.05);   // dark red
    if (sl === "completed")     return rgb(0.06, 0.55, 0.18);   // green
    if (sl === "in progress" || sl === "inprogress") return rgb(0.08, 0.35, 0.78); // blue
    if (sl === "pending")       return rgb(0.85, 0.45, 0.0);    // amber
    if (sl === "accepted")      return rgb(0.06, 0.55, 0.18);   // green
    if (sl === "approved")      return rgb(0.06, 0.55, 0.18);   // green
    return rgb(0.75, 0.10, 0.10);                                // red (Unpaid/unknown)
  };

  // Detail table rows
  detailRows.forEach(([label, value, rawStatus], i) => {
    const rowY = cursor - (i + 1) * dRowH;
    const bg = i % 2 === 0 ? WHITE : LGREY;
    fillRect(page, quoteX, rowY, quoteW, dRowH, bg);
    text(page, label, quoteX + 4, rowY + dRowH - 11, bold, 7, DARK);

    if (rawStatus !== undefined && rawStatus !== "") {
      // Render status as a small coloured pill/badge
      const statusTxt  = String(value);
      const sColor     = statusColor(rawStatus);
      const badgeW     = Math.min(font.widthOfTextAtSize(statusTxt, 7.5) + 10, quoteW - dLabelW - 8);
      const badgeX     = quoteX + dLabelW + 4;
      const badgeY     = rowY + 3;
      const badgeH     = dRowH - 6;
      fillRect(page, badgeX, badgeY, badgeW, badgeH, sColor);
      // white text centred in badge
      const tw = font.widthOfTextAtSize(statusTxt, 7);
      page.drawText(statusTxt, { x: badgeX + (badgeW - tw) / 2, y: badgeY + 3, size: 7, font: bold, color: WHITE });
    } else {
      text(page, trunc(value, font, 7.5, quoteW - dLabelW - 8), quoteX + dLabelW + 4, rowY + dRowH - 11, font, 7.5, DARK);
    }

    hLine(page, quoteX, quoteX + quoteW, rowY);
    vLine(page, quoteX + dLabelW, rowY, rowY + dRowH);
  });
  borderRect(page, quoteX, infoY, quoteW, infoH);

  cursor = infoY - 8;

  // ── SECTION 3: Vehicle Table ───────────────────────────────────────────────
  if (input.vehicle && (input.vehicle.registration || input.vehicle.make || input.vehicle.model)) {
    const vHdrH  = 16;
    const vDataH = 20;
    const vTotalH = vHdrH + vDataH;
    const vY = cursor - vTotalH;

    const vc1 = Math.floor(CW * 0.22);
    const vc2 = Math.floor(CW * 0.35);
    const vc3 = CW - vc1 - vc2;

    // Header
    fillRect(page, LM, vY + vDataH, CW, vHdrH, BLUE);
    text(page, "Vehicle Reg.", LM + 4, vY + vDataH + 5, bold, 7.5, WHITE);
    text(page, "Make",         LM + vc1 + 4, vY + vDataH + 5, bold, 7.5, WHITE);
    text(page, "Make & Model", LM + vc1 + vc2 + 4, vY + vDataH + 5, bold, 7.5, WHITE);

    // Data row
    fillRect(page, LM, vY, CW, vDataH, WHITE);
    text(page, input.vehicle.registration || "—", LM + 4, vY + 6, bold, 9, DARK);
    text(page, input.vehicle.make || "—",         LM + vc1 + 4, vY + 6, font, 8.5, DARK);
    const makeModel = [input.vehicle.make, input.vehicle.model].filter(Boolean).join(" | ");
    text(page, trunc(makeModel || "—", font, 8.5, vc3 - 8), LM + vc1 + vc2 + 4, vY + 6, font, 8.5, DARK);

    // Borders
    borderRect(page, LM, vY, CW, vTotalH);
    hLine(page, LM, LM + CW, vY + vDataH, 0.5);
    vLine(page, LM + vc1, vY, vY + vTotalH);
    vLine(page, LM + vc1 + vc2, vY, vY + vTotalH);

    cursor = vY - 8;
  }

  // ── SECTION 4: Items Table ─────────────────────────────────────────────────
  const iHdrH = 16;
  const iRowH = 18;

  if (mode === "invoice") {
    // Invoice columns: ITEM | DESCRIPTION | QTY | RATE | AMOUNT | VAT.
    // When VAT is hidden (inclusive_hidden), the VAT column is dropped and its
    // width folds into DESCRIPTION; RATE/AMOUNT then show VAT-inclusive figures.
    const cItem  = 90;
    const cQty2  = 38;
    const cRate  = 75;
    const cAmt   = 80;
    const cVat   = hideVat ? 0 : 116;
    const cDesc2 = CW - cItem - cQty2 - cRate - cAmt - cVat;

    const xItem  = LM;
    const xDesc2 = xItem  + cItem;
    const xQty2  = xDesc2 + cDesc2;
    const xRate  = xQty2  + cQty2;
    const xAmt   = xRate  + cRate;
    const xVat   = xAmt   + cAmt;
    const invVLines = hideVat ? [xDesc2, xQty2, xRate, xAmt] : [xDesc2, xQty2, xRate, xAmt, xVat];

    const iHdrY = cursor - iHdrH;
    fillRect(page, LM, iHdrY, CW, iHdrH, BLUE);
    const hY = iHdrY + 5;
    text(page, "ITEM",        xItem  + 3, hY, bold, 6.5, WHITE);
    text(page, "DESCRIPTION", xDesc2 + 3, hY, bold, 6.5, WHITE);
    textCenter(page, "QTY",   xQty2, cQty2, hY, bold, 6.5, WHITE);
    textRight(page, "RATE",   xRate + cRate - 3, hY, bold, 6.5, WHITE);
    textRight(page, "AMOUNT", xAmt  + cAmt  - 3, hY, bold, 6.5, WHITE);
    if (!hideVat) textRight(page, "VAT", xVat + cVat - 3, hY, bold, 6.5, WHITE);
    invVLines.forEach(x => vLine(page, x, iHdrY, iHdrY + iHdrH, 0.3));

    cursor = iHdrY;
    const visibleItems = input.lineItems.slice(0, 18);
    visibleItems.forEach((item, i) => {
      const rowY = cursor - (i + 1) * iRowH;
      fillRect(page, LM, rowY, CW, iRowH, i % 2 === 0 ? WHITE : LGREY);
      const rY = rowY + 5;
      const exAmt   = Number(item.totalAmount ?? item.lineTotal ?? 0);
      const lineVat = zeroRated ? 0 : Number(item.vatAmount ?? 0);
      const qtyN    = Number(item.quantity || 1) || 1;
      // noVat: amounts exactly as stored (no VAT added). hideVat (inclusive_hidden):
      // embed VAT into the shown amount. Otherwise: excl-VAT amount + separate VAT column.
      const showAmt  = noVat ? exAmt : (hideVat ? exAmt + lineVat : exAmt);
      const showRate = noVat ? item.unitPrice : (hideVat ? (qtyN ? showAmt / qtyN : showAmt) : item.unitPrice);
      text(page, trunc(item.code || "—", font, 7.5, cItem - 6), xItem + 3, rY, font, 7.5);
      text(page, trunc(item.description || "—", font, 7.5, cDesc2 - 6), xDesc2 + 3, rY, font, 7.5);
      textCenter(page, String(item.quantity || 1), xQty2, cQty2, rY, font, 7.5);
      textRight(page, fmt(showRate), xRate + cRate - 3, rY, font, 7.5);
      textRight(page, fmt(showAmt), xAmt + cAmt - 3, rY, font, 7.5);
      if (!hideVat) textRight(page, fmt(lineVat), xVat + cVat - 3, rY, font, 7.5);
      hLine(page, LM, LM + CW, rowY, 0.3);
      invVLines.forEach(x => vLine(page, x, rowY, rowY + iRowH, 0.3));
    });

    const itemsBottomY2 = cursor - visibleItems.length * iRowH;
    borderRect(page, LM, itemsBottomY2, CW, iHdrH + visibleItems.length * iRowH, 0.75);
    cursor = itemsBottomY2 - 10;
  } else {
    // Quote/proforma columns: ITEM | TYPE | DESCRIPTION | QTY | DISCOUNT | UNIT PRICE
    const cCode  = 65;
    const cName  = 105;
    const cDesc  = 115;
    const cQty   = 38;
    const cDisc  = 65;
    const cPrice = CW - cCode - cName - cDesc - cQty - cDisc; // ~91pt

    const xCode  = LM;
    const xName  = xCode + cCode;
    const xDesc  = xName + cName;
    const xQty   = xDesc + cDesc;
    const xDisc  = xQty  + cQty;
    const xPrice = xDisc + cDisc;

    const iHdrY = cursor - iHdrH;
    fillRect(page, LM, iHdrY, CW, iHdrH, BLUE);
    const hY = iHdrY + 5;
    text(page, "ITEM",        xCode + 3,  hY, bold, 6.5, WHITE);
    text(page, "TYPE",        xName + 3,  hY, bold, 6.5, WHITE);
    text(page, "DESCRIPTION", xDesc + 3,  hY, bold, 6.5, WHITE);
    textCenter(page, "QTY",   xQty,  cQty,  hY, bold, 6.5, WHITE);
    text(page, "DISCOUNT",    xDisc + 3,  hY, bold, 6.5, WHITE);
    textRight(page, "UNIT PRICE", xPrice + cPrice - 3, hY, bold, 6.5, WHITE);
    [xName, xDesc, xQty, xDisc, xPrice].forEach(x => vLine(page, x, iHdrY, iHdrY + iHdrH, 0.3));

    cursor = iHdrY;
    const visibleItems = input.lineItems.slice(0, 18);
    visibleItems.forEach((item, i) => {
      const rowY = cursor - (i + 1) * iRowH;
      fillRect(page, LM, rowY, CW, iRowH, i % 2 === 0 ? WHITE : LGREY);
      const rY = rowY + 5;
      text(page, trunc(item.code || "—", font, 7.5, cCode - 6),  xCode + 3, rY, font, 7.5);
      text(page, trunc(item.name || item.code || "—", font, 7.5, cName - 6), xName + 3, rY, font, 7.5);
      text(page, trunc(item.description || "—", font, 7.5, cDesc - 6), xDesc + 3, rY, font, 7.5);
      textCenter(page, String(item.quantity || 1), xQty, cQty, rY, font, 7.5);
      const disc = item.discountPct != null ? `${Number(item.discountPct).toFixed(2)}%` : "0.00%";
      text(page, disc, xDisc + 3, rY, font, 7.5);
      textRight(page, fmt(item.lineTotal), xPrice + cPrice - 3, rY, font, 7.5);
      hLine(page, LM, LM + CW, rowY, 0.3);
      [xName, xDesc, xQty, xDisc, xPrice].forEach(x => vLine(page, x, rowY, rowY + iRowH, 0.3));
    });

    const itemsBottomY = cursor - visibleItems.length * iRowH;
    borderRect(page, LM, itemsBottomY, CW, iHdrH + visibleItems.length * iRowH, 0.75);
    cursor = itemsBottomY - 10;
  }



  // ── SECTION 5: Summary ────────────────────────────────────────────────────
  const sumLabelRX = W - RM - 120;   // right-edge of label
  const sumValueRX = W - RM;          // right-edge of value
  const sRowH = 16;

  // "SUMMARY" chip
  fillRect(page, LM, cursor - sRowH, 90, sRowH, BLUE);
  text(page, "SUMMARY", LM + 5, cursor - sRowH + 5, bold, 8, WHITE);
  cursor -= sRowH;

  type SumRow = { label: string; value: string; isBold: boolean };
  const vatLabel = zeroRated
    ? "VAT (0%) :"
    : (dispInclusiveLabel ? `VAT (${input.taxRate ?? 16}% INCL.) :` : "VAT :");
  // hideVat: single inclusive TOTAL, no Amount-excl / VAT breakdown.
  const sumRows: SumRow[] = hideVat
    ? [
        ...(input.discountTotal && input.discountTotal > 0
          ? [{ label: "DISCOUNT :", value: `-KES ${fmt(input.discountTotal)}`, isBold: false }]
          : []),
        { label: noVat ? "TOTAL :" : "TOTAL (VAT INCL.) :", value: `KES ${fmt(dispGrand)}`, isBold: true },
      ]
    : [
        { label: dispInclusiveLabel ? "AMOUNT (EXCL. VAT) :" : "SUB TOTAL :", value: `KES ${fmt(dispSub)}`, isBold: false },
        ...(input.discountTotal && input.discountTotal > 0
          ? [{ label: "DISCOUNT :", value: `-KES ${fmt(input.discountTotal)}`, isBold: false }]
          : []),
        { label: vatLabel, value: `KES ${fmt(dispVat)}`, isBold: false },
        { label: "GRAND TOTAL :", value: `KES ${fmt(dispGrand)}`, isBold: true },
      ];

  sumRows.forEach((row, i) => {
    const rowY = cursor - (i + 1) * sRowH;
    if (row.isBold) {
      // top + bottom rule for grand total
      hLine(page, sumLabelRX - 8, sumValueRX, rowY + sRowH, 0.6);
      hLine(page, sumLabelRX - 8, sumValueRX, rowY, 0.6);
      fillRect(page, sumLabelRX - 8, rowY, sumValueRX - (sumLabelRX - 8), sRowH, LGREY);
    }
    const f = row.isBold ? bold : font;
    const c = row.isBold ? BLUE : DARK;
    textRight(page, row.label, sumLabelRX, rowY + 5, f, 8.5, DARK);
    textRight(page, row.value, sumValueRX, rowY + 5, f, 8.5, c);
  });

  cursor = cursor - sumRows.length * sRowH - 14;

  // ── SECTION 6: Notes ─────────────────────────────────────────────────────
  if (input.notes) {
    text(page, "Remarks:", LM, cursor, bold, 8, DARK);
    cursor -= 13;
    // wrap notes at ~95 chars / ~480pt
    const noteTxt = sanitizeText(String(input.notes)).slice(0, 300);
    const noteLines: string[] = [];
    let remain = noteTxt;
    while (remain.length > 0 && noteLines.length < 4) {
      let cut = remain.length;
      while (cut > 1 && font.widthOfTextAtSize(remain.slice(0, cut), 8) > CW - 8) cut--;
      noteLines.push(remain.slice(0, cut));
      remain = remain.slice(cut).trimStart();
    }
    noteLines.forEach(line => {
      text(page, line, LM, cursor, font, 8, DARK);
      cursor -= 11;
    });
    cursor -= 4;
  }

  // ── SECTION 7: Payment Details ────────────────────────────────────────────
  // Unique-Tracking-branded documents collect into Unique Tracking's own accounts
  // (from the brand profile), not the partner bank's; otherwise use the caller's
  // partner-aware payment rows (buildPaymentDetails / bank_accounts).
  let payOpts = input.paymentOptions || [];
  if (brand.key === "unique") {
    const uniqueRows: Array<{ label: string; value: string }> = [];
    if (brand.till) uniqueRows.push({ label: "MPESA TILL", value: `Till: ${brand.till}` });
    if (brand.paybill) uniqueRows.push({ label: "MPESA PAYBILL", value: `Paybill: ${brand.paybill}` });
    if (brand.bankName && brand.bankAccountNo) {
      uniqueRows.push({ label: brand.bankName.toUpperCase(), value: `${brand.bankBranch ? brand.bankBranch + " — " : ""}A/C ${brand.bankAccountNo}` });
    }
    if (brand.payee) uniqueRows.push({ label: "PAYEE", value: brand.payee });
    if (uniqueRows.length) payOpts = uniqueRows;
  }
  if (payOpts.length > 0) {
    const pTW   = 260;
    const pTX   = W - RM - pTW;
    const pHdrH = 16;
    const pRowH = 16;
    const pLabelW = 110;
    const tableTopY = cursor;

    // Header — blue to match HTML preview
    fillRect(page, pTX, tableTopY - pHdrH, pTW, pHdrH, BLUE);
    text(page, "MODE OF PAYMENTS", pTX + 5, tableTopY - pHdrH + 5, bold, 8, WHITE);

    // Rows
    payOpts.forEach((opt, i) => {
      const rowY = tableTopY - pHdrH - (i + 1) * pRowH;
      if (i % 2 !== 0) fillRect(page, pTX, rowY, pTW, pRowH, LGREY);
      // label cell (blue bg like HTML th)
      fillRect(page, pTX, rowY, pLabelW, pRowH, rgb(0.945, 0.957, 0.984));
      text(page, trunc(opt.label, bold, 7, pLabelW - 6), pTX + 4, rowY + 5, bold, 7, BLUE);
      text(page, opt.value, pTX + pLabelW + 4, rowY + 5, font, 7, DARK);
      hLine(page, pTX, pTX + pTW, rowY, 0.3);
      vLine(page, pTX + pLabelW, rowY, rowY + pRowH, 0.4);
    });

    // Outer border
    const totalPayH = pHdrH + payOpts.length * pRowH;
    borderRect(page, pTX, tableTopY - totalPayH, pTW, totalPayH, 0.75);

    cursor = Math.min(cursor, tableTopY - totalPayH) - 8;
  }

  // ── SECTION 8: Footer ─────────────────────────────────────────────────────
  const footerH = 24;
  fillRect(page, 0, 0, W, footerH, BLUE);
  textCenter(page, "GPS Tracking  •  Fleet Management  •  Vehicle Monitoring  •  Fuel Management", 0, W, 9, font, 7, WHITE);
  text(page, [brand.companyName, brand.website, brand.email].filter(Boolean).join("  |  "), LM, 2, font, 5.5, LBLUE);

  return pdfDoc.save();
}
