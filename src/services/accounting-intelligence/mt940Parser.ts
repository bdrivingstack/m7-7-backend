import type { CsvRow } from "./csvParser.js";

// SWIFT MT940 parser — Customer Statement Message
export function parseMt940(buffer: Buffer): { rows: CsvRow[]; headers: string[]; currency: string } {
  const text = buffer.toString("utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const headers = ["Date", "DateValeur", "Libellé", "Montant", "Type", "Référence"];

  // Extract currency from :60F: or :60M: (opening balance line)
  const currMatch = text.match(/:60[FM]:([CD])(\d{6})([A-Z]{3})([\d,]+)/);
  const currency = currMatch?.[3] ?? "EUR";

  const rows: CsvRow[] = [];

  // Each transaction is a :61: line optionally followed by :86: details
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const tag61 = line.match(/^:61:(\d{6})(\d{4})?([CD]|RC|RD)(\d+(?:,\d{2})?)([A-Z]{4})(.{0,16})/);
    if (tag61) {
      const [, valDate, entryDate, cdInd, amt, trnType, reference] = tag61;
      const isDebit = cdInd === "D" || cdInd === "RD";
      const amount = (isDebit ? "-" : "") + amt.replace(",", ".");

      const yy = valDate.slice(0, 2);
      const mm = valDate.slice(2, 4);
      const dd = valDate.slice(4, 6);
      const year = `20${yy}`;
      const valDateFmt = `${year}-${mm}-${dd}`;

      let entryDateFmt = valDateFmt;
      if (entryDate) {
        const emm = entryDate.slice(0, 2);
        const edd = entryDate.slice(2, 4);
        entryDateFmt = `${year}-${emm}-${edd}`;
      }

      // Read the next :86: line for description
      let label = `${trnType} ${reference}`.trim();
      if (i + 1 < lines.length && lines[i + 1].startsWith(":86:")) {
        const detail = lines[i + 1].slice(4);
        // MT940 :86: may have /sub-fields like /001/text/020/text
        // Strip sub-field codes and join meaningful text
        label = detail.replace(/\/\d{3}\//g, " ").replace(/\s+/g, " ").trim() || label;
        // Read continuation lines (start with space or no tag)
        let j = i + 2;
        while (j < lines.length && (lines[j].startsWith("-") || (!lines[j].match(/^:[0-9]{2}/) && lines[j].trim()))) {
          label += " " + lines[j].replace(/\/\d{3}\//g, " ").trim();
          j++;
        }
        i = j - 1;
      }

      rows.push({
        Date: entryDateFmt,
        DateValeur: valDateFmt,
        Libellé: label.slice(0, 140),
        Montant: amount,
        Type: isDebit ? "Débit" : "Crédit",
        Référence: reference.trim(),
      });
    }
    i++;
  }

  return { rows, headers, currency };
}
