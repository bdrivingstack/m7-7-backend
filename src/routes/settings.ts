import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { encrypt, decrypt } from "../lib/security.js";
import { auditLog } from "../lib/audit.js";
import crypto from "crypto";
import nodemailer from "nodemailer";

const router = Router();
router.use(authenticate);

const OrgSchema = z.object({
  name:               z.string().min(1).max(200).trim(),
  legalName:          z.string().max(200).optional(),
  siret:              z.string().max(14).optional(),
  siren:              z.string().max(9).optional(),
  tvaNumber:          z.string().max(20).optional(),
  nafCode:            z.string().max(10).optional(),
  legalForm:          z.string().max(100).optional(),
  address:            z.string().max(200).optional(),
  city:               z.string().max(100).optional(),
  postalCode:         z.string().max(10).optional(),
  country:            z.string().length(2).default("FR"),
  phone:              z.string().max(20).optional(),
  website:            z.string().url().optional().or(z.literal("")),
  email:              z.string().email().optional().or(z.literal("")),
  isMicroEnterprise:  z.boolean().optional(),
  isVatSubject:       z.boolean().optional(),
  defaultVatRate:     z.number().min(0).max(100).optional(),
  defaultPaymentTerms:z.number().int().min(0).max(365).optional(),
  defaultLatePenalty: z.string().max(200).optional(),
  billingEmail:       z.string().email().optional().or(z.literal("")),
});

const NumberingSchema = z.object({
  invoicePrefix:    z.string().min(1).max(20).regex(/^[A-Z0-9\-_]+$/),
  quotePrefix:      z.string().min(1).max(20).regex(/^[A-Z0-9\-_]+$/),
  creditNotePrefix: z.string().min(1).max(20).regex(/^[A-Z0-9\-_]+$/),
  invoiceCounter:   z.number().int().min(0).optional(),
  quoteCounter:     z.number().int().min(0).optional(),
});

const BrandingSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  fontFamily:   z.string().max(100).optional(),
  logoUrl:      z.string().url().optional().or(z.literal("")),
});

const EInvoicingSchema = z.object({
  einvoicingEnabled: z.boolean(),
  pdpProvider:       z.string().max(100).optional(),
  pdpApiKey:         z.string().max(500).optional(), // Sera chiffré AES-256 avant stockage
});

const WebhookSchema = z.object({
  url:    z.string().url(),
  events: z.array(z.string()).min(1).max(50),
});

const IntegrationSchema = z.object({
  type:       z.enum(["STRIPE","QONTO","CHORUS_PRO","PENNYLANE","SAGE","CEGID","YOOZ","URSSAF","CUSTOM"]),
  name:       z.string().max(100),
  configJson: z.record(z.unknown()).optional(),
  credential: z.string().max(2000).optional(), // Sera chiffré AES-256
});

// ─── GET /api/settings/org ────────────────────────────────────────────────────
router.get("/org", async (req, res, next) => {
  try {
    const org = await prisma.org.findUnique({
      where:  { id: req.user.orgId },
      select: { id:true, name:true, legalName:true, siret:true, siren:true,
        tvaNumber:true, nafCode:true, legalForm:true, address:true, city:true,
        postalCode:true, country:true, phone:true, website:true, email:true,
        isMicroEnterprise:true, isVatSubject:true, defaultVatRate:true,
        defaultPaymentTerms:true, defaultLatePenalty:true, plan:true,
        trialEnds:true, billingEmail:true, primaryColor:true, fontFamily:true,
        logoUrl:true, invoicePrefix:true, quotePrefix:true, creditNotePrefix:true,
        invoiceCounter:true, quoteCounter:true, creditNoteCounter:true,
        einvoicingEnabled:true, pdpProvider:true },
    });
    res.json({ data: org });
  } catch(err){ next(err); }
});

// ─── PATCH /api/settings/org ──────────────────────────────────────────────────
router.patch("/org", authorize("settings","update"), async (req, res, next) => {
  try {
    const body = OrgSchema.partial().parse(req.body);
    const org  = await prisma.org.update({ where:{ id:req.user.orgId }, data:body,
      select:{ id:true, name:true, updatedAt:true } });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"ORG_SETTINGS_UPDATED", ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ data: org });
  } catch(err){ next(err); }
});

// ─── PATCH /api/settings/numbering ───────────────────────────────────────────
router.patch("/numbering", authorize("settings","update"), async (req, res, next) => {
  try {
    const body = NumberingSchema.parse(req.body);
    const org  = await prisma.org.update({ where:{ id:req.user.orgId }, data:body });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"NUMBERING_UPDATED", ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ data: { invoicePrefix:org.invoicePrefix, quotePrefix:org.quotePrefix,
      creditNotePrefix:org.creditNotePrefix, invoiceCounter:org.invoiceCounter } });
  } catch(err){ next(err); }
});

