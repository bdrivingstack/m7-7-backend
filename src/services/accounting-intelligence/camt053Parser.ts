import type { CsvRow } from "./csvParser.js";

// Minimal regex-based CAMT.053/054 XML parser (ISO 20022)
function extractAll(text: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) results.push(m[1]);
  return results;
}

function extractFirst(text: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return text.match(re)?.[1]?.trim();
}

function extractAttr(text: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i");
  return text.match(re)?.[1];
}

export function parseCamt053(buffer: Buffer): { rows: CsvRow[]; headers: string[]; format: string } {
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  const isCAMT054 = text.includes("camt.054") || text.includes("BkToCstmrDbtCdtNtfctn");
  const format = isCAMT054 ? "CAMT.054" : "CAMT.053";

  const headers = ["Date", "DateValeur", "Libellé", "Montant", "Débit/Crédit", "Devise", "Référence"];
  const rows: CsvRow[] = [];

  // Each <Ntry> is one bank entry (could contain multiple transactions)
  const entries = extractAll(text, "Ntry");

  for (const entry of entries) {
    const amt = extractFirst(entry, "Amt") ?? "0";
    const ccy = extractAttr(entry, "Amt", "Ccy") ?? extractFirst(entry, "Ccy") ?? "EUR";
    const cdtDbt = extractFirst(entry, "CdtDbtInd") ?? ""; // CRDT or DBIT
    const bookDt = extractFirst(extractFirst(entry, "BookgDt") ?? entry, "Dt") ?? extractFirst(entry, "DtTm")?.slice(0, 10) ?? "";
    const valDt = extractFirst(extractFirst(entry, "ValDt") ?? entry, "Dt") ?? bookDt;
    const ntryRef = extractFirst(entry, "NtryRef") ?? "";

    // Try to get label from multiple possible locations
    let label = extractFirst(entry, "AddtlNtryInf")
      ?? extractFirst(entry, "Ustrd")
      ?? extractFirst(entry, "AddtlTxInf")
      ?? extractFirst(entry, "NtryDtls")?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      ?? "";

    // Clean up XML tags if any leaked through
    label = label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);

    const sign = cdtDbt === "DBIT" ? "-" : "";
    const amount = `${sign}${amt.replace(",", ".")}`;

    rows.push({
      Date: bookDt,
      DateValeur: valDt,
      Libellé: label,
      Montant: amount,
      "Débit/Crédit": cdtDbt === "DBIT" ? "Débit" : "Crédit",
      Devise: ccy,
      Référence: ntryRef,
    });
  }

  return { rows: rows.filter((r) => r["Date"] && r["Montant"] !== "0"), headers, format };
}
