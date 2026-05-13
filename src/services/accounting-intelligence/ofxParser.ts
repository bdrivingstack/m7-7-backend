import type { CsvRow } from "./csvParser.js";

function getTag(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  const end = text.indexOf(close, start);
  if (end === -1) {
    // SGML style: no closing tag, value ends at next tag or newline
    const after = text.slice(start + open.length);
    const match = after.match(/^([^\n<]*)/);
    return match?.[1]?.trim();
  }
  return text.slice(start + open.length, end).trim();
}

function parseOfxDate(raw: string | undefined): string {
  if (!raw) return "";
  // OFX dates: YYYYMMDD or YYYYMMDDHHMMSS[.mmm][+|-HH:mm]
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length >= 8) {
    const y = digits.slice(0, 4);
    const m = digits.slice(4, 6);
    const d = digits.slice(6, 8);
    return `${y}-${m}-${d}`;
  }
  return raw;
}

export function parseOfx(buffer: Buffer): { rows: CsvRow[]; headers: string[] } {
  const text = buffer.toString("utf8").replace(/^﻿/, "");

  // Split into transaction blocks
  const blocks: string[] = [];
  const stmtPattern = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match: RegExpExecArray | null;
  while ((match = stmtPattern.exec(text)) !== null) blocks.push(match[1]);

  // SGML fallback: STMTTRN without closing tag
  if (blocks.length === 0) {
    const parts = text.split(/(?=<STMTTRN>)/i).slice(1);
    parts.forEach((part) => {
      const end = part.search(/<\/STMTTRN>|<STMTTRN>/i);
      blocks.push(end === -1 ? part : part.slice(0, end));
    });
  }

  const headers = ["Date", "Libellé", "Montant", "Type", "Référence", "Mémo"];
  const rows: CsvRow[] = blocks.map((block) => {
    const trnType = getTag(block, "TRNTYPE") ?? "";
    const dtPosted = parseOfxDate(getTag(block, "DTPOSTED") ?? getTag(block, "DTAVAIL"));
    const trnAmt = getTag(block, "TRNAMT") ?? "0";
    const name = getTag(block, "NAME") ?? getTag(block, "MEMO") ?? "";
    const memo = getTag(block, "MEMO") ?? "";
    const fitId = getTag(block, "FITID") ?? "";

    return {
      Date: dtPosted,
      Libellé: name || memo,
      Montant: trnAmt.replace(",", "."),
      Type: trnType,
      Référence: fitId,
      Mémo: memo,
    };
  });

  return { rows: rows.filter((r) => r["Date"] && r["Montant"] !== "0"), headers };
}
