import { prisma } from "../../lib/prisma.js";
import { normalizeText } from "./normalization.js";

const FALLBACK_NAF: Record<string, { label: string; keywords: string[]; naceCode: string }> = {
  "6201Z": { label: "Programmation informatique", keywords: ["logiciel", "saas", "application", "développement"], naceCode: "62.01" },
  "6202A": { label: "Conseil en systèmes et logiciels informatiques", keywords: ["conseil", "informatique", "digital"], naceCode: "62.02" },
  "4932Z": { label: "Transports de voyageurs par taxis", keywords: ["vtc", "transport", "chauffeur"], naceCode: "49.32" },
  "7022Z": { label: "Conseil pour les affaires et autres conseils de gestion", keywords: ["conseil", "business", "gestion"], naceCode: "70.22" },
  "5610C": { label: "Restauration de type rapide", keywords: ["restaurant", "snack", "fast food"], naceCode: "56.10" },
};

export async function suggestActivityProfile(input: { orgId: string; nafCode?: string | null; objectSocial?: string | null }) {
  const naf = input.nafCode?.replace(/[^0-9A-Za-z]/g, "").toUpperCase() ?? null;
  const found = naf ? await (prisma as any).activityNomenclature.findFirst({ where: { country: "FR", system: { startsWith: "NAF" }, code: naf } }) : null;
  const fallback = naf ? FALLBACK_NAF[naf] : undefined;
  const label = found?.label ?? fallback?.label ?? "Activité à confirmer";
  const objectScore = input.objectSocial ? Math.min(0.2, normalizeText(input.objectSocial).length / 1000) : 0;
  const confidence = found || fallback ? 0.72 + objectScore : 0.35;

  return (prisma as any).orgActivityProfile.upsert({
    where: { id: `${input.orgId}:primary` },
    create: {
      id: `${input.orgId}:primary`,
      orgId: input.orgId,
      nafCode: naf,
      naceCode: found?.metadata && typeof found.metadata === "object" ? (found.metadata as any).naceCode : fallback?.naceCode,
      activityLabel: label,
      objectSocial: input.objectSocial,
      confidenceScore: confidence as any,
      status: "SUGGESTED",
      sources: { nafCode: naf, source: found ? "ActivityNomenclature" : fallback ? "fallback" : "manual_required" },
    },
    update: {
      nafCode: naf,
      activityLabel: label,
      objectSocial: input.objectSocial,
      confidenceScore: confidence as any,
      status: "SUGGESTED",
    },
  });
}
