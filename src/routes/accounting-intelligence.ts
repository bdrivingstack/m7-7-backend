import { Router } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { deleteLocalFile, uploadMultiple, uploadSingle } from "../middleware/uploadHandler.js";
import { parseCsv } from "../services/accounting-intelligence/csvParser.js";
import { parseXlsx } from "../services/accounting-intelligence/xlsxParser.js";
import { parseOfx } from "../services/accounting-intelligence/ofxParser.js";
import { parseQif } from "../services/accounting-intelligence/qifParser.js";
import { parseCamt053 } from "../services/accounting-intelligence/camt053Parser.js";
import { parseMt940 } from "../services/accounting-intelligence/mt940Parser.js";
import { parseCfonb120 } from "../services/accounting-intelligence/cfonb120Parser.js";
import { normalizeText, parseFrenchDate, parseMoney } from "../services/accounting-intelligence/normalization.js";
import { suggestVatQualification, reinforceVatLearningRule } from "../services/accounting-intelligence/vatEngine.js";
import { suggestActivityProfile } from "../services/accounting-intelligence/activityEngine.js";
import { attachReceiptToTransaction, deleteReceiptFromTransaction, replaceReceiptOnTransaction } from "../services/accounting-intelligence/receiptLifecycle.js";
import type { CsvRow } from "../services/accounting-intelligence/csvParser.js";

export const accountingIntelligenceRouter = Router();
accountingIntelligenceRouter.use(authenticate);

// ─── Détection format + parsing unifié ───────────────────────────────────────

type ParseResult = { rows: CsvRow[]; headers: string[]; source: string; detectedFormat: string };

function detectAndParse(buffer: Buffer, originalName: string): ParseResult {
  const ext = path.extname(originalName).toLowerCase();
  const textPreview = buffer.slice(0, 500).toString("utf8").replace(/[^\x20-\x7E\n\r\t]/g, "");

  if (ext === ".xlsx" || ext === ".xls") {
    const result = parseXlsx(buffer);
    return { ...result, source: ext === ".xlsx" ? "BANK_XLSX" : "BANK_XLSX", detectedFormat: `XLSX:${result.sheetName}` };
  }
  if (ext === ".ofx" || ext === ".qbo" || textPreview.includes("OFXHEADER") || textPreview.includes("<OFX>")) {
    const result = parseOfx(buffer);
    return { ...result, source: "BANK_OFX", detectedFormat: "OFX/QBO" };
  }
  if (ext === ".qif" || textPreview.startsWith("!Type:")) {
    const result = parseQif(buffer);
    return { ...result, source: "BANK_QIF", detectedFormat: "QIF" };
  }
  if (ext === ".xml" || textPreview.includes("camt.053") || textPreview.includes("camt.054") || textPreview.includes("BkToCstmrStmt") || textPreview.includes("BkToCstmrDbtCdtNtfctn")) {
    const result = parseCamt053(buffer);
    return { ...result, source: result.format === "CAMT.054" ? "BANK_CAMT054" : "BANK_CAMT053", detectedFormat: result.format };
  }
  if (ext === ".mt940" || ext === ".sta" || textPreview.match(/:20:|:25:|:28C:|:60[FM]:/)) {
    const result = parseMt940(buffer);
    return { ...result, source: "BANK_MT940", detectedFormat: `MT940:${result.currency}` };
  }
  if (ext === ".cfonb" || (ext === ".txt" && buffer.length > 0 && buffer.slice(0, 2).toString("ascii").match(/^0[4-8]/))) {
    const result = parseCfonb120(buffer);
    return { ...result, source: "BANK_CFONB120", detectedFormat: "CFONB120" };
  }
  // Default: CSV (also handles .csv with any separator)
  const result = parseCsv(buffer);
  return { rows: result.rows, headers: result.headers, source: "BANK_CSV", detectedFormat: `CSV:${result.delimiter}` };
}

// ─── Helper aliasing colonnes ─────────────────────────────────────────────────

const pick = (row: Record<string, string>, aliases: string[]) => {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const found = entries.find(([key]) => normalizeText(key) === normalizeText(alias));
    if (found) return found[1];
  }
  return undefined;
};

async function getPrimaryActivity(orgId: string) {
  return (prisma as any).orgActivityProfile.findFirst({ where: { orgId, status: { in: ["USER_VALIDATED", "ACCOUNTANT_VALIDATED", "SUGGESTED"] } }, orderBy: { updatedAt: "desc" } });
}

