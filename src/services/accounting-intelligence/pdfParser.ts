import pdfParse from "pdf-parse";
import type { CsvRow } from "./csvParser.js";

// DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY at start of line
const DATE_RE = /^(\d{2}[\/\-\.]\d{2}[\/\-\.](?:\d{4}|\d{2}))/;

// Single amount at end of line — French format: 1 250,00 / -45,90 / 1 250.00
const AMOUNT_END_RE = /([+-]?\s*[\d ]+[,\.]\d{2})\s*$/;

// Two-column layout: credit (left)   debit (right), separated by 2+ spaces
const DEBIT_CREDIT_RE = /(\d[\d ,\.]+\d)\s{2,}(\d[\d ,\.]+\d)\s*$/;

function normalizeAmount(raw: string): string {
  return raw.replace(/\s/g, "").replace(",", ".");
}

export async function parsePdf(buffer: Buffer): Promise<{ rows: CsvRow[]; headers: string[] }> {
  const data = await pdfParse(buffer);

  const lines: string[] = data.text
    .split(/\n/)
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 4);

  const rows: CsvRow[] = [];

  for (const line of lines) {
    const dateMatch = line.match(DATE_RE);
    if (!dateMatch) continue;

    const date = dateMatch[1];
    const rest = line.slice(dateMatch[0].length).trim();
    if (!rest) continue;

    // Two-column layout: credit / debit
    const dcMatch = rest.match(DEBIT_CREDIT_RE);
    if (dcMatch) {
      const label = rest.slice(0, dcMatch.index).trim();
      if (!label) continue;
      const credit = parseFloat(normalizeAmount(dcMatch[1]));
      const debit  = parseFloat(normalizeAmount(dcMatch[2]));
      const montant = credit > 0 && debit === 0 ? credit : -Math.abs(debit);
      rows.push({ Date: date, Libellé: label, Montant: String(montant) });
      continue;
    }

    // Single amount at end
    const amtMatch = rest.match(AMOUNT_END_RE);
    if (!amtMatch) continue;

    const label = rest.slice(0, amtMatch.index).trim();
    if (!label) continue;

    rows.push({ Date: date, Libellé: label, Montant: normalizeAmount(amtMatch[1]) });
  }

  return { rows, headers: ["Date", "Libellé", "Montant"] };
}
