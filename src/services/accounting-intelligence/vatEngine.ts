import { prisma } from "../../lib/prisma.js";
import { buildLearningKey, normalizeText } from "./normalization.js";

type VatSuggestion = {
  vatType: "DEDUCTIBLE" | "NON_DEDUCTIBLE" | "COLLECTED" | "REVERSE_CHARGE" | "EXEMPT" | "MIXED" | "UNKNOWN";
  vatRate?: number;
  confidenceScore: number;
  source: "INTERNAL_RULE" | "AI_SUGGESTION" | "BANK_FILE" | "INVOICE_OCR" | "MANUAL";
  reason: string;
  needsReview: boolean;
  accountingAccount?: string;
  deductiblePercentage?: number;
};

const merchantRules: Array<{ pattern: RegExp; vatType: VatSuggestion["vatType"]; rate?: number; account?: string; reason: string; confidence: number; deductiblePercentage?: number }> = [
  { pattern: /URSSAF|DGFIP|IMPOT|TRESOR PUBLIC/, vatType: "EXEMPT", rate: 0, account: "645", reason: "Organisme public/social : généralement hors champ TVA.", confidence: 0.86 },
  { pattern: /GOOGLE|META|FACEBOOK|AWS|AMAZON WEB SERVICES|MICROSOFT IRELAND/, vatType: "REVERSE_CHARGE", rate: 20, account: "651", reason: "Fournisseur numérique UE/étranger : autoliquidation probable à vérifier.", confidence: 0.72 },
  { pattern: /SNCF|RATP|TRANSPORT/, vatType: "DEDUCTIBLE", rate: 10, account: "6251", reason: "Transport professionnel : taux souvent réduit, justificatif obligatoire.", confidence: 0.66 },
  { pattern: /MCDONALD|MC DONALD|BURGER KING|KFC|RESTAURANT|BOULANGERIE/, vatType: "NON_DEDUCTIBLE", rate: 10, account: "6256", reason: "Restauration : TVA souvent à qualifier selon contexte professionnel, par défaut validation requise.", confidence: 0.58 },
  { pattern: /TOTAL|ESSO|SHELL|BP|CARBURANT/, vatType: "MIXED", rate: 20, account: "6061", reason: "Carburant/véhicule : déductibilité variable selon carburant, véhicule et usage.", confidence: 0.55, deductiblePercentage: 80 },
];

export async function suggestVatQualification(input: {
  orgId: string;
  activityLabel?: string | null;
  merchantName?: string | null;
  itemName?: string | null;
  label?: string | null;
  amountTTC?: number | null;
  vatRateImported?: number | null;
  vatAmountImported?: number | null;
  operationType?: "INCOME" | "EXPENSE" | "TRANSFER" | "UNKNOWN";
}): Promise<VatSuggestion> {
  const normalizedLabel = normalizeText(`${input.merchantName ?? ""} ${input.itemName ?? ""} ${input.label ?? ""}`);
  const key = buildLearningKey({ orgActivity: input.activityLabel, merchantName: input.merchantName, itemName: input.itemName, label: input.label });

  const learned = await (prisma as any).vatLearningRule.findFirst({
    where: { orgId: input.orgId, normalizedKey: key, appliesAutomatically: true },
    orderBy: [{ confidenceScore: "desc" }, { confirmationsCount: "desc" }],
  });

  if (learned) {
    return {
      vatType: learned.vatType as VatSuggestion["vatType"],
      vatRate: learned.vatRate ? Number(learned.vatRate) : undefined,
      confidenceScore: Number(learned.confidenceScore),
      source: "INTERNAL_RULE",
      reason: `Règle interne validée ${learned.confirmationsCount} fois pour ce fournisseur/article et cette activité.`,
      needsReview: Number(learned.confidenceScore) < 0.9,
      accountingAccount: learned.accountingAccount ?? undefined,
      deductiblePercentage: learned.deductiblePercentage ? Number(learned.deductiblePercentage) : undefined,
    };
  }

  if (input.operationType === "INCOME") {
    return { vatType: "COLLECTED", vatRate: input.vatRateImported ?? 20, confidenceScore: 0.7, source: "AI_SUGGESTION", reason: "Entrée d'argent : vente/encaissement probable, TVA collectée à confirmer.", needsReview: true, accountingAccount: "44571" };
  }

  for (const rule of merchantRules) {
    if (rule.pattern.test(normalizedLabel)) {
      return { vatType: rule.vatType, vatRate: input.vatRateImported ?? rule.rate, confidenceScore: rule.confidence, source: "AI_SUGGESTION", reason: rule.reason, needsReview: true, accountingAccount: rule.account, deductiblePercentage: rule.deductiblePercentage };
    }
  }

  if (input.vatAmountImported !== null && input.vatAmountImported !== undefined) {
    return { vatType: "DEDUCTIBLE", vatRate: input.vatRateImported ?? undefined, confidenceScore: 0.78, source: "BANK_FILE", reason: "TVA présente dans le fichier importé : elle est reprise mais doit être validée selon le contexte.", needsReview: true, accountingAccount: "44566" };
  }

  return { vatType: "UNKNOWN", confidenceScore: 0.25, source: "AI_SUGGESTION", reason: "Aucune règle fiable trouvée : validation utilisateur nécessaire.", needsReview: true };
}

export async function reinforceVatLearningRule(input: {
  orgId: string;
  userId: string;
  activityLabel?: string | null;
  merchantName?: string | null;
  itemName?: string | null;
  label?: string | null;
  vatType: VatSuggestion["vatType"];
  vatRate?: number | null;
  accountingAccount?: string | null;
  deductiblePercentage?: number | null;
}) {
  const normalizedKey = buildLearningKey({ orgActivity: input.activityLabel, merchantName: input.merchantName, itemName: input.itemName, label: input.label });
  const existing = await (prisma as any).vatLearningRule.findUnique({
    where: { orgId_normalizedKey_vatType: { orgId: input.orgId, normalizedKey, vatType: input.vatType as any } },
  });

  if (!existing) {
    return (prisma as any).vatLearningRule.create({ data: {
      orgId: input.orgId,
      merchantName: input.merchantName ?? input.label ?? "Inconnu",
      itemName: input.itemName,
      normalizedKey,
      vatType: input.vatType as any,
      vatRate: input.vatRate as any,
      accountingAccount: input.accountingAccount ?? undefined,
      deductiblePercentage: input.deductiblePercentage as any,
      confirmationsCount: 1,
      confidenceScore: 0.45 as any,
      appliesAutomatically: false,
      validatedByUserId: input.userId,
    }});
  }

  const confirmations = existing.confirmationsCount + 1;
  const confidence = Math.min(0.98, Number(existing.confidenceScore) + 0.1);
  return (prisma as any).vatLearningRule.update({ where: { id: existing.id }, data: {
    confirmationsCount: confirmations,
    confidenceScore: confidence as any,
    appliesAutomatically: confirmations >= 5 && confidence >= 0.85,
    lastConfirmedAt: new Date(),
    validatedByUserId: input.userId,
  }});
}