// ─── PATCH /api/settings/branding ────────────────────────────────────────────
router.patch("/branding", authorize("settings","update"), async (req, res, next) => {
  try {
    const body = BrandingSchema.parse(req.body);
    await prisma.org.update({ where:{ id:req.user.orgId }, data:body });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"BRANDING_UPDATED", ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ success: true });
  } catch(err){ next(err); }
});

// ─── PATCH /api/settings/einvoicing ──────────────────────────────────────────
router.patch("/einvoicing", authorize("settings","update"), async (req, res, next) => {
  try {
    const body = EInvoicingSchema.parse(req.body);

    const updateData: any = {
      einvoicingEnabled: body.einvoicingEnabled,
      pdpProvider:       body.pdpProvider,
    };

    // Chiffrement AES-256 de la clé API PDP — jamais en clair en base
    if (body.pdpApiKey) {
      updateData.pdpApiKeyEncrypted = encrypt(body.pdpApiKey);
    }

    await prisma.org.update({ where:{ id:req.user.orgId }, data:updateData });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"EINVOICING_SETTINGS_UPDATED", ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ success: true });
  } catch(err){ next(err); }
});

// ─── GET /api/settings/integrations ──────────────────────────────────────────
router.get("/integrations", authorize("settings","read"), async (req, res, next) => {
  try {
    const integrations = await prisma.integration.findMany({
      where:  { orgId:req.user.orgId },
      select: { id:true, type:true, name:true, isActive:true, configJson:true,
        lastSyncAt:true, lastSyncStatus:true, createdAt:true },
        // credentialEncrypted jamais exposé en GET
    });
    res.json({ data: integrations });
  } catch(err){ next(err); }
});

// ─── POST /api/settings/integrations ─────────────────────────────────────────
router.post("/integrations", authorize("settings","update"), async (req, res, next) => {
  try {
    const body = IntegrationSchema.parse(req.body);
    const updateData: any = {
      orgId:      req.user.orgId,
      type:       body.type,
      name:       body.name,
      configJson: body.configJson,
      isActive:   true,
    };
    if (body.credential) {
      updateData.credentialEncrypted = encrypt(body.credential);
    }
    const integration = await prisma.integration.upsert({
      where:  { orgId_type: { orgId:req.user.orgId, type:body.type } },
      create: updateData,
      update: updateData,
    });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"INTEGRATION_UPDATED",
      resource:"integration", resourceId:integration.id, detail:body.type, ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ data:{ id:integration.id, type:integration.type, isActive:integration.isActive } });
  } catch(err){ next(err); }
});

// ─── DELETE /api/settings/integrations/:id ────────────────────────────────────
router.delete("/integrations/:id", authorize("settings","update"), async (req, res, next) => {
  try {
    const integration = await prisma.integration.findUnique({ where:{ id:req.params.id } });
    if (!integration || integration.orgId !== req.user.orgId) throw new Error("Introuvable.");
    await prisma.integration.delete({ where:{ id:req.params.id } });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"INTEGRATION_DELETED",
      resource:"integration", resourceId:req.params.id, ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ success: true });
  } catch(err){ next(err); }
});

// ─── GET /api/settings/webhooks ───────────────────────────────────────────────
router.get("/webhooks", authorize("settings","read"), async (req, res, next) => {
  try {
    const webhooks = await prisma.webhook.findMany({ where:{ orgId:req.user.orgId },
      select:{ id:true, url:true, events:true, isActive:true, createdAt:true } });
    res.json({ data: webhooks });
  } catch(err){ next(err); }
});

// ─── POST /api/settings/webhooks ──────────────────────────────────────────────
router.post("/webhooks", authorize("settings","update"), async (req, res, next) => {
  try {
    const body   = WebhookSchema.parse(req.body);
    const secret = crypto.randomBytes(32).toString("hex"); // HMAC secret
    const webhook = await prisma.webhook.create({ data:{
      orgId:  req.user.orgId,
      url:    body.url,
      events: body.events,
      secret,
    }});
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"WEBHOOK_CREATED",
      resource:"webhook", resourceId:webhook.id, detail:body.url, ipAddress:req.ip, userAgent:req.get("User-Agent") });
    // Renvoyer le secret UNE SEULE FOIS — ne sera plus accessible ensuite
    res.status(201).json({ data:{ id:webhook.id, url:webhook.url, events:webhook.events, secret } });
  } catch(err){ next(err); }
});

// ─── DELETE /api/settings/webhooks/:id ────────────────────────────────────────
router.delete("/webhooks/:id", authorize("settings","update"), async (req, res, next) => {
  try {
    const webhook = await prisma.webhook.findUnique({ where:{ id:req.params.id } });
    if (!webhook || webhook.orgId !== req.user.orgId) throw new Error("Introuvable.");
    await prisma.webhook.delete({ where:{ id:req.params.id } });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"WEBHOOK_DELETED",
      resource:"webhook", resourceId:req.params.id, ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ success: true });
  } catch(err){ next(err); }
});

