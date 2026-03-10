import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { encrypt, decrypt } from "../lib/security.js";
import { auditLog } from "../lib/audit.js";

const router = Router();
router.use(authenticate);

// ─── GET /api/urssaf/connection ───────────────────────────────────────────────
router.get("/connection", authorize("settings","read"), async (req, res, next) => {
  try {
    const conn = await prisma.urssafConnection.findUnique({
      where:  { orgId:req.user.orgId },
      select: { id:true, siret:true, isActive:true, authorizedAt:true,
        expiresAt:true, connectionType:true, createdAt:true },
        // tokenEncrypted jamais exposé
    });
    res.json({ data: conn });
  } catch(err){ next(err); }
});

// ─── POST /api/urssaf/connection ──────────────────────────────────────────────
router.post("/connection", authorize("settings","update"), async (req, res, next) => {
  try {
    const { siret, token, connectionType } = z.object({
      siret:          z.string().length(14),
      token:          z.string().min(1),
      connectionType: z.enum(["tierce_declaration_ae","simulation","attestation"]),
    }).parse(req.body);

    const conn = await prisma.urssafConnection.upsert({
      where:  { orgId:req.user.orgId },
      create: { orgId:req.user.orgId, siret, tokenEncrypted:encrypt(token), isActive:true,
        authorizedAt:new Date(), connectionType },
      update: { siret, tokenEncrypted:encrypt(token), isActive:true,
        authorizedAt:new Date(), connectionType },
      select: { id:true, siret:true, isActive:true, connectionType:true },
    });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"URSSAF_CONNECTED", ipAddress:req.ip });
    res.json({ data: conn });
  } catch(err){ next(err); }
});

// ─── GET /api/urssaf/simulate ─────────────────────────────────────────────────
// Simulation cotisations via API Mon Entreprise (publique, sans clé)
router.get("/simulate", authorize("reports","read"), async (req, res, next) => {
  try {
    const { revenue, activity, period } = z.object({
      revenue:  z.coerce.number().positive(),
      activity: z.enum(["bic","bnc","bic_vente"]).default("bnc"),
      period:   z.enum(["monthly","quarterly","annual"]).default("annual"),
    }).parse(req.query);

    // API Mon Entreprise — données publiques, sans authentification
    const apiRevenue = period === "monthly"   ? revenue * 12
                     : period === "quarterly" ? revenue * 4
                     : revenue;

    const url = `https://mon-entreprise.urssaf.fr/api/v1/evaluate` +
      `?expressions=auto-entrepreneur+.+cotisations` +
      `&situation=auto-entrepreneur+.+chiffre-d-affaires:${apiRevenue}` +
      `&situation=entreprise+.+activit%C3%A9:${activity}`;

    const response = await fetch(url, {
      headers: { "Accept": "application/json" },
    });

    let result: any;
    if (response.ok) {
      result = await response.json();
    } else {
      // Fallback: calcul local approximatif AE si l'API est indisponible
      const rates: Record<string,number> = { bnc:21.1, bic:12.3, bic_vente:6.4 };
      const rate  = rates[activity] || 21.1;
      const cotisations = apiRevenue * rate / 100;
      result = {
        fallback: true,
        cotisations: Math.round(cotisations * 100) / 100,
        net:         Math.round((apiRevenue - cotisations) * 100) / 100,
        rate,
      };
    }

    // Sauvegarder la simulation
    await prisma.urssafSimulation.create({ data:{
      orgId:      req.user.orgId,
      inputParams:{ revenue, activity, period },
      result,
    }});

    res.json({ data: result });
  } catch(err){ next(err); }
});

// ─── GET /api/urssaf/declarations ────────────────────────────────────────────
router.get("/declarations", authorize("reports","read"), async (req, res, next) => {
  try {
    const conn = await prisma.urssafConnection.findUnique({ where:{ orgId:req.user.orgId } });
    if (!conn) throw new Error("Aucune connexion URSSAF configurée.");

    const declarations = await prisma.urssafDeclaration.findMany({
      where:   { connectionId:conn.id },
      orderBy: { createdAt:"desc" },
    });
    res.json({ data: declarations });
  } catch(err){ next(err); }
});

// ─── POST /api/urssaf/declarations ───────────────────────────────────────────
// Créer une déclaration CA (tierce déclaration AE)
router.post("/declarations", authorize("reports","read"), async (req, res, next) => {
  try {
    const conn = await prisma.urssafConnection.findUnique({ where:{ orgId:req.user.orgId } });
    if (!conn || !conn.isActive) throw new Error("Connexion URSSAF non active.");

    const { period, periodType, revenue } = z.object({
      period:     z.string().regex(/^\d{4}-(T[1-4]|\d{2})$/),
      periodType: z.enum(["quarterly","monthly"]),
      revenue:    z.number().min(0),
    }).parse(req.body);

    // Vérifier si une déclaration existe déjà pour cette période
    const existing = await prisma.urssafDeclaration.findFirst({
      where: { connectionId:conn.id, period },
    });
    if (existing) throw new Error(`Une déclaration existe déjà pour la période ${period}.`);

    const declaration = await prisma.urssafDeclaration.create({ data:{
      connectionId: conn.id, orgId:req.user.orgId,
      period, periodType, revenue, status:"DRAFT",
    }});

    res.status(201).json({ data: declaration });
  } catch(err){ next(err); }
});

// ─── POST /api/urssaf/declarations/:id/submit ─────────────────────────────────
router.post("/declarations/:id/submit", authorize("reports","read"), async (req, res, next) => {
  try {
    const decl = await prisma.urssafDeclaration.findUnique({ where:{ id:req.params.id } });
    if (!decl || decl.orgId !== req.user.orgId) throw new Error("Déclaration introuvable.");
    if (decl.status !== "DRAFT") throw new Error("Cette déclaration a déjà été soumise.");

    const conn = await prisma.urssafConnection.findUnique({ where:{ id:decl.connectionId } });
    if (!conn?.tokenEncrypted) throw new Error("Token URSSAF manquant.");

    // TODO: Appel API tierce déclaration URSSAF avec le token déchiffré
    // const token = decrypt(conn.tokenEncrypted);
    // const urssafResponse = await urssafApi.submit(token, decl);

    const updated = await prisma.urssafDeclaration.update({ where:{ id:req.params.id }, data:{
      status:"SUBMITTED", submittedAt:new Date(),
    }});

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"URSSAF_DECLARATION_SUBMITTED",
      resource:"urssafDeclaration", resourceId:decl.id, detail:`Période: ${decl.period}`, ipAddress:req.ip });

    res.json({ data: updated });
  } catch(err){ next(err); }
});

export { router as urssafRouter };
