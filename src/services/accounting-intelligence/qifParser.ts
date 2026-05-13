import type { CsvRow } from "./csvParser.js";

export function parseQif(buffer: Buffer): { rows: CsvRow[]; headers: string[] } {
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);

  const headers = ["Date", "Libellé", "Montant", "Catégorie", "Mémo", "Référence"];
  const rows: CsvRow[] = [];
  let current: Partial<Record<string, string>> = {};

  for (const line of lines) {
    if (!line.trim() || line.startsWith("!")) continue;
    const code = line[0];
    const value = line.slice(1).trim();

    switch (code) {
      case "D": current["Date"] = parseQifDate(value); break;
      case "T": current["Montant"] = value.replace(",", "").replace(".", "").includes(",") ? value : value.replace(",", ""); break;
      case "U": if (!current["Montant"]) current["Montant"] = value; break;
      case "P": current["Libellé"] = value; break;
      case "M": current["Mémo"] = value; break;
      case "L": current["Catégorie"] = value; break;
      case "N": current["Référence"] = value; break;
      case "^":
        if (current["Date"] || current["Montant"]) {
          rows.push({
            Date: current["Date"] ?? "",
            Libellé: current["Libellé"] ?? current["Mémo"] ?? "",
            Montant: (current["Montant"] ?? "0").replace(/[^0-9.,-]/g, "").replace(",", "."),
            Catégorie: current["Catégorie"] ?? "",
            Mémo: current["Mémo"] ?? "",
            Référence: current["Référence"] ?? "",
          });
        }
        current = {};
        break;
    }
  }

  return { rows: rows.filter((r) => r["Date"] && r["Montant"]), headers };
}

function parseQifDate(raw: string): string {
  // QIF dates can be: MM/DD/YYYY, DD/MM/YYYY, D/M/YY, etc.
  // For French banks, typically DD/MM/YYYY
  const match = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (!match) return raw;
  const [, a, b, y] = match;
  const year = y.length === 2 ? `20${y}` : y;
  // Assume DD/MM/YYYY for French banks
  return `${year}-${b.padStart(2, "0")}-${a.padStart(2, "0")}`;
}