accountingIntelligenceRouter.post("/activity/suggest", async (req, res, next) => {
  try {
    const org = await prisma.org.findUnique({ where: { id: req.user.orgId } });
    const body = z.object({ nafCode: z.string().optional(), objectSocial: z.string().optional() }).parse(req.body ?? {});
    const profile = await suggestActivityProfile({ orgId: req.user.orgId, nafCode: body.nafCode ?? org?.nafCode, objectSocial: body.objectSocial });
    res.json({ data: profile, message: "Activité suggérée à valider par l'utilisateur." });
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.patch("/activity/:id/validate", async (req, res, next) => {
  try {
    const body = z.object({ activityLabel: z.string().min(2).optional(), objectSocial: z.string().optional() }).parse(req.body ?? {});
    const profile = await (prisma as any).orgActivityProfile.update({
      where: { id: req.params.id },
      data: { status: "USER_VALIDATED", userConfirmedLabel: body.activityLabel, objectSocial: body.objectSocial, validatedAt: new Date(), confidenceScore: 0.95 as any },
    });
    res.json({ data: profile });
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.get("/transactions", async (req, res, next) => {
  try {
    const transactions = await (prisma as any).bankTransaction.findMany({
      where: { orgId: req.user.orgId },
      orderBy: { bookingDate: "desc" },
      take: Math.min(Number(req.query.limit ?? 100), 300),
    });
    res.json({ data: transactions });
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.post("/imports/bank-csv", uploadSingle, async (req, res, next) => {
  try {
    if (!req.file) throw new Error("Aucun fichier reçu.");
    const buffer = fs.readFileSync(req.file.path);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const parsed = parseCsv(buffer);
    const activity = await getPrimaryActivity(req.user.orgId);

    const document = await prisma.document.create({ data: {
      orgId: req.user.orgId,
      name: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      storagePath: req.file.path,
      checksum: hash,
      category: "bank_statement",
      tags: ["bank", "import"],
      uploadedById: req.user.id,
    }});

    const financialImport = await (prisma as any).financialImport.create({ data: {
      orgId: req.user.orgId,
      documentId: document.id,
      source: "BANK_CSV",
      status: "PARSED",
      originalName: req.file.originalname,
      fileHash: hash,
      detectedFormat: `CSV:${parsed.delimiter}`,
      rowsTotal: parsed.rows.length,
      metadata: { headers: parsed.headers },
    }});

    let imported = 0;
    let failed = 0;
    const created: unknown[] = [];

    for (const row of parsed.rows) {
      const date = parseFrenchDate(pick(row, ["Date", "Date opération", "Date comptable", "bookingDate"]));
      const label = pick(row, ["Libellé", "Libelle", "Description", "Opération", "Operation", "Nom", "label"]);
      const amount = parseMoney(pick(row, ["Montant", "Amount", "Débit/Crédit", "Debit/Credit", "TTC", "Montant TTC"]));
      const debit = parseMoney(pick(row, ["Débit", "Debit"]));
      const credit = parseMoney(pick(row, ["Crédit", "Credit"]));
      const amountTTC = amount ?? (credit !== null ? credit : debit !== null ? -Math.abs(debit) : null);
      if (!date || !label || amountTTC === null) { failed += 1; continue; }

      const vatAmount = parseMoney(pick(row, ["TVA", "Montant TVA", "VAT", "VAT amount"]));
      const vatRate = parseMoney(pick(row, ["Taux TVA", "VAT rate", "Taux", "% TVA"]));
      const amountHT = parseMoney(pick(row, ["HT", "Montant HT", "Net", "Amount without tax"]));
      const operationType = amountTTC > 0 ? "INCOME" : amountTTC < 0 ? "EXPENSE" : "UNKNOWN";
      const merchantName = pick(row, ["Fournisseur", "Marchand", "Merchant", "Bénéficiaire", "Beneficiaire"]);
      const suggestion = await suggestVatQualification({
        orgId: req.user.orgId,
        activityLabel: activity?.userConfirmedLabel ?? activity?.activityLabel,
        merchantName,
        label,
        amountTTC,
        vatRateImported: vatRate,
        vatAmountImported: vatAmount,
        operationType: operationType as any,
      });

      const tx = await (prisma as any).bankTransaction.create({ data: {
        orgId: req.user.orgId,
        importId: financialImport.id,
        documentId: document.id,
        bookingDate: date,
        valueDate: parseFrenchDate(pick(row, ["Date valeur", "Value date"])) ?? undefined,
        labelRaw: label,
        labelNormalized: normalizeText(label),
        merchantName: merchantName ?? normalizeText(label).split(" ").slice(0, 3).join(" "),
        reference: pick(row, ["Référence", "Reference", "Ref"]),
        amountTTC: amountTTC as any,
        amountHT: amountHT as any,
        vatAmount: vatAmount as any,
        currency: pick(row, ["Devise", "Currency"]) || "EUR",
        type: operationType as any,
        category: pick(row, ["Catégorie", "Categorie", "Category"]),
        vatType: suggestion.vatType as any,
        vatSource: suggestion.source as any,
        vatConfidence: suggestion.confidenceScore as any,
        vatNeedsReview: suggestion.needsReview,
        accountingAccount: suggestion.accountingAccount,
        deductiblePercentage: suggestion.deductiblePercentage as any,
        metadata: { originalRow: row, vatReason: suggestion.reason },
      }});
      created.push(tx);
      imported += 1;
    }

    await (prisma as any).financialImport.update({ where: { id: financialImport.id }, data: { rowsImported: imported, rowsFailed: failed, status: failed > 0 ? "NEEDS_REVIEW" : "PARSED" } });
    res.status(201).json({ data: { importId: financialImport.id, documentId: document.id, rowsTotal: parsed.rows.length, rowsImported: imported, rowsFailed: failed, transactions: created } });
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.patch("/transactions/:id/vat", async (req, res, next) => {
  try {
    const body = z.object({
      vatType: z.enum(["DEDUCTIBLE", "NON_DEDUCTIBLE", "COLLECTED", "REVERSE_CHARGE", "EXEMPT", "MIXED", "UNKNOWN"]),
      vatRate: z.number().optional(),
      vatAmount: z.number().optional(),
      amountHT: z.number().optional(),
      accountingAccount: z.string().optional(),
      deductiblePercentage: z.number().optional(),
      applyLearning: z.boolean().default(true),
    }).parse(req.body);

    const tx = await (prisma as any).bankTransaction.findFirstOrThrow({ where: { id: req.params.id, orgId: req.user.orgId } });
    const activity = await getPrimaryActivity(req.user.orgId);
    const updated = await (prisma as any).bankTransaction.update({ where: { id: tx.id }, data: {
      vatType: body.vatType as any,
      vatAmount: body.vatAmount as any,
      amountHT: body.amountHT as any,
      accountingAccount: body.accountingAccount,
      deductiblePercentage: body.deductiblePercentage as any,
      vatSource: "USER_CONFIRMED",
      vatConfidence: 1 as any,
      vatNeedsReview: false,
      userValidatedAt: new Date(),
    }});

    if (body.applyLearning) {
      await reinforceVatLearningRule({ orgId: req.user.orgId, userId: req.user.id, activityLabel: activity?.userConfirmedLabel ?? activity?.activityLabel, merchantName: tx.merchantName, label: tx.labelRaw, vatType: body.vatType, vatRate: body.vatRate, accountingAccount: body.accountingAccount, deductiblePercentage: body.deductiblePercentage });
    }
    res.json({ data: updated });
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.post("/transactions/:id/receipt", uploadMultiple, async (req, res, next) => {
  try {
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length) throw new Error("Ajoute au moins une photo ou un PDF de justificatif.");

    const result = await attachReceiptToTransaction({
      orgId: req.user.orgId,
      userId: req.user.id,
      transactionId: req.params.id,
      files,
      notes: typeof req.body?.notes === "string" ? req.body.notes : undefined,
    });

    res.status(201).json({
      data: result,
      message: "Justificatif scanné rattaché à l'opération. Les données OCR sont à valider.",
    });
  } catch (err) {
    for (const file of ((req.files ?? []) as Express.Multer.File[])) deleteLocalFile(file.path);
    next(err);
  }
});

accountingIntelligenceRouter.put("/transactions/:id/receipt", uploadMultiple, async (req, res, next) => {
  try {
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!files.length) throw new Error("Ajoute le nouveau justificatif à utiliser en remplacement.");

    const result = await replaceReceiptOnTransaction({
      orgId: req.user.orgId,
      userId: req.user.id,
      transactionId: req.params.id,
      files,
      notes: typeof req.body?.notes === "string" ? req.body.notes : undefined,
    });

    res.json({
      data: result,
      message: "Justificatif remplacé. Les anciennes données extraites ont été supprimées et remplacées.",
    });
  } catch (err) {
    for (const file of ((req.files ?? []) as Express.Multer.File[])) deleteLocalFile(file.path);
    next(err);
  }
});

accountingIntelligenceRouter.delete("/transactions/:id/receipt", async (req, res, next) => {
  try {
    const result = await deleteReceiptFromTransaction({
      orgId: req.user.orgId,
      transactionId: req.params.id,
      hardDeleteFile: req.query.hard === "1",
    });

    res.json({
      data: result,
      message: "Justificatif supprimé. Les données OCR/TVA associées ont été retirées de l'opération.",
    });
  } catch (err) { next(err); }
});

// ─── Export FEC (Fichier des Écritures Comptables) ───────────────────────────

accountingIntelligenceRouter.get("/exports/transactions.fec", async (req, res, next) => {
  try {
    const txs = await (prisma as any).bankTransaction.findMany({ where: { orgId: req.user.orgId }, orderBy: { bookingDate: "asc" } });
    const header = ["JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef", "PieceDate", "EcritureLib", "Debit", "Credit", "EcritureLet", "DateLet", "ValidDate", "Montantdevise", "Idevise"];
    const lines: string[] = [header.join("|")];
    let num = 1;
    for (const tx of txs) {
      const date = new Date(tx.bookingDate).toISOString().slice(0, 10).replace(/-/g, "");
      const isIncome = Number(tx.amountTTC) > 0;
      const amt = Math.abs(Number(tx.amountTTC));
      const ht = tx.amountHT ? Math.abs(Number(tx.amountHT)) : amt;
      const vat = tx.vatAmount ? Math.abs(Number(tx.vatAmount)) : 0;
      const ecrNum = String(num++).padStart(8, "0");
      const bankAcc = "512100"; const counterAcc = tx.accountingAccount ?? (isIncome ? "706000" : "606100");
      const lib = (tx.labelRaw ?? "").replace(/\|/g, " ").slice(0, 100);
      const ref = (tx.reference ?? "").replace(/\|/g, " ");
      const fmtAmt = (n: number) => n.toFixed(2).replace(".", ",");
      if (isIncome) {
        lines.push([`BQ`, `Banque`, ecrNum, date, bankAcc, `Banque`, ``, ``, ref, date, lib, fmtAmt(amt), `0,00`, ``, ``, ``, ``, ``].join("|"));
        lines.push([`BQ`, `Banque`, ecrNum, date, counterAcc, `Produits`, ``, ``, ref, date, lib, `0,00`, fmtAmt(ht), ``, ``, ``, ``, ``].join("|"));
        if (vat > 0) lines.push([`BQ`, `Banque`, ecrNum, date, `445710`, `TVA collectée`, ``, ``, ref, date, lib, `0,00`, fmtAmt(vat), ``, ``, ``, ``, ``].join("|"));
      } else {
        lines.push([`BQ`, `Banque`, ecrNum, date, bankAcc, `Banque`, ``, ``, ref, date, lib, `0,00`, fmtAmt(amt), ``, ``, ``, ``, ``].join("|"));
        lines.push([`BQ`, `Banque`, ecrNum, date, counterAcc, `Charges`, ``, ``, ref, date, lib, fmtAmt(ht), `0,00`, ``, ``, ``, ``, ``].join("|"));
        if (vat > 0) lines.push([`BQ`, `Banque`, ecrNum, date, `445660`, `TVA déductible`, ``, ``, ref, date, lib, fmtAmt(vat), `0,00`, ``, ``, ``, ``, ``].join("|"));
      }
    }
    const fec = lines.join("\n");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=FEC_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.txt`);
    res.send(`﻿${fec}`);
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.get("/learning-rules", async (req, res, next) => {
  try {
    const rules = await (prisma as any).vatLearningRule.findMany({ where: { orgId: req.user.orgId }, orderBy: [{ appliesAutomatically: "desc" }, { confidenceScore: "desc" }] });
    res.json({ data: rules });
  } catch (err) { next(err); }
});

// ─── Import multi-format (CSV, XLSX, OFX, QIF, CAMT.053, MT940, CFONB120) ───

accountingIntelligenceRouter.post("/imports/bank-multi", uploadSingle, async (req, res, next) => {
  try {
    if (!req.file) throw new Error("Aucun fichier reçu.");
    const buffer = fs.readFileSync(req.file.path);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");

    const { rows, source, detectedFormat } = detectAndParse(buffer, req.file.originalname);
    const activity = await getPrimaryActivity(req.user.orgId);

    const document = await prisma.document.create({ data: {
      orgId: req.user.orgId,
      name: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      storagePath: req.file.path,
      checksum: hash,
      category: "bank_statement",
      tags: ["bank", "import", source.toLowerCase()],
      uploadedById: req.user.id,
    }});

    const financialImport = await (prisma as any).financialImport.create({ data: {
      orgId: req.user.orgId,
      documentId: document.id,
      source,
      status: "PARSED",
      originalName: req.file.originalname,
      fileHash: hash,
      detectedFormat,
      rowsTotal: rows.length,
      metadata: {},
    }});

    let imported = 0;
    let failed = 0;
    const created: unknown[] = [];

    for (const row of rows) {
      const date = parseFrenchDate(pick(row, ["Date", "Date opération", "Date comptable", "bookingDate", "DtPosted"]));
      const label = pick(row, ["Libellé", "Libelle", "Description", "Opération", "Operation", "Nom", "label", "name"]);
      const amount = parseMoney(pick(row, ["Montant", "Amount", "Débit/Crédit", "Debit/Credit", "TTC", "Montant TTC"]));
      const debit = parseMoney(pick(row, ["Débit", "Debit"]));
      const credit = parseMoney(pick(row, ["Crédit", "Credit"]));
      const amountTTC = amount ?? (credit !== null ? credit : debit !== null ? -Math.abs(debit) : null);
      if (!date || !label || amountTTC === null) { failed += 1; continue; }

      const vatAmount = parseMoney(pick(row, ["TVA", "Montant TVA", "VAT"]));
      const vatRate = parseMoney(pick(row, ["Taux TVA", "VAT rate"]));
      const amountHT = parseMoney(pick(row, ["HT", "Montant HT", "Net"]));
      const operationType = amountTTC > 0 ? "INCOME" : amountTTC < 0 ? "EXPENSE" : "UNKNOWN";
      const merchantName = pick(row, ["Fournisseur", "Marchand", "Merchant", "Bénéficiaire", "Payee"]);

      const suggestion = await suggestVatQualification({
        orgId: req.user.orgId,
        activityLabel: activity?.userConfirmedLabel ?? activity?.activityLabel,
        merchantName,
        label,
        amountTTC,
        vatRateImported: vatRate,
        vatAmountImported: vatAmount,
        operationType: operationType as any,
      });

      const tx = await (prisma as any).bankTransaction.create({ data: {
        orgId: req.user.orgId,
        importId: financialImport.id,
        documentId: document.id,
        bookingDate: date,
        valueDate: parseFrenchDate(pick(row, ["Date valeur", "DateValeur", "Value date"])) ?? undefined,
        labelRaw: label,
        labelNormalized: normalizeText(label),
        merchantName: merchantName ?? normalizeText(label).split(" ").slice(0, 3).join(" "),
        reference: pick(row, ["Référence", "Reference", "Ref"]),
        amountTTC: amountTTC as any,
        amountHT: amountHT as any,
        vatAmount: vatAmount as any,
        currency: pick(row, ["Devise", "Currency"]) || "EUR",
        type: operationType as any,
        category: pick(row, ["Catégorie", "Categorie", "Category"]),
        vatType: suggestion.vatType as any,
        vatSource: suggestion.source as any,
        vatConfidence: suggestion.confidenceScore as any,
        vatNeedsReview: suggestion.needsReview,
        accountingAccount: suggestion.accountingAccount,
        deductiblePercentage: suggestion.deductiblePercentage as any,
        metadata: { originalRow: row, vatReason: suggestion.reason, importFormat: detectedFormat },
      }});
      created.push(tx);
      imported += 1;
    }

    await (prisma as any).financialImport.update({ where: { id: financialImport.id }, data: { rowsImported: imported, rowsFailed: failed, status: failed > 0 ? "NEEDS_REVIEW" : "PARSED" } });
    deleteLocalFile(req.file.path);
    res.status(201).json({ data: { importId: financialImport.id, documentId: document.id, format: detectedFormat, rowsTotal: rows.length, rowsImported: imported, rowsFailed: failed, transactions: created } });
  } catch (err) {
    if (req.file) deleteLocalFile(req.file.path);
    next(err);
  }
});

// ─── Aperçu du fichier (preview avant import) ────────────────────────────────

accountingIntelligenceRouter.post("/imports/preview", uploadSingle, async (req, res, next) => {
  try {
    if (!req.file) throw new Error("Aucun fichier reçu.");
    const buffer = fs.readFileSync(req.file.path);
    const { rows, headers, source, detectedFormat } = detectAndParse(buffer, req.file.originalname);
    deleteLocalFile(req.file.path);

    const preview = rows.slice(0, 10).map((row) => {
      const date = parseFrenchDate(pick(row, ["Date", "Date opération", "bookingDate", "DtPosted"]));
      const label = pick(row, ["Libellé", "Libelle", "Description", "Opération", "label", "name"]);
      const amount = parseMoney(pick(row, ["Montant", "Amount", "Débit/Crédit", "TTC"]));
      const debit = parseMoney(pick(row, ["Débit", "Debit"]));
      const credit = parseMoney(pick(row, ["Crédit", "Credit"]));
      const amountTTC = amount ?? (credit !== null ? credit : debit !== null ? -Math.abs(debit) : null);
      return { date: date?.toISOString().slice(0, 10) ?? null, label: label ?? null, amount: amountTTC, raw: row };
    });

    res.json({ data: { detectedFormat, source, totalRows: rows.length, headers, preview } });
  } catch (err) {
    if (req.file) deleteLocalFile(req.file.path);
    next(err);
  }
});

// ─── Sorties comptables ───────────────────────────────────────────────────────

accountingIntelligenceRouter.get("/accounting/journal", async (req, res, next) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const where: Record<string, unknown> = { orgId: req.user.orgId };
    if (from || to) where["bookingDate"] = { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined };

    const txs = await (prisma as any).bankTransaction.findMany({ where, orderBy: { bookingDate: "asc" }, take: 2000 });
    const entries = txs.flatMap((tx: any, idx: number) => {
      const isIncome = Number(tx.amountTTC) > 0;
      const amt = Math.abs(Number(tx.amountTTC));
      const ht = tx.amountHT ? Math.abs(Number(tx.amountHT)) : amt;
      const vat = tx.vatAmount ? Math.abs(Number(tx.vatAmount)) : 0;
      const bankAccount = "512100";
      const counterAccount = tx.accountingAccount ?? (isIncome ? "706000" : "606100");
      const vatAccount = isIncome ? "445710" : "445660";
      const lines: any[] = [];
      const base = { journalCode: "BQ", journalLib: "Banque", ecritureNum: String(idx + 1).padStart(6, "0"), ecritureDate: tx.bookingDate, pieceRef: tx.reference ?? "", ecritureLib: tx.labelRaw };
      if (isIncome) {
        lines.push({ ...base, compteNum: bankAccount, compteLib: "Banque", debit: amt.toFixed(2), credit: "0.00" });
        lines.push({ ...base, compteNum: counterAccount, compteLib: "Produits", debit: "0.00", credit: ht.toFixed(2) });
        if (vat > 0) lines.push({ ...base, compteNum: vatAccount, compteLib: "TVA collectée", debit: "0.00", credit: vat.toFixed(2) });
      } else {
        lines.push({ ...base, compteNum: bankAccount, compteLib: "Banque", debit: "0.00", credit: amt.toFixed(2) });
        lines.push({ ...base, compteNum: counterAccount, compteLib: "Charges", debit: ht.toFixed(2), credit: "0.00" });
        if (vat > 0) lines.push({ ...base, compteNum: vatAccount, compteLib: "TVA déductible", debit: vat.toFixed(2), credit: "0.00" });
      }
      return lines;
    });

    res.json({ data: entries });
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.get("/accounting/grand-livre", async (req, res, next) => {
  try {
    const txs = await (prisma as any).bankTransaction.findMany({ where: { orgId: req.user.orgId }, orderBy: { bookingDate: "asc" }, take: 5000 });
    const accounts: Record<string, { label: string; debit: number; credit: number; solde: number; lines: any[] }> = {};

    const addLine = (account: string, label: string, date: Date, desc: string, debit: number, credit: number) => {
      if (!accounts[account]) accounts[account] = { label, debit: 0, credit: 0, solde: 0, lines: [] };
      accounts[account].debit += debit;
      accounts[account].credit += credit;
      accounts[account].solde = accounts[account].credit - accounts[account].debit;
      accounts[account].lines.push({ date, desc, debit: debit.toFixed(2), credit: credit.toFixed(2) });
    };

    for (const tx of txs) {
      const isIncome = Number(tx.amountTTC) > 0;
      const amt = Math.abs(Number(tx.amountTTC));
      const ht = tx.amountHT ? Math.abs(Number(tx.amountHT)) : amt;
      const vat = tx.vatAmount ? Math.abs(Number(tx.vatAmount)) : 0;
      const counterAccount = tx.accountingAccount ?? (isIncome ? "706000" : "606100");
      const counterLabel = isIncome ? "Produits" : "Charges";
      const vatAccount = isIncome ? "445710" : "445660";
      if (isIncome) {
        addLine("512100", "Banque", tx.bookingDate, tx.labelRaw, amt, 0);
        addLine(counterAccount, counterLabel, tx.bookingDate, tx.labelRaw, 0, ht);
        if (vat > 0) addLine(vatAccount, "TVA collectée", tx.bookingDate, tx.labelRaw, 0, vat);
      } else {
        addLine("512100", "Banque", tx.bookingDate, tx.labelRaw, 0, amt);
        addLine(counterAccount, counterLabel, tx.bookingDate, tx.labelRaw, ht, 0);
        if (vat > 0) addLine(vatAccount, "TVA déductible", tx.bookingDate, tx.labelRaw, vat, 0);
      }
    }

    res.json({ data: Object.entries(accounts).sort(([a], [b]) => a.localeCompare(b)).map(([num, v]) => ({ compte: num, ...v })) });
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.get("/accounting/balance", async (req, res, next) => {
  try {
    const txs = await (prisma as any).bankTransaction.findMany({ where: { orgId: req.user.orgId }, take: 5000 });
    const accounts: Record<string, { debit: number; credit: number }> = {};

    for (const tx of txs) {
      const isIncome = Number(tx.amountTTC) > 0;
      const amt = Math.abs(Number(tx.amountTTC));
      const ht = tx.amountHT ? Math.abs(Number(tx.amountHT)) : amt;
      const vat = tx.vatAmount ? Math.abs(Number(tx.vatAmount)) : 0;
      const counterAccount = tx.accountingAccount ?? (isIncome ? "706000" : "606100");
      const vatAccount = isIncome ? "445710" : "445660";
      const add = (acc: string, d: number, c: number) => { accounts[acc] = accounts[acc] ?? { debit: 0, credit: 0 }; accounts[acc].debit += d; accounts[acc].credit += c; };
      if (isIncome) { add("512100", amt, 0); add(counterAccount, 0, ht); if (vat > 0) add(vatAccount, 0, vat); }
      else { add("512100", 0, amt); add(counterAccount, ht, 0); if (vat > 0) add(vatAccount, vat, 0); }
    }

    const totalDebit = Object.values(accounts).reduce((s, v) => s + v.debit, 0);
    const totalCredit = Object.values(accounts).reduce((s, v) => s + v.credit, 0);
    const rows = Object.entries(accounts).sort(([a], [b]) => a.localeCompare(b)).map(([num, v]) => ({
      compte: num, debitTotal: v.debit.toFixed(2), creditTotal: v.credit.toFixed(2), soldeDebiteur: v.debit > v.credit ? (v.debit - v.credit).toFixed(2) : "0.00", soldeCrediteur: v.credit > v.debit ? (v.credit - v.debit).toFixed(2) : "0.00",
    }));

    res.json({ data: { rows, totals: { debit: totalDebit.toFixed(2), credit: totalCredit.toFixed(2) } } });
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.get("/accounting/bilan", async (req, res, next) => {
  try {
    const txs = await (prisma as any).bankTransaction.findMany({ where: { orgId: req.user.orgId }, take: 5000 });
    let tresorerie = 0; let produits = 0; let charges = 0; let tvaDue = 0;
    for (const tx of txs) {
      const amt = Number(tx.amountTTC);
      const ht = tx.amountHT ? Number(tx.amountHT) : amt;
      const vat = tx.vatAmount ? Number(tx.vatAmount) : 0;
      tresorerie += amt;
      if (amt > 0) { produits += ht; tvaDue -= vat; }
      else { charges += Math.abs(ht); tvaDue += Math.abs(vat); }
    }
    const resultat = produits - charges;
    res.json({ data: {
      actif: { tresorerie: tresorerie.toFixed(2), total: tresorerie.toFixed(2) },
      passif: { capitalEtReserves: "0.00", resultat: resultat.toFixed(2), tvaADecaisser: tvaDue.toFixed(2), total: (resultat + tvaDue).toFixed(2) },
      equilibre: Math.abs(tresorerie - (resultat + tvaDue)) < 0.01,
    }});
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.get("/accounting/compte-resultat", async (req, res, next) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const where: Record<string, unknown> = { orgId: req.user.orgId };
    if (from || to) where["bookingDate"] = { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined };
    const txs = await (prisma as any).bankTransaction.findMany({ where, take: 5000 });
    let ca = 0; let achats = 0; let fraisGeneraux = 0;
    for (const tx of txs) {
      const ht = tx.amountHT ? Math.abs(Number(tx.amountHT)) : Math.abs(Number(tx.amountTTC));
      const acc = tx.accountingAccount ?? "";
      if (Number(tx.amountTTC) > 0) { ca += ht; }
      else if (acc.startsWith("60")) { achats += ht; }
      else { fraisGeneraux += ht; }
    }
    const resultat = ca - achats - fraisGeneraux;
    res.json({ data: { produits: { ca: ca.toFixed(2), total: ca.toFixed(2) }, charges: { achats: achats.toFixed(2), fraisGeneraux: fraisGeneraux.toFixed(2), total: (achats + fraisGeneraux).toFixed(2) }, resultatNet: resultat.toFixed(2) } });
  } catch (err) { next(err); }
});

accountingIntelligenceRouter.get("/accounting/ca3", async (req, res, next) => {
  try {
    const { period } = req.query as { period?: string };
    const txs = await (prisma as any).bankTransaction.findMany({ where: { orgId: req.user.orgId }, take: 5000 });
    let tvaCollectee = 0; let tvaDéductible = 0; let baseImposable20 = 0; let baseImposable10 = 0; let baseImposable55 = 0;
    for (const tx of txs) {
      const amt = Number(tx.amountTTC);
      const vat = tx.vatAmount ? Math.abs(Number(tx.vatAmount)) : 0;
      const ht = tx.amountHT ? Math.abs(Number(tx.amountHT)) : Math.abs(amt) - vat;
      if (amt > 0 && tx.vatType === "COLLECTED") { tvaCollectee += vat; baseImposable20 += ht; }
      if (amt < 0 && tx.vatType === "DEDUCTIBLE") { tvaDéductible += vat; }
    }
    res.json({ data: { period: period ?? "courant", baseImposable20: baseImposable20.toFixed(2), baseImposable10: baseImposable10.toFixed(2), baseImposable55: baseImposable55.toFixed(2), tvaCollectee: tvaCollectee.toFixed(2), tvaDeductible: tvaDéductible.toFixed(2), tvaDue: (tvaCollectee - tvaDéductible).toFixed(2), statut: "BROUILLON" } });
  } catch (err) { next(err); }
});

// ─── Export CSV transactions ──────────────────────────────────────────────────

accountingIntelligenceRouter.get("/exports/transactions.csv", async (req, res, next) => {
  try {
    const rows = await (prisma as any).bankTransaction.findMany({ where: { orgId: req.user.orgId }, orderBy: { bookingDate: "desc" } });
    const header = ["date", "libelle", "marchand", "ttc", "ht", "tva", "type_tva", "source_tva", "compte", "a_revoir"];
    const csv = [header.join(";"), ...rows.map((r: any) => [
      r.bookingDate.toISOString().slice(0, 10), r.labelRaw, r.merchantName ?? "", r.amountTTC, r.amountHT ?? "", r.vatAmount ?? "", r.vatType, r.vatSource ?? "", r.accountingAccount ?? "", r.vatNeedsReview ? "oui" : "non",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";"))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=transactions-comptables.csv");
    res.send(`﻿${csv}`);
  } catch (err) { next(err); }
});
