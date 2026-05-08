import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize, requireSameOrg } from "../middleware/authorize.js";
import { auditLog } from "../lib/audit.js";

const router = Router();
router.use(authenticate);

const LineSchema = z.object({
  position:    z.number().int().min(0),
  designation: z.string().min(1).max(500).trim(),
  description: z.string().max(2000).optional(),
  reference:   z.string().max(100).optional(),
  unit:        z.string().max(50).optional(),
  quantity:    z.number().positive(),
  unitPriceHT: z.number(),
  vatRate:     z.number().min(0).max(100).default(20),
  discount:    z.number().min(0).max(100).optional(),
  customFields:z.record(z.string()).optional(),
});

const QuoteSchema = z.object({
  customerId:  z.string().cuid(),
  number:      z.string().max(50).optional(),
  reference:   z.string().max(100).optional(),
  issueDate:   z.string().datetime().optional(),
  validUntil:  z.string().datetime().optional(),
  title:       z.string().max(500).optional(),
  headerNote:  z.string().max(2000).optional(),
  footerNote:  z.string().max(2000).optional(),
  currency:    z.string().length(3).default("EUR"),
  discount:    z.number().min(0).max(100).optional(),
  designConfig: z.record(z.unknown()).optional(),
  columnsConfig:z.record(z.unknown()).optional(),
  lines:       z.array(LineSchema).min(1).max(200),
});

const PaginationSchema = z.object({
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(100).default(20),
  search:    z.string().max(100).optional(),
  status:    z.string().optional(),
  customerId:z.string().optional(),
  sortBy:    z.enum(["issueDate","validUntil","number","totalTTC","createdAt"]).default("issueDate"),
  sortDir:   z.enum(["asc","desc"]).default("desc"),
});

function computeTotals(lines: z.infer<typeof LineSchema>[]) {
  let totalHT = 0, totalTVA = 0;
  for (const l of lines) {
    const ht  = l.unitPriceHT * l.quantity * (1 - (l.discount || 0) / 100);
    totalHT  += ht;
    totalTVA += ht * l.vatRate / 100;
  }
  return {
    totalHT:  Math.round(totalHT  * 100) / 100,
    totalTVA: Math.round(totalTVA * 100) / 100,
    totalTTC: Math.round((totalHT + totalTVA) * 100) / 100,
  };
}

async function generateQuoteNumber(orgId: string) {
  const org = await prisma.org.update({
    where: { id: orgId },
    data:  { quoteCounter: { increment: 1 } },
    select:{ quotePrefix: true, quoteCounter: true },
  });
  return `${org.quotePrefix}-${new Date().getFullYear()}-${String(org.quoteCounter).padStart(4,"0")}`;
}

// ─── GET /api/quotes ──────────────────────────────────────────────────────────
router.get("/", authorize("quotes","read"), async (req, res, next) => {
  try {
    const { page, limit, search, status, customerId, sortBy, sortDir } = PaginationSchema.parse(req.query);
    const skip = (page - 1) * limit;
    const where: any = {
      orgId:     req.user.orgId,
      deletedAt: null,
      ...(status     && { status }),
      ...(customerId && { customerId }),
      ...(search     && { OR: [
        { number:   { contains: search, mode: "insensitive" } },
        { customer: { name: { contains: search, mode: "insensitive" } } },
      ]}),
    };
    const [quotes, total] = await Promise.all([
      prisma.quote.findMany({ where, skip, take: limit, orderBy: { [sortBy]: sortDir },
        include: { customer: { select: { id:true, name:true } }, _count: { select: { lines:true } } } }),
      prisma.quote.count({ where }),
    ]);
    res.json({ data: quotes, meta: { total, page, limit, pages: Math.ceil(total/limit) } });
  } catch(err){ next(err); }
});

