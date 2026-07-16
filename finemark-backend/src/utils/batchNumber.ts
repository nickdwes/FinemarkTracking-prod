import { pgGet } from "../db.js";

// Human-readable, date-encoded batch numbering — PREFIX-YYYYMMDD-NNN — for
// inventory batches (goods received, issued to technician, SIM cards). Unlike
// IdGenerator (deliberately opaque/non-guessable, for customer/lead/quote
// IDs), the whole point here is the opposite: staff should be able to read
// the date directly off the batch number without cross-referencing a
// separate date column. NNN is a per-day sequence so multiple batches on the
// same day still get distinct numbers, computed by counting existing batches
// whose number already starts with today's date across every table that
// batch type can land in (some concepts — e.g. "goods received" — are
// recorded across more than one table depending on the intake path).
export interface BatchCountSource {
  table: string;
  column: string;
  // Set when a batch spans multiple rows (e.g. one row per device/SIM in a
  // batch) — count distinct batch numbers, not rows, or every device in a
  // batch would each increment the sequence.
  distinct?: boolean;
}

export async function nextDatedBatchNumber(
  prefix: string,
  sources: BatchCountSource[],
  date: Date = new Date()
): Promise<string> {
  const datePart = date.toISOString().slice(0, 10).replace(/-/g, "");
  const likePattern = `${prefix}-${datePart}-%`;

  const counts = await Promise.all(
    sources.map(async (s) => {
      const expr = s.distinct ? `COUNT(DISTINCT ${s.column})` : `COUNT(*)`;
      const row = await pgGet<{ n: string }>(`SELECT ${expr} AS n FROM ${s.table} WHERE ${s.column} LIKE ?`, [likePattern]);
      return Number(row?.n || 0);
    })
  );

  const seq = counts.reduce((a, b) => a + b, 0) + 1;
  return `${prefix}-${datePart}-${String(seq).padStart(3, "0")}`;
}
