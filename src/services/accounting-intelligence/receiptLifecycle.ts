import fs from "fs";
import path from "path";
import crypto from "crypto";
import { prisma } from "../../lib/prisma.js";
import { deleteLocalFile } from "../../middleware/uploadHandler.js";
import { normalizeText } from "./normalization.js";
import { suggestVatQualification } from "./vatEngine.js";
import { extractReceiptData } from "./ocrService.js";

type ReceiptLifecycleInput = {
  orgId: string;
  userId: string;
  transactionId: string;
  files: Express.Multer.File[];
  notes?: string;
};

async function createReceiptDocument(input: ReceiptLifecycleInput, tx: any) {
  const hash = crypto.createHash("sha256");
  for (const file of input.files) hash.update(fs.readFileSync(file.path));
  const checksum = hash.digest("hex");

  // Version MVP robuste : si plusieurs pages sont envoyées, on les garde dans metadata.pages.
  // Étape suivante prod : fusion côté backend en PDF unique avec pdf-lib/sharp.
  const primaryFile = input.files[0];
  const document = await prisma.document.create({
    data: {
      orgId: input.orgId,
      name: primaryFile.filename,
      originalName: input.files.length > 1 ? `justificatif-${tx.id}-${input.files.length}-pages` : primaryFile.originalname,
      mimeType: input.files.length > 1 ? "application/pdf" : primaryFile.mimetype,
      size: input.files.reduce((sum, f) => sum + f.size, 0),
      storagePath: primaryFile.path,
      url: `/uploads/${path.basename(primaryFile.path)}`,
      checksum,
      category: "invoice_scan",
      tags: ["receipt", "invoice", "scan", input.files.length > 1 ? "multi_page" : "single_page"],
      uploadedById: input.userId,
    },
  });

  return {
    document,
    documentMetadata: {
      scanMode: input.files.length > 1 ? "MULTI_PAGE" : "SINGLE_PAGE",
      pageCount: input.files.length,
      pages: input.files.map((file, index) => ({
        index: index + 1,
        filename: file.filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        storagePath: file.path,
        url: `/uploads/${path.basename(file.path)}`,
      })),
      notes: input.notes,
      lifecycle: "ACTIVE",
    },
  };
}

async function clearReceiptData(params: { orgId: string; transactionId: string; hardDeleteFile?: boolean }) {
  const tx = await (prisma as any).bankTransaction.findFirstOrThrow({
    where: { id: params.transactionId, orgId: params.orgId },
    include: { document: true, matchedInvoice: { include: { vatLines: true } } },
  });

  if (tx.matchedInvoiceId) {
    await (prisma as any).extractedInvoice.deleteMany({ where: { id: tx.matchedInvoiceId, orgId: params.orgId } });
  }

  if (tx.documentId) {
    await prisma.document.updateMany({
      where: { id: tx.documentId, orgId: params.orgId },
      data: { deletedAt: new Date(), tags: ["receipt", "deleted"] },
    });
    if (params.hardDeleteFile && tx.document?.storagePath) deleteLocalFile(tx.document.storagePath);
    const pages = (tx.metadata as any)?.receipt?.pages ?? [];
    if (params.hardDeleteFile) pages.forEach((p: any) => p.storagePath && deleteLocalFile(p.storagePath));
  }

  const shouldResetVat = ["INVOICE_OCR", "AI_SUGGESTED"].includes(String(tx.vatSource ?? ""));
  return (prisma as any).bankTransaction.update({
    where: { id: tx.id },
    data: {
      documentId: null,
      matchedInvoiceId: null,
      ...(shouldResetVat ? {
        amountHT: null,
        vatAmount: null,
        vatType: "UNKNOWN",
        vatSource: null,
        vatConfidence: 0,
        vatNeedsReview: true,
        deductiblePercentage: null,
        accountingAccount: null,
      } : { vatNeedsReview: true }),
      metadata: {
        ...(typeof tx.metadata === "object" && tx.metadata ? tx.metadata : {}),
        receipt: null,
        receiptDeletedAt: new Date().toISOString(),
      },
    },
  });
}

