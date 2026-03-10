import { prisma } from "./prisma.js";
import crypto from "crypto";

const HMAC_SECRET = process.env.AUDIT_HMAC_SECRET || "CHANGE_IN_PRODUCTION";

// ─── AUDIT LOG signé HMAC-SHA256 ─────────────────────────────────────────────
// Chaque entrée est signée pour détecter toute falsification ultérieure

export async function auditLog(params: {
  userId?:    string;
  orgId?:     string;
  action:     string;
  resource?:  string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  detail?:    string;
}) {
  try {
    // Calcul HMAC sur les données sensibles
    const payload = JSON.stringify({
      userId:     params.userId,
      orgId:      params.orgId,
      action:     params.action,
      resourceId: params.resourceId,
      ts:         Date.now(),
    });
    const hmac = crypto
      .createHmac("sha256", HMAC_SECRET)
      .update(payload)
      .digest("hex");

    await prisma.auditLog.create({
      data: { ...params, hmac },
    });
  } catch {
    // Non bloquant — le log d'audit ne doit jamais faire échouer une opération métier
  }
}
