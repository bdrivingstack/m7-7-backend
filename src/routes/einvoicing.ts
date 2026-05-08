import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize, requireSameOrg } from "../middleware/authorize.js";
import { auditLog } from "../lib/audit.js";

const router = Router();
router.use(authenticate);

// ─── GET /api/einvoicing ──────────────────────────────────────────────────────
// Liste les documents e-invoicing de l'org
router.get("/", authorize("invoices","read"), async (req, res, next) => {
  try {
    const page   = parseInt(req.query.page  as string) || 1;
    const limit  = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as string | undefined;

    const where: any = { orgId:req.user.orgId, ...(status && { status }) };
    const [docs, total] = await Promise.all([
      prisma.eInvoiceDocument.findMany({ where, skip:(page-1)*limit, take:limit,
        orderBy:{ createdAt:"desc" },
        include:{ invoice:{ select:{ id:true, number:true } } } }),
      prisma.eInvoiceDocument.count({ where }),
    ]);
    res.json({ data:docs, meta:{ total, page, limit, pages:Math.ceil(total/limit) } });
  } catch(err){ next(err); }
});

// ─── GET /api/einvoicing/:id ──────────────────────────────────────────────────
router.get("/:id", authorize("invoices","read"), async (req, res, next) => {
  try {
    const doc = await prisma.eInvoiceDocument.findUnique({
      where:{ id:req.params.id },
      include:{ invoice:true, statusEvents:{ orderBy:{ occurredAt:"asc" } }, archive:true },
    });
    requireSameOrg(req, doc);
    res.json({ data: doc });
  } catch(err){ next(err); }
});

// ─── POST /api/einvoicing/:invoiceId/submit ───────────────────────────────────
// Soumettre une facture à la PDP
router.post("/:invoiceId/submit", authorize("invoices","send"), async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where:   { id:req.params.invoiceId },
      include: { customer:true, lines:true, org:true, einvoiceDoc:true },
    });
    requireSameOrg(req, invoice);

    if (!invoice!.isEInvoice) throw new Error("Cette facture n'est pas configurée pour la facturation électronique.");
    if (!invoice!.frozenAt)   throw new Error("La facture doit être envoyée (verrouillée) avant soumission à la PDP.");
    if (invoice!.einvoiceDoc) throw new Error("Cette facture a déjà été soumise à la PDP.");

    const org = invoice!.org;
    if (!org.pdpProvider)     throw new Error("Aucune PDP configurée dans les paramètres.");
    if (!org.einvoicingEnabled) throw new Error("La facturation électronique n'est pas activée.");

    // Vérifier que le vendeur a un SIREN
    if (!org.siren)           throw new Error("Le SIREN de votre organisation est requis pour la facturation électronique.");

    const { format } = z.object({
      format: z.enum(["FACTURX_MINIMUM","FACTURX_BASIC","FACTURX_EN16931","FACTURX_EXTENDED","UBL","CII"])
        .default("FACTURX_EN16931"),
    }).parse(req.body);

    // Créer le document e-invoice et les événements de statut
    const einvoiceDoc = await prisma.$transaction(async (tx) => {
      const doc = await tx.eInvoiceDocument.create({ data: {
        orgId:          req.user.orgId,
        invoiceId:      invoice!.id,
        documentNumber: invoice!.number,
        format,
        sellerSiren:    org.siren!,
        sellerSiret:    org.siret ?? undefined,
        sellerTva:      org.tvaNumber ?? undefined,
        buyerSiren:     invoice!.customer.siren  ?? undefined,
        buyerSiret:     invoice!.customer.siret  ?? undefined,
        buyerTva:       invoice!.customer.tvaNumber ?? undefined,
        totalHT:        invoice!.totalHT,
        totalTVA:       invoice!.totalTVA,
        totalTTC:       invoice!.totalTTC,
        currency:       invoice!.currency,
        issueDate:      invoice!.issueDate,
        pdpProvider:    org.pdpProvider!,
        status:         "PENDING",
        statusEvents:   { create:{
          source:"internal", eventCode:"PENDING",
          eventLabel:"Document créé — en attente de soumission à la PDP",
        }},
      }});

      // Mettre à jour la facture
      await tx.invoice.update({ where:{ id:invoice!.id },
        data:{ isEInvoice:true, eInvoiceFormat:format } });

      return doc;
    });

    // TODO: Appel réel à l'API PDP (Chorus Pro, Pennylane...)
    // const pdpResponse = await pdpService.submit(einvoiceDoc, org.pdpApiKeyEncrypted);
    // await prisma.eInvoiceDocument.update({ where:{ id:einvoiceDoc.id },
    //   data:{ pdpMessageId:pdpResponse.messageId, status:"SUBMITTED", submittedAt:new Date() } });

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"EINVOICE_SUBMITTED",
      resource:"einvoiceDoc", resourceId:einvoiceDoc.id,
      detail:`Facture ${invoice!.number} → PDP ${org.pdpProvider}`, ipAddress:req.ip });

    res.status(201).json({ data: einvoiceDoc });
  } catch(err){ next(err); }
});

