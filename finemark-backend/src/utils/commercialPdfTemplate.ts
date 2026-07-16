import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolveTemplatePath = (fileName = "PO.pdf") => {
  const candidates = [
    path.resolve(__dirname, "Templates", fileName),
    path.resolve(__dirname, "..", "utils", "Templates", fileName),
    path.resolve(__dirname, "..", "..", "assets", "templates", fileName),
    path.resolve(process.cwd(), "src", "utils", "Templates", fileName),
    path.resolve(process.cwd(), "dist", "utils", "Templates", fileName),
    path.resolve(process.cwd(), "assets", "templates", fileName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Template "${fileName}" not found. Checked: ${candidates.join(" | ")}`);
};

export type CommercialLineItem = {
  code?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  vatAmount: number;
  totalAmount: number;
};

export type RenderCommercialPdfInput = {
  documentTitle: "QUOTATION" | "INVOICE";
  documentNo: string;
  issueDate?: string | null;
  dueOrExpiryDate?: string | null;
  customerName: string;
  representative?: string | null;
  notes?: string | null;
  subtotal: number;
  vatTotal: number;
  grandTotal: number;
  lineItems: CommercialLineItem[];
  debug?: boolean;
  grid?: boolean;
  /** Override the PDF base template filename inside src/utils/Templates/ (default: "PO.pdf") */
  templateFile?: string;
};

const formatKes = (n: number) => `${Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d?: string | null) => (d ? String(d).slice(0, 10) : "");
const MM_TO_PT = 72 / 25.4;

export const renderCommercialPdf = async (input: RenderCommercialPdfInput) => {
  const templatePath = resolveTemplatePath(input.templateFile ?? "PO.pdf");
  const pdfDoc = await PDFDocument.load(fs.readFileSync(templatePath));

  const page = pdfDoc.getPages()[0];
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const BLACK = rgb(0.1, 0.11, 0.13);

  const toPtX = (mmX: number) => mmX * MM_TO_PT;
  const toPtY = (mmY: number) => height - (mmY * MM_TO_PT);

  const write = (text: string | number | null | undefined, x: number, y: number, size = 9.12, bold = false) => {
    if (text == null || text === "") return;
    page.drawText(String(text), { x, y, size, font: bold ? fontBold : font, color: BLACK });
  };
  const writeAtMm = (text: string | number | null | undefined, mmX: number, mmY: number, size = 9.12, bold = false) => {
    if (text == null || text === "") return;
    write(text, toPtX(mmX), toPtY(mmY), size, bold);
  };
  const writeRight = (text: string | number | null | undefined, rightX: number, y: number, size = 9.12, bold = false) => {
    if (text == null || text === "") return;
    const value = String(text);
    const f = bold ? fontBold : font;
    page.drawText(value, { x: rightX - f.widthOfTextAtSize(value, size), y, size, font: f, color: BLACK });
  };
  const writeRightAtMm = (text: string | number | null | undefined, mmRightX: number, mmY: number, size = 9.12, bold = false) => {
    writeRight(text, toPtX(mmRightX), toPtY(mmY), size, bold);
  };

  if (input.grid) {
    for (let x = 0; x <= width; x += 20) {
      page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, thickness: 0.2, color: rgb(0.9, 0.9, 0.9) });
    }
    for (let y = 0; y <= height; y += 20) {
      page.drawLine({ start: { x: 0, y }, end: { x: width, y }, thickness: 0.2, color: rgb(0.9, 0.9, 0.9) });
    }
  }

  // Header table value coordinates — rows are 7.55 mm apart in the template
  // Anchor: Sales Rep row confirmed at mmY=94; others derived from template label positions
  writeAtMm(fmtDate(input.issueDate), 175, 71.5);
  writeAtMm(input.documentNo, 175, 79);
  writeAtMm(fmtDate(input.dueOrExpiryDate), 175, 86.5);

  const customerName = (input.customerName || "").trim();
  const wrappedCustomer = customerName.length > 38
    ? customerName.match(/.{1,38}(\s|$)|\S+?(\s|$)/g)?.map((s) => s.trim()).filter(Boolean) || [customerName]
    : [customerName];
  wrappedCustomer.slice(0, 3).forEach((line, i) => writeAtMm(line, 20, 90 + i * 6));

  if (input.representative) {
    writeAtMm(`Attn: ${input.representative}`, 20, 96 + Math.min(wrappedCustomer.length - 1, 2) * 6);
    writeAtMm(input.representative, 175, 94);
  }

  const tableX = 25;
  const tableY = 130;
  const rowH = 12;
  const col = {
    item: 20,
    description: 60,
    quantity: 25,
    rate: 23,
    amount: 25,
    vat: 25,
  };

  input.lineItems.slice(0, 16).forEach((line, i) => {
    const y = tableY + i * rowH;
    writeAtMm(line.code || "", tableX, y, 8.5);
    writeAtMm(line.description || "", tableX + col.item, y, 8.5);
    writeAtMm(Number(line.quantity || 0).toFixed(2), tableX + col.item + col.description, y, 8.5);
    writeAtMm(formatKes(line.unitPrice || 0), tableX + col.item + col.description + col.quantity, y, 8.5);
    writeAtMm(formatKes(line.totalAmount || 0), tableX + col.item + col.description + col.quantity + col.rate, y, 8.5);
    writeAtMm(formatKes(line.vatAmount || 0), tableX + col.item + col.description + col.quantity + col.rate + col.amount, y, 8.5);
  });

  const totalsX = 132;
  const totalsY = tableY + 88;
  writeAtMm(`KES ${formatKes(input.subtotal || 0)}`, totalsX + 40, totalsY, 9.12);
  writeAtMm(`KES ${formatKes(input.vatTotal || 0)}`, totalsX + 40, totalsY + 11, 9.12);
  writeAtMm(`KES ${formatKes(input.grandTotal || 0)}`, totalsX + 40, totalsY + 23, 9.12, true);

  if (input.notes) writeAtMm(String(input.notes).slice(0, 120), 20, totalsY + 36, 8);

  if (input.debug) {
    writeAtMm(`Debug ${input.documentTitle}`, 10, 10, 8);
    writeRightAtMm(`${width.toFixed(2)}x${height.toFixed(2)} pt`, 205, 10, 8);
  }

  return pdfDoc.save();
};
