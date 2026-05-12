export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(CB|CARTE|PAIEMENT|VIR|VIREMENT|PRELEVEMENT|PRLV|SEPA|FACTURE|REF|REFERENCE)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildLearningKey(params: {
  orgActivity?: string | null;
  merchantName?: string | null;
  itemName?: string | null;
  label?: string | null;
}) {
  return normalizeText([
    params.orgActivity ?? "ACTIVITY_UNKNOWN",
    params.merchantName ?? params.label ?? "MERCHANT_UNKNOWN",
    params.itemName ?? "ITEM_UNKNOWN",
  ].join("|"));
}

export function parseMoney(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  const raw = String(input)
    .replace(/ /g, "")
    .replace(/\s/g, "")
    .replace(/€/g, "")
    .replace(/,/g, ".")
    .replace(/[^0-9+.-]/g, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseFrenchDate(input: unknown): Date | null {
  if (!input) return null;
  const raw = String(input).trim();
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return new Date(iso);
  const match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  const year = y.length === 2 ? `20${y}` : y;
  const date = new Date(`${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
