import * as XLSX from "xlsx";
import type { CsvRow } from "./csvParser.js";

export function parseXlsx(buffer: Buffer): { rows: CsvRow[]; headers: string[]; sheetName: string } {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, cellNF: false, cellText: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], headers: [], sheetName: "" };

  const sheet = workbook.Sheets[sheetName];
  const raw: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
  if (raw.length < 2) return { rows: [], headers: [], sheetName };

  const headers = (raw[0] as unknown[]).map((h) => String(h ?? "").trim());
  const rows: CsvRow[] = [];

  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i] as unknown[];
    const row: CsvRow = {};
    headers.forEach((header, j) => {
      const cell = cells[j];
      if (cell instanceof Date) {
        row[header] = cell.toISOString().slice(0, 10);
      } else {
        row[header] = String(cell ?? "").trim();
      }
    });
    if (Object.values(row).some((v) => v !== "")) rows.push(row);
  }

  return { rows, headers, sheetName };
}
