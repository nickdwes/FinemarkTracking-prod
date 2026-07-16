import ExcelJS from "exceljs";
import type { VehicleSourceAdapter, NormalizedVehicleRow } from "./types.js";

// KRA publishes the Current Retail Selling Price list as a public Excel file,
// linked from this notices page. The exact .xlsx filename changes with every
// revision (e.g. "New-CRSP---July-2025.xlsx"), so we discover the current
// link by scraping the page rather than hardcoding a filename.
const CRSP_NOTICE_URL = "https://www.kra.go.ke/news-center/public-notices/2223-current-retail-selling-price-crsp-for-used-motor-vehicles";

// No credentials required — this is a public government publication.
export function isKraCrspConfigured(): boolean {
  return true;
}

async function findCrspDownloadUrl(): Promise<string> {
  const res = await fetch(CRSP_NOTICE_URL);
  if (!res.ok) throw new Error(`Failed to load KRA CRSP notice page (HTTP ${res.status}).`);
  const html = await res.text();
  const match = html.match(/href="([^"]*\.xlsx?)"/i);
  if (!match) throw new Error("Could not find a CRSP .xlsx download link on the KRA notice page.");

  const resolved = new URL(match[1], CRSP_NOTICE_URL);
  // KRA's own site sometimes links to the bare apex domain over plain HTTP
  // (e.g. "http://kra.go.ke/..."), which their server redirects to an HTTPS
  // URL that the apex domain's certificate doesn't cover (it's issued for
  // *.kra.go.ke, not kra.go.ke itself) — causing a TLS altname failure.
  // Force the known-good host+scheme and keep only the path.
  resolved.protocol = "https:";
  resolved.hostname = "www.kra.go.ke";
  return resolved.toString();
}

// Header cells span multiple lines in the source file (e.g. "Model \nnumber").
// Normalize whitespace/case so column lookup is robust to those line breaks.
const normalizeHeader = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

interface RawCrspRow {
  make: string;
  model: string;
  modelNumber: string;
  transmission: string;
  driveConfiguration: string;
  engineCapacity: string;
  bodyType: string;
  gvw: string;
  seating: string;
  fuel: string;
  crspValue: string;
}

export const kraCrspAdapter: VehicleSourceAdapter = {
  key: "kra_crsp",
  displayName: "KRA CRSP List",
  isConfigured: isKraCrspConfigured,

  async fetchBatch(): Promise<unknown[]> {
    const downloadUrl = await findCrspDownloadUrl();
    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`Failed to download CRSP file (HTTP ${res.status}).`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    // The main vehicle sheet's name includes the revision date (e.g.
    // "M.Vehicle CRSP July 2025") — match by prefix, falling back to the
    // first worksheet if KRA ever renames it.
    const sheet =
      workbook.worksheets.find((ws) => normalizeHeader(ws.name).startsWith("m.vehicle crsp")) ||
      workbook.worksheets[0];
    if (!sheet) throw new Error("CRSP workbook has no worksheets.");

    // Find the header row by scanning the first few rows for one containing
    // both "make" and "model" — KRA has moved this between row 1 and row 2
    // across past revisions.
    let headerRowNum = -1;
    let headerMap: Record<string, number> = {};
    for (let r = 1; r <= 5; r++) {
      const row = sheet.getRow(r);
      const map: Record<string, number> = {};
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        map[normalizeHeader(String(cell.value ?? ""))] = colNumber;
      });
      if (map["make"] && map["model"]) {
        headerRowNum = r;
        headerMap = map;
        break;
      }
    }
    if (headerRowNum === -1) throw new Error("Could not find a header row with Make/Model columns in the CRSP sheet.");

    const col = (name: string) => headerMap[name];
    const rows: RawCrspRow[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNum) return;
      const getVal = (colNum: number | undefined) => {
        if (!colNum) return "";
        const v = row.getCell(colNum).value;
        if (v == null) return "";
        if (typeof v === "object" && "result" in (v as any)) return String((v as any).result ?? "");
        return String(v).trim();
      };
      const make = getVal(col("make"));
      const model = getVal(col("model"));
      if (!make || !model) return;
      // Header lookups are pre-normalized (normalizeHeader collapses embedded
      // newlines like "Model \nnumber" down to single spaces) — match against
      // that normalized form, not the raw multi-line source text.
      rows.push({
        make,
        model,
        modelNumber: getVal(col("model number")),
        transmission: getVal(col("transmission")),
        driveConfiguration: getVal(col("drive configuration")),
        engineCapacity: getVal(col("engine capacity")),
        bodyType: getVal(col("body type")),
        gvw: getVal(col("gvw")),
        seating: getVal(col("seating")),
        fuel: getVal(col("fuel")),
        crspValue: getVal(col("crsp (kes.)") ?? col("crsp(kes.)")),
      });
    });

    return rows;
  },

  normalize(rawRows: unknown[]): NormalizedVehicleRow[] {
    const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    return (rawRows as RawCrspRow[]).map((r) => {
      const engineCcMatch = r.engineCapacity.match(/^\d+$/);
      const sourceRef = r.modelNumber || `kra-${slugify(`${r.make}-${r.model}`)}`;

      return {
        make: r.make,
        model: r.model,
        trim: null,
        modelYear: null,
        bodyStyle: r.bodyType || null,
        engineType: engineCcMatch ? null : (r.engineCapacity || null),
        engineSizeCc: engineCcMatch ? Number(r.engineCapacity) : null,
        fuelType: r.fuel || null,
        transmission: r.transmission || null,
        drivetrain: r.driveConfiguration || null,
        sourceRef,
        raw: { gvw: r.gvw || null, seating: r.seating || null, crspValueKes: r.crspValue || null },
      };
    });
  },
};
