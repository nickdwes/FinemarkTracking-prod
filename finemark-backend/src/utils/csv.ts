import { Response } from "express";

const escapeCell = (value: unknown) => {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export const buildCsv = (headers: string[], rows: Array<Record<string, unknown>>) => {
  const headerLine = headers.join(",");
  const lines = rows.map((row) => headers.map((h) => escapeCell(row[h])).join(","));
  return [headerLine, ...lines].join("\n");
};

export const sendCsv = (res: Response, filename: string, csv: string) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
  res.status(200).send(csv);
};