export async function attachReceiptToTransaction(input: ReceiptLifecycleInput) {
  const tx = await (prisma as any).bankTransaction.findFirstOrThrow({ where: { id: input.transactionId, orgId: input.orgId } });
  if (tx.documentId || tx.matchedInvoiceId) await clearReceiptData({ orgId: input.orgId, transactionId: input.transactionId });

  const { document, documentMetadata } = await createReceiptDocument(input, tx);

  // Run OCR on all pages, merge text
  const ocrResults = await Promise.all(
    input.files.map((f) => {
      const buf = fs.readFileSync(f.path);
      return extractReceiptData(buf, f.mimetype);
    })
  );
  const bestOcr = ocrResults.reduce((best, r) => r.confidence > best.confidence ? r : best, ocrResults[0]);
  const mergedText = ocrResults.map((r) => r.rawText).join("\n");

  const extracted = {
    supplierName: bestOcr.supplierName ?? (normalizeText(input.files[0].originalname).split(" ").slice(0, 3).join(" ") || "Fournisseur à confirmer"),
    invoiceNumber: bestOcr.invoiceNumber,
    invoiceDate: bestOcr.invoiceDate,
    totalHT: bestOcr.totalHT ?? null,
    totalVat: bestOcr.totalVat ?? null,
    totalTTC: bestOcr.totalTTC ?? null,
    rawText: mergedText || `OCR_PENDING ${input.files.map((f) => f.originalname).join(" ")}`,
    confidence: bestOcr.confidence,
    vatLines: bestOcr.vatLines,
  };

  const totalTTC = extracted.totalTTC ?? Math.abs(Number(tx.amountTTC));

  const suggestion = await suggestVatQualification({
    orgId: input.orgId,
    merchantName: extracted.supplierName || tx.merchantName,
    label: tx.labelRaw,
    amountTTC: Number(tx.amountTTC),
    vatAmountImported: extracted.totalVat ?? undefined,
    operationType: tx.type,
  });

  const invoice = await (prisma as any).extractedInvoice.create({
    data: {
      orgId: input.orgId,
      documentId: document.id,
      supplierName: extracted.supplierName,
      invoiceNumber: extracted.invoiceNumber,
      invoiceDate: extracted.invoiceDate,
      totalHT: extracted.totalHT as any,
      totalVat: extracted.totalVat as any,
      totalTTC: totalTTC as any,
      extractionConfidence: extracted.confidence as any,
      needsReview: true,
      rawText: extracted.rawText,
      metadata: { source: "receipt_scan", ...documentMetadata },
      vatLines: extracted.vatLines.length ? { create: extracted.vatLines.map((line) => ({
        vatRate: line.vatRate as any,
        amountHT: line.amountHT as any,
        vatAmount: line.vatAmount as any,
        amountTTC: line.amountTTC as any,
        vatType: suggestion.vatType as any,
        confidenceScore: extracted.confidence as any,
        deductiblePercentage: suggestion.deductiblePercentage as any,
        accountingVatAccount: suggestion.accountingAccount,
        reason: suggestion.reason,
      })) } : undefined,
    },
  });

  const updatedTx = await (prisma as any).bankTransaction.update({
    where: { id: tx.id },
    data: {
      documentId: document.id,
      matchedInvoiceId: invoice.id,
      amountHT: extracted.totalHT as any,
      vatAmount: extracted.totalVat as any,
      vatType: suggestion.vatType as any,
      vatSource: "INVOICE_OCR",
      vatConfidence: Math.max(extracted.confidence, suggestion.confidenceScore) as any,
      vatNeedsReview: true,
      accountingAccount: suggestion.accountingAccount,
      deductiblePercentage: suggestion.deductiblePercentage as any,
      metadata: { ...(typeof tx.metadata === "object" && tx.metadata ? tx.metadata : {}), receipt: { documentId: document.id, invoiceId: invoice.id, ...documentMetadata, status: "ATTACHED_NEEDS_REVIEW", ocrConfidence: extracted.confidence, documentType: bestOcr.documentType } },
    },
  });

  return { transaction: updatedTx, document, invoice };
}

export async function replaceReceiptOnTransaction(input: ReceiptLifecycleInput) {
  await clearReceiptData({ orgId: input.orgId, transactionId: input.transactionId });
  return attachReceiptToTransaction(input);
}

export async function deleteReceiptFromTransaction(params: { orgId: string; transactionId: string; hardDeleteFile?: boolean }) {
  const transaction = await clearReceiptData(params);
  return { transaction };
}
