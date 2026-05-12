import { Router } from "express";
import fs from "fs";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { deleteLocalFile, uploadMultiple, uploadSingle } from "../middleware/uploadHandler.js";
import { parseCsv } from "../services/accounting-intelligence/csvParser.js";
import { normalizeText, parseFrenchDate, parseMoney } from "../services/accounting-intelligence/normalization.js";
import { suggestVatQualification, reinforceVatLearningRule } from "../services/accounting-intelligence/vatEngine.js";
import { suggestActivityProfile } from "../services/accounting-intelligence/activityEngine.js";
import { attachReceiptToTransaction, deleteReceiptFromTransaction, replaceReceiptOnTransaction } from "../services/accounting-intelligence/receiptLifecycle.js";

export const accountingIntelligenceRouter = Router();
accountingIntelligenceRouter.use(authenticate);

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

accountingIntelligenceRouter.get("/learning-rules", async (req, res, next) => {
  try {
    const rules = await (prisma as any).vatLearningRule.findMany({ where: { orgId: req.user.orgId }, orderBy: [{ appliesAutomatically: "desc" }, { confidenceScore: "desc" }] });
    res.json({ data: rules });
  } catch (err) { next(err); }
});

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