// ─── POST /api/einvoicing/pdp-webhook ─────────────────────────────────────────
// Webhook PDP → M7Sept — statuts entrants (PAS de authenticate)
router.post("/pdp-webhook", async (req, res, next) => {
  try {
    // TODO: Vérifier la signature HMAC du webhook PDP
    // const signature = req.headers["x-pdp-signature"];
    // verifyPdpSignature(req.body, signature, process.env.PDP_WEBHOOK_SECRET);

    const { messageId, eventCode, eventLabel, occurredAt, isTerminal } = z.object({
      messageId:  z.string(),
      eventCode:  z.string(),
      eventLabel: z.string().optional(),
      occurredAt: z.string().datetime().optional(),
      isTerminal: z.boolean().default(false),
    }).parse(req.body);

    const doc = await prisma.eInvoiceDocument.findFirst({ where:{ pdpMessageId:messageId } });
    if (!doc) { res.json({ received:true }); return; }

    // Map du code PDP vers le statut M7Sept
    const statusMap: Record<string,string> = {
      "DEPOSITED":"SUBMITTED", "SENT":"DELIVERED",
      "ACKNOWLEDGED":"ACCEPTED", "REJECTED":"REJECTED",
      "PAID":"PAYMENT_RECEIVED",
    };
    const newStatus = statusMap[eventCode] || "SUBMITTED";

    await prisma.$transaction([
      prisma.eInvoiceDocument.update({ where:{ id:doc.id }, data:{
        status:      newStatus as any,
        ...(newStatus==="SUBMITTED"    && { submittedAt:   new Date() }),
        ...(newStatus==="DELIVERED"    && { deliveredAt:   new Date() }),
        ...(newStatus==="ACCEPTED"     && { acceptedAt:    new Date() }),
        ...(newStatus==="REJECTED"     && { rejectedAt:    new Date() }),
        ...(newStatus==="PAYMENT_RECEIVED" && { paymentAt: new Date() }),
      }}),
      prisma.eInvoiceStatusEvent.create({ data:{
        einvoiceDocId: doc.id, source:"pdp",
        eventCode, eventLabel,
        occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
        rawPayloadJson: req.body,
        isTerminal,
      }}),
    ]);

    res.json({ received: true });
  } catch(err){ next(err); }
});

// ─── POST /api/einvoicing/:id/archive ─────────────────────────────────────────
// Archivage légal probant (après acceptation)
router.post("/:id/archive", authorize("invoices","update"), async (req, res, next) => {
  try {
    const doc = await prisma.eInvoiceDocument.findUnique({ where:{ id:req.params.id }, include:{ archive:true } });
    requireSameOrg(req, doc);
    if (doc!.status !== "ACCEPTED") throw new Error("Seul un document accepté peut être archivé.");
    if (doc!.archive) throw new Error("Ce document est déjà archivé.");

    const { xmlContent, checksumSha256 } = z.object({
      xmlContent:     z.string(),
      checksumSha256: z.string().length(64),
    }).parse(req.body);

    // Conservation légale 10 ans (droit fiscal français)
    const retainUntil = new Date();
    retainUntil.setFullYear(retainUntil.getFullYear() + 10);

    const archive = await prisma.$transaction(async (tx) => {
      const arch = await tx.eInvoiceArchive.create({ data:{
        einvoiceDocId:  doc!.id,
        xmlContent,
        checksumSha256,
        retainUntil,
      }});
      await tx.eInvoiceDocument.update({ where:{ id:doc!.id },
        data:{ status:"ARCHIVED", archivedAt:new Date(),
          statusEvents:{ create:{ source:"internal", eventCode:"ARCHIVED",
            eventLabel:"Archivé légalement — conservation 10 ans", isTerminal:true } },
        },
      });
      return arch;
    });

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"EINVOICE_ARCHIVED",
      resource:"einvoiceArchive", resourceId:archive.id, ipAddress:req.ip });

    res.json({ data:{ id:archive.id, archivedAt:archive.archivedAt, retainUntil } });
  } catch(err){ next(err); }
});

export { router as einvoicingRouter };
