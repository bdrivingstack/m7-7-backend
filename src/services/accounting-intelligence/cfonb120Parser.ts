import type { CsvRow } from "./csvParser.js";

// CFONB120 / AFB120 — Format bancaire français à largeur fixe (120 caractères/ligne)
// Codes enregistrements : 07 = solde initial, 04 = opération, 08 = solde final

function parseDate(day: string, month: string, year: string): string {
  const d = day.padStart(2, "0");
  const m = month.padStart(2, "0");
  const y = year.length === 2 ? `20${year}` : year;
  return `${y}-${m}-${d}`;
}

export function parseCfonb120(buffer: Buffer): { rows: CsvRow[]; headers: string[] } {
  const text = buffer.toString("latin1").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.length >= 80);
  const headers = ["Date", "DateValeur", "Libellé", "Montant", "Type", "Référence", "NCompte"];
  const rows: CsvRow[] = [];

  for (const line of lines) {
    const code = line.slice(0, 2);
    if (code !== "04") continue; // Only operation records

    // CFONB120 standard positions (1-indexed, converted to 0-indexed)
    // Pos 1-2:   Record code
    // Pos 3-5:   Bank code
    // Pos 6-11:  Counter/branch code
    // Pos 12:    blank
    // Pos 13-23: Account number (11 chars)
    // Pos 24-25: Currency indicator (00=EUR, etc.)
    // Pos 26:    Sign indicator (1st)
    // Pos 27-35: Amount in cents (9 digits)
    // Pos 36-37: Rejection code / operation type
    // Pos 38-40: Value date DD + MM (3 digits)
    // Pos 41:    Value date separator
    // Pos 42-45: Value date year or month+year
    // Pos 46-47: Operation date DD
    // Pos 48-49: Operation date MM
    // Pos 50-51: Operation date YY/YYYY
    // Pos 52-??:  Label/libellé (pos 52-82 typically, 31 chars)
    // ...

    try {
      const accountNum = line.slice(10, 22).trim();

      // Amount: positions 25-35 (10 chars), implied 2 decimals
      const signChar = line.slice(24, 25); // C or D (or space)
      const rawAmount = line.slice(25, 35).trim();
      const amountCents = parseInt(rawAmount, 10);
      if (isNaN(amountCents)) continue;

      const isDebit = signChar === "D" || signChar === "1";
      const amount = ((isDebit ? -1 : 1) * amountCents / 100).toFixed(2);

      // Value date: positions 35-40 (DDMMYY or DDMMYYYY)
      const valDay = line.slice(35, 37).trim();
      const valMonth = line.slice(37, 39).trim();
      const valYear = line.slice(39, 41).length === 2 ? line.slice(39, 41).trim() : line.slice(39, 43).trim();
      const valDate = (valDay && valMonth && valYear) ? parseDate(valDay, valMonth, valYear) : "";

      // Operation date: positions 41-46 or after
      const opDay = line.slice(41, 43).trim();
      const opMonth = line.slice(43, 45).trim();
      const opYear = line.slice(45, 47).trim();
      const opDate = (opDay && opMonth && opYear) ? parseDate(opDay, opMonth, opYear) : valDate;

      // Label: positions 48-79 (31 chars typically)
      const label = line.slice(48, 79).trim();

      // Reference: positions 80-88 or so
      const reference = line.slice(79, 94).trim();

      rows.push({
        Date: opDate || valDate,
        DateValeur: valDate,
        Libellé: label,
        Montant: amount,
        Type: isDebit ? "Débit" : "Crédit",
        Référence: reference,
        NCompte: accountNum,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return { rows: rows.filter((r) => r["Date"] && r["Montant"] !== "0.00"), headers };
}