// ─── GET /api/quotes/:id ──────────────────────────────────────────────────────
router.get("/:id", authorize("quotes","read"), async (req, res, next) => {
  try {
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id },
      include: { customer:true, lines:{ orderBy:{ position:"asc" } },
        statusHistory:{ orderBy:{ createdAt:"desc" } },
        createdBy:{ select:{ firstName:true, lastName:true } } } });
    requireSameOrg(req, quote);
    res.json({ data: quote });
  } catch(err){ next(err); }
});

// ─── POST /api/quotes ─────────────────────────────────────────────────────────
router.post("/", authorize("quotes","create"), async (req, res, next) => {
  try {
    const body = QuoteSchema.parse(req.body);
    const customer = await prisma.customer.findUnique({ where: { id: body.customerId } });
    requireSameOrg(req, customer);

    const number = body.number || await generateQuoteNumber(req.user.orgId);
    const { totalHT, totalTVA, totalTTC } = computeTotals(body.lines);

    const quote = await prisma.quote.create({
      data: {
        orgId: req.user.orgId, customerId: body.customerId, createdById: req.user.id,
        number, reference: body.reference,
        issueDate:  body.issueDate  ? new Date(body.issueDate)  : new Date(),
        validUntil: body.validUntil ? new Date(body.validUntil) : undefined,
        title: body.title, headerNote: body.headerNote, footerNote: body.footerNote,
        currency: body.currency, discount: body.discount,
        designConfig: body.designConfig as any, columnsConfig: body.columnsConfig as any,
        totalHT, totalTVA, totalTTC,
        lines: { create: body.lines.map(l => ({
          ...l,
          totalHT:  Math.round(l.unitPriceHT * l.quantity * (1-(l.discount||0)/100) * 100) / 100,
          totalTTC: Math.round(l.unitPriceHT * l.quantity * (1-(l.discount||0)/100) * (1+l.vatRate/100) * 100) / 100,
        }))},
        statusHistory: { create: { status: "DRAFT", createdBy: req.user.id } },
      },
      include: { lines: true },
    });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"QUOTE_CREATED", resource:"quote", resourceId:quote.id, ipAddress:req.ip });
    res.status(201).json({ data: quote });
  } catch(err){ next(err); }
});

// ─── PATCH /api/quotes/:id ────────────────────────────────────────────────────
router.patch("/:id", authorize("quotes","update"), async (req, res, next) => {
  try {
    const existing = await prisma.quote.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);
    if (["ACCEPTED","DECLINED"].includes(existing!.status)) throw new Error("Ce devis est finalisé et ne peut plus être modifié.");

    const body = QuoteSchema.partial().parse(req.body);
    let updateData: any = { ...body }; delete updateData.lines;

    if (body.lines) {
      const { totalHT, totalTVA, totalTTC } = computeTotals(body.lines);
      updateData = { ...updateData, totalHT, totalTVA, totalTTC };
      await prisma.quoteLine.deleteMany({ where: { quoteId: req.params.id } });
      await prisma.quoteLine.createMany({ data: body.lines.map(l => ({
        quoteId: req.params.id, ...l,
        totalHT:  Math.round(l.unitPriceHT * l.quantity * (1-(l.discount||0)/100) * 100) / 100,
        totalTTC: Math.round(l.unitPriceHT * l.quantity * (1-(l.discount||0)/100) * (1+l.vatRate/100) * 100) / 100,
      }))});
    }

    const quote = await prisma.quote.update({ where: { id: req.params.id }, data: updateData });
    res.json({ data: quote });
  } catch(err){ next(err); }
});

// ─── POST /api/quotes/:id/accept ─────────────────────────────────────────────
router.post("/:id/accept", authorize("quotes","update"), async (req, res, next) => {
  try {
    const existing = await prisma.quote.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);
    const { signedByName, signedByIp } = z.object({
      signedByName: z.string().optional(),
      signedByIp:   z.string().optional(),
    }).parse(req.body);

    const quote = await prisma.quote.update({ where: { id: req.params.id }, data: {
      status: "ACCEPTED", acceptedAt: new Date(),
      signedAt: new Date(), signedByName, signedByIp,
      statusHistory: { create: { status:"ACCEPTED", createdBy:req.user.id } },
    }});
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"QUOTE_ACCEPTED", resource:"quote", resourceId:quote.id, ipAddress:req.ip });
    res.json({ data: quote });
  } catch(err){ next(err); }
});

