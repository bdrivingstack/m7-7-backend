import crypto from "crypto";

// ─── CHIFFREMENT AES-256-GCM (pour stocker des secrets sensibles en DB) ──────
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "0".repeat(64);
const KEY = Buffer.from(ENCRYPTION_KEY, "hex").slice(0, 32);

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(payload: string): string {
  const [ivHex, tagHex, encryptedHex] = payload.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

// ─── GÉNÉRATION DE TOKENS SÉCURISÉS ─────────────────────────────────────────
export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

// ─── SANITISATION des inputs (protection XSS basique) ────────────────────────
export function sanitizeString(input: string): string {
  return input
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;")
    .trim();
}