// ─── GET /api/settings/email ─────────────────────────────────────────────────
router.get("/email", authorize("settings","read"), async (req, res, next) => {
  try {
    const integration = await prisma.integration.findFirst({
      where: { orgId: req.user.orgId, type: "CUSTOM" },
      select: { id:true, configJson:true, isActive:true, updatedAt:true },
    });
    if (!integration) {
      return res.json({ data: null });
    }
    res.json({ data: {
      id:        integration.id,
      isActive:  integration.isActive,
      updatedAt: integration.updatedAt,
      ...(integration.configJson as object ?? {}),
    }});
  } catch(err){ next(err); }
});

// ─── PATCH /api/settings/email ────────────────────────────────────────────────
const SmtpConfigSchema = z.object({
  senderName:  z.string().max(200).optional(),
  senderEmail: z.string().email().optional().or(z.literal("")),
  replyTo:     z.string().email().optional().or(z.literal("")),
  smtpEnabled: z.boolean().optional(),
  smtpHost:    z.string().max(200).optional(),
  smtpPort:    z.number().int().min(1).max(65535).optional(),
  smtpSecurity:z.enum(["STARTTLS","TLS","NONE"]).optional(),
  smtpUser:    z.string().max(200).optional(),
  smtpPass:    z.string().max(1000).optional(),
  signature:   z.string().max(2000).optional(),
  notifSendCopy:    z.boolean().optional(),
  notifPaymentAlert: z.boolean().optional(),
  notifWeeklySummary:z.boolean().optional(),
});

router.patch("/email", authorize("settings","update"), async (req, res, next) => {
  try {
    const body = SmtpConfigSchema.parse(req.body);
    const { smtpPass, ...rest } = body;
    const configJson: Record<string, unknown> = { ...rest };

    // One CUSTOM integration per org (unique constraint on orgId+type)
    const existing = await prisma.integration.findFirst({
      where: { orgId: req.user.orgId, type: "CUSTOM" },
      select: { id: true },
    });

    if (existing) {
      const updateData: any = { name: "smtp_config", configJson, isActive: true };
      if (smtpPass) updateData.credentialEncrypted = encrypt(smtpPass);
      await prisma.integration.update({ where: { id: existing.id }, data: updateData });
    } else {
      const createData: any = {
        orgId: req.user.orgId, type: "CUSTOM", name: "smtp_config",
        isActive: true, configJson,
      };
      if (smtpPass) createData.credentialEncrypted = encrypt(smtpPass);
      await prisma.integration.create({ data: createData });
    }

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"EMAIL_SETTINGS_UPDATED", ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ success: true });
  } catch(err){ next(err); }
});

// ─── POST /api/settings/email/test ────────────────────────────────────────────
router.post("/email/test", authorize("settings","update"), async (req, res, next) => {
  try {
    const { smtpHost, smtpPort, smtpSecurity, smtpUser, smtpPass } = z.object({
      smtpHost:     z.string().min(1),
      smtpPort:     z.number().int().min(1).max(65535),
      smtpSecurity: z.enum(["STARTTLS","TLS","NONE"]),
      smtpUser:     z.string().min(1),
      smtpPass:     z.string().min(1),
    }).parse(req.body);

    const transporter = nodemailer.createTransport({
      host:   smtpHost,
      port:   smtpPort,
      secure: smtpSecurity === "TLS",
      requireTLS: smtpSecurity === "STARTTLS",
      auth:   { user: smtpUser, pass: smtpPass },
      connectionTimeout: 10000,
      socketTimeout:     10000,
    });

    await transporter.verify();
    res.json({ success: true, message: "Connexion SMTP réussie." });
  } catch(err: any) {
    res.status(400).json({ success: false, message: err?.message ?? "Connexion SMTP échouée." });
  }
});

// ─── GET /api/settings/audit-logs ────────────────────────────────────────────
router.get("/audit-logs", authorize("settings","read"), async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt((req.query.limit  as string) || "100", 10), 200);
    const offset = parseInt((req.query.offset as string) || "0", 10);
    const search = (req.query.search as string) || "";

    const where: any = { orgId: req.user.orgId };
    if (search) {
      where.OR = [
        { action:   { contains: search, mode: "insensitive" } },
        { resource: { contains: search, mode: "insensitive" } },
        { detail:   { contains: search, mode: "insensitive" } },
      ];
    }

    const [logs, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take:    limit,
        skip:    offset,
        select: {
          id: true, action: true, resource: true, resourceId: true,
          detail: true, ipAddress: true, createdAt: true,
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ data: logs, total });
  } catch(err){ next(err); }
});

export { router as settingsRouter };