// ─── POST /api/quotes/:id/decline ────────────────────────────────────────────
router.post("/:id/decline", authorize("quotes","update"), async (req, res, next) => {
  try {
    const existing = await prisma.quote.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);
    const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body);
    const quote = await prisma.quote.update({ where: { id: req.params.id }, data: {
      status:"DECLINED", declinedAt:new Date(), declineReason:reason,
      statusHistory:{ create:{ status:"DECLINED", createdBy:req.user.id, note:reason } },
    }});
    res.json({ data: quote });
  } catch(err){ next(err); }
});

// ─── POST /api/quotes/:id/convert ────────────────────────────────────────────
// Convertit un devis accepté en facture
router.post("/:id/convert", authorize("invoices","create"), async (req, res, next) => {
  try {
    const quote = await prisma.quote.findUnique({ where:{ id:req.params.id }, include:{ lines:true } });
    requireSameOrg(req, quote);
    if (quote!.status !== "ACCEPTED") throw new Error("Seul un devis accepté peut être converti en facture.");
    if (quote!.convertedAt) throw new Error("Ce devis a déjà été converti en facture.");

    const invoiceNumber = await (async () => {
      const org = await prisma.org.update({
        where:{ id:req.user.orgId }, data:{ invoiceCounter:{ increment:1 } },
        select:{ invoicePrefix:true, invoiceCounter:true },
      });
      return `${org.invoicePrefix}-${new Date().getFullYear()}-${String(org.invoiceCounter).padStart(4,"0")}`;
    })();

    const [invoice] = await prisma.$transaction([
      prisma.invoice.create({ data: {
        orgId: req.user.orgId, customerId: quote!.customerId, createdById: req.user.id,
        quoteId: quote!.id, number: invoiceNumber,
        title: quote!.title ?? undefined,
        headerNote: quote!.headerNote ?? undefined,
        footerNote: quote!.footerNote ?? undefined,
        currency: quote!.currency,
        totalHT: quote!.totalHT, totalTVA: quote!.totalTVA, totalTTC: quote!.totalTTC,
        totalDue: quote!.totalTTC,
        designConfig: quote!.designConfig ?? undefined,
        columnsConfig: quote!.columnsConfig ?? undefined,
        lines: { create: quote!.lines.map(l => ({
          position:l.position, designation:l.designation, description:l.description ?? undefined,
          reference:l.reference ?? undefined, unit:l.unit ?? undefined,
          quantity:l.quantity, unitPriceHT:l.unitPriceHT,
          vatRate:l.vatRate, discount:l.discount ?? undefined,
          totalHT:l.totalHT, totalTTC:l.totalTTC,
        }))},
        statusHistory:{ create:{ status:"DRAFT", createdBy:req.user.id, note:"Converti depuis devis "+quote!.number } },
      }}),
      prisma.quote.update({ where:{ id:quote!.id }, data:{ convertedAt:new Date(),
        statusHistory:{ create:{ status:"ACCEPTED", createdBy:req.user.id, note:"Converti en facture "+invoiceNumber } },
      }}),
    ]);

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"QUOTE_CONVERTED", resource:"quote", resourceId:quote!.id, detail:`Facture: ${invoiceNumber}`, ipAddress:req.ip });
    res.status(201).json({ data: invoice });
  } catch(err){ next(err); }
});

// ─── DELETE /api/quotes/:id ───────────────────────────────────────────────────
router.delete("/:id", authorize("quotes","delete"), async (req, res, next) => {
  try {
    const existing = await prisma.quote.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);
    await prisma.quote.update({ where:{ id:req.params.id }, data:{ deletedAt:new Date() } });
    res.json({ success: true });
  } catch(err){ next(err); }
});

export { router as quotesRouter };
