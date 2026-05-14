import { createWorker } from "tesseract.js";
import { parsePdf } from "./pdfParser.js";
import { parseMoney } from "./normalization.js";

export type OcrResult = {
  rawText: string;
  confidence: number;
  supplierName?: string;
  invoiceDate?: Date;
  invoiceNumber?: string;
  totalTTC?: number;
  totalHT?: number;
  totalVat?: number;
  vatLines: Array<{ vatRate: number; amountHT: number; vatAmount: number; amountTTC: number }>;
  documentType: "receipt" | "invoice" | "bank_statement" | "unknown";
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findMoney(text: string, labels: string[]): number | null {
  const norm = text.replace(/\s+/g, " ");
  for (const label of labels) {
    // Match label then optional non-digits then a money value
    const re = new RegExp(
      `${label}[^0-9\\-]{0,15}([\\-]?\\d[\\d\\s]*[,\\.]\\d{2})`,
      "i"
    );
    const m = norm.match(re);
    if (m) {
      const val = parseMoney(m[1]);
      if (val !== null && Math.abs(val) > 0) return val;
    }
  }
  return null;
}

function findDate(text: string): Date | null {
  const patterns = [
    // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    /(\d{1,2})[\/\-\.](\d{2})[\/\-\.](\d{4})/,
    // D month YYYY (French)
    /(\d{1,2})\s+(jan(?:v(?:ier)?)?|fév(?:r(?:ier)?)?|mar(?:s)?|avr(?:il)?|mai|juin|juil(?:let)?|aoû?t|sep(?:t(?:embre)?)?|oct(?:obre)?|nov(?:embre)?|déc(?:embre)?)\s+(\d{4})/i,
  ];
  const monthMap: Record<string, string> = {
    jan: "01", janv: "01", janvier: "01",
    fév: "02", fevr: "02", février: "02",
    mar: "03", mars: "03",
    avr: "04", avril: "04",
    mai: "05",
    juin: "06",
    juil: "07", juillet: "07",
    aoû: "08", aout: "08",
    sep: "09", sept: "09", septembre: "09",
    oct: "10", octobre: "10",
    nov: "11", novembre: "11",
    déc: "12", decembre: "12",
  };

  for (const line of text.split(/\n/)) {
    const m1 = line.match(patterns[0]);
    if (m1) {
      const d = new Date(`${m1[3]}-${m1[2].padStart(2, "0")}-${m1[1].padStart(2, "0")}T12:00:00Z`);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) return d;
    }
    const m2 = line.match(patterns[1]);
    if (m2) {
      const month = monthMap[m2[2].toLowerCase().slice(0, 4)] ?? "01";
      const d = new Date(`${m2[3]}-${month}-${m2[1].padStart(2, "0")}T12:00:00Z`);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function findSupplier(text: string): string | undefined {
  // First non-empty line that looks like a name (not a date, not all digits)
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && l.length < 80);

  for (const line of lines.slice(0, 8)) {
    // Skip lines that are only numbers / separators / dates
    if (/^[\d\s\/\-\.\*=#_,;:]+$/.test(line)) continue;
    if (/^(?:total|tva|date|heure|ticket|reçu|facture|merci|bienvenue)/i.test(line)) continue;
    return line.replace(/[*=#_]+/g, "").trim().slice(0, 60) || undefined;
  }
  return undefined;
}

function findVatLines(text: string): OcrResult["vatLines"] {
  const lines: OcrResult["vatLines"] = [];
  // Pattern: TVA 20% ... HT ... TVA ... TTC  (on one or consecutive lines)
  const re = /tva\s*(?:à\s*)?(\d+(?:[,\.]\d+)?)\s*%[^\n]*?(\d[\d\s,\.]+\d)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rate = parseMoney(m[1]);
    const vatAmt = parseMoney(m[2]);
    if (rate !== null && vatAmt !== null && vatAmt > 0) {
      const amtHT = vatAmt / (rate / 100);
      const amtTTC = amtHT + vatAmt;
      lines.push({ vatRate: rate, amountHT: Math.round(amtHT * 100) / 100, vatAmount: vatAmt, amountTTC: Math.round(amtTTC * 100) / 100 });
    }
  }
  return lines;
}

function detectDocumentType(text: string): OcrResult["documentType"] {
  const t = text.toLowerCase();
  if (/facture\s+n[°o]|invoice\s+n[°o]|bon\s+de\s+commande/.test(t)) return "invoice";
  if (/relevé|compte|solde|iban|bic|virement|prélèvement|rib/.test(t)) return "bank_statement";
  if (/ticket|reçu|caisse|tpe|merci|bienvenue|magasin|parking|stationnement/.test(t)) return "receipt";
  return "unknown";
}

// ─── Image OCR via Tesseract ──────────────────────────────────────────────────

async function ocrImage(buffer: Buffer): Promise<{ text: string; confidence: number }> {
  const worker = await createWorker(["fra", "eng"], 1, {
    logger: () => {},
    errorHandler: () => {},
  } as any);

  try {
    const { data } = await worker.recognize(buffer);
    return { text: data.text ?? "", confidence: (data.confidence ?? 0) / 100 };
  } finally {
    await worker.terminate();
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function extractReceiptData(
  buffer: Buffer,
  mimeType: string
): Promise<OcrResult> {
  let rawText = "";
  let confidence = 0;

  const isPdf = mimeType === "application/pdf" || mimeType === "application/x-pdf";

  if (isPdf) {
    // Text-based PDF: use existing parser
    const { rows } = await parsePdf(buffer);
    rawText = rows.map((r) => `${r["Date"] ?? ""} ${r["Libellé"] ?? ""} ${r["Montant"] ?? ""}`).join("\n");
    confidence = rawText.length > 50 ? 0.85 : 0;

    // If no text rows (scanned PDF), fall back to OCR
    if (confidence === 0) {
      const ocr = await ocrImage(buffer);
      rawText = ocr.text;
      confidence = ocr.confidence;
    }
  } else {
    // Image (JPEG, PNG, HEIC, WEBP, etc.) → Tesseract
    const ocr = await ocrImage(buffer);
    rawText = ocr.text;
    confidence = ocr.confidence;
  }

  if (!rawText.trim()) {
    return { rawText: "", confidence: 0, vatLines: [], documentType: "unknown" };
  }

  const totalTTC = findMoney(rawText, [
    "total\\s*ttc", "montant\\s*ttc", "net\\s*à\\s*payer", "à\\s*payer",
    "total\\s*dû", "total\\s*net", "total", "montant", "net à payer",
  ]) ?? undefined;

  const totalVat = findMoney(rawText, [
    "tva\\s*(?:à\\s*)?\\d+\\s*%", "montant\\s*tva", "total\\s*tva", "tva",
  ]) ?? undefined;

  const totalHT = totalTTC !== undefined && totalVat !== undefined
    ? Math.round((totalTTC - totalVat) * 100) / 100
    : findMoney(rawText, ["total\\s*ht", "montant\\s*ht", "sous[-\\s]total", "net"]) ?? undefined;

  return {
    rawText,
    confidence,
    supplierName: findSupplier(rawText),
    invoiceDate: findDate(rawText) ?? undefined,
    invoiceNumber: rawText.match(/(?:n[°o\s]?\s*(?:facture|ticket|ticket)?)\s*:?\s*([A-Z0-9\-\/]{4,20})/i)?.[1],
    totalTTC,
    totalHT,
    totalVat,
    vatLines: findVatLines(rawText),
    documentType: detectDocumentType(rawText),
  };
}
