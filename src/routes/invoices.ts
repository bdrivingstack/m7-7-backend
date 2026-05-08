import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize, requireSameOrg } from "../middleware/authorize.js";
import { Errors } from "../middleware/errorHandler.js";
import { auditLog } from "../lib/audit.js";

const router = Router();
router.use(authenticate);

// ─── SCHÉMAS ZOD ─────────────────────────────────────────────────────────────

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

const InvoiceSchema = z.object({
  customerId:       z.string().cuid(),
  number:           z.string().max(50).optional(), // Auto-généré si absent
  reference:        z.string().max(100).optional(),
  issueDate:        z.string().datetime().optional(),
  dueDate:          z.string().datetime().optional(),
  title:            z.string().max(500).optional(),
  headerNote:       z.string().max(2000).optional(),
  footerNote:       z.string().max(2000).optional(),
  legalMentions:    z.string().max(2000).optional(),
  penaltyClause:    z.string().max(500).optional(),
  isMicroEnterprise:z.boolean().default(false),
  currency:         z.string().length(3).default("EUR"),
  discount:         z.number().min(0).max(100).optional(),
  depositAmount:    z.number().min(0).optional(),
  depositPercent:   z.number().min(0).max(100).optional(),
  isEInvoice:       z.boolean().default(false),
  eInvoiceFormat:   z.enum(["FACTURX_MINIMUM","FACTURX_BASIC","FACTURX_EN16931","FACTURX_EXTENDED","UBL","CII"]).optional(),
  designConfig:     z.record(z.unknown()).optional(),
  columnsConfig:    z.record(z.unknown()).optional(),
  lines:            z.array(LineSchema).min(1).max(200),
});

const PaginationSchema = z.object({
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(100).default(20),
  search:    z.string().max(100).optional(),
  status:    z.string().optional(),
  customerId:z.string().optional(),
  dateFrom:  z.string().optional(),
  dateTo:    z.string().optional(),
  sortBy:    z.enum(["issueDate", "dueDate", "number", "totalTTC", "createdAt"]).default("issueDate"),
  sortDir:   z.enum(["asc", "desc"]).default("desc"),
});

// ─── HELPER : Calculer les totaux depuis les lignes ───────────────────────────

function computeTotals(lines: z.infer<typeof LineSchema>[]) {
  let totalHT = 0, totalTVA = 0;
  for (const line of lines) {
    const ht  = line.unitPriceHT * line.quantity * (1 - (line.discount || 0) / 100);
    totalHT  += ht;
    totalTVA += ht * line.vatRate / 100;
  }
  return {
    totalHT:  Math.round(totalHT * 100) / 100,
    totalTVA: Math.round(totalTVA * 100) / 100,
    totalTTC: Math.round((totalHT + totalTVA) * 100) / 100,
  };
}

// ─── HELPER : Générer un numéro de facture séquentiel ────────────────────────

async function generateInvoiceNumber(orgId: string): Promise<string> {
  const org = await prisma.org.update({
    where: { id: orgId },
    data:  { invoiceCounter: { increment: 1 } },
    select: { invoicePrefix: true, invoiceCounter: true },
  });
  const year    = new Date().getFullYear();
  const counter = String(org.invoiceCounter).padStart(4, "0");
  return `${org.invoicePrefix}-${year}-${counter}`;
}

// ─── GET /api/invoices ────────────────────────────────────────────────────────

router.get("/", authorize("invoices", "read"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, search, status, customerId, dateFrom, dateTo, sortBy, sortDir } =
      PaginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const where: any = {
      orgId:     req.user.orgId,
      deletedAt: null,
      ...(status     && { status }),
      ...(customerId && { customerId }),
      ...(search     && {
        OR: [
          { number:    { contains: search, mode: "insensitive" } },
          { customer:  { name: { contains: search, mode: "insensitive" } } },
        ],
      }),
      ...(dateFrom || dateTo) && {
        issueDate: {
          ...(dateFrom && { gte: new Date(dateFrom) }),
          ...(dateTo   && { lte: new Date(dateTo) }),
        },
      },
    };

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where, skip, take: limit,
        orderBy: { [sortBy]: sortDir },
        include: {
          customer: { select: { id: true, name: true, email: true } },
          _count:   { select: { payments: true, lines: true } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json({
      data: invoices,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/invoices/:id ────────────────────────────────────────────────────

router.get("/:id", authorize("invoices", "read"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        customer:       true,
        lines:          { orderBy: { position: "asc" } },
        statusHistory:  { orderBy: { createdAt: "desc" } },
        payments:       { orderBy: { paidAt: "desc" } },
        creditNotes:    true,
        paymentSchedule:{ orderBy: { dueDate: "asc" } },
        reminders:      { orderBy: { sentAt: "desc" } },
        einvoiceDoc:    { include: { statusEvents: { orderBy: { occurredAt: "desc" } } } },
        createdBy:      { select: { firstName: true, lastName: true, email: true } },
      },
    });
    requireSameOrg(req, invoice);
    res.json({ data: invoice });
  } catch (err) { next(err); }
});

// ─── POST /api/invoices ───────────────────────────────────────────────────────

router.post("/", authorize("invoices", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = InvoiceSchema.parse(req.body);

    // Vérifier que le client appartient à l'org
    const customer = await prisma.customer.findUnique({ where: { id: body.customerId } });
    requireSameOrg(req, customer);

    // Générer le numéro si absent
    const number = body.number || await generateInvoiceNumber(req.user.orgId);
    const { totalHT, totalTVA, totalTTC } = computeTotals(body.lines);

    const invoice = await prisma.invoice.create({
      data: {
        orgId:       req.user.orgId,
        customerId:  body.customerId,
        createdById: req.user.id,
        number,
        reference:   body.reference,
        issueDate:   body.issueDate ? new Date(body.issueDate) : new Date(),
        dueDate:     body.dueDate   ? new Date(body.dueDate)   : undefined,
        title:            body.title,
        headerNote:       body.headerNote,
        footerNote:       body.footerNote,
        legalMentions:    body.legalMentions,
        penaltyClause:    body.penaltyClause,
        isMicroEnterprise:body.isMicroEnterprise,
        currency:         body.currency,
        discount:         body.discount,
        depositAmount:    body.depositAmount,
        depositPercent:   body.depositPercent,
        isEInvoice:       body.isEInvoice,
        eInvoiceFormat:   body.eInvoiceFormat,
        designConfig:     body.designConfig as any,
        columnsConfig:    body.columnsConfig as any,
        totalHT, totalTVA, totalTTC,
        totalDue: totalTTC,
        lines: {
          create: body.lines.map(line => ({
            ...line,
            totalHT:  Math.round(line.unitPriceHT * line.quantity * (1 - (line.discount || 0) / 100) * 100) / 100,
            totalTTC: Math.round(line.unitPriceHT * line.quantity * (1 - (line.discount || 0) / 100) * (1 + line.vatRate / 100) * 100) / 100,
          })),
        },
        statusHistory: { create: { status: "DRAFT", createdBy: req.user.id } },
      },
      include: { lines: true },
    });

    await auditLog({ userId: req.user.id, orgId: req.user.orgId,
      action: "INVOICE_CREATED", resource: "invoice", resourceId: invoice.id,
      ipAddress: req.ip });

    res.status(201).json({ data: invoice });
  } catch (err) { next(err); }
});

// ─── PATCH /api/invoices/:id ──────────────────────────────────────────────────

router.patch("/:id", authorize("invoices", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);

    // Facture verrouillée — non modifiable
    if (existing!.frozenAt) {
      throw new (Errors.VALIDATION as any)("Cette facture est verrouillée et ne peut plus être modifiée. Créez un avoir.");
    }

    const body = InvoiceSchema.partial().parse(req.body);
    let updateData: any = { ...body };
    delete updateData.lines;

    // Recalculer les totaux si les lignes changent
    if (body.lines) {
      const { totalHT, totalTVA, totalTTC } = computeTotals(body.lines);
      updateData = { ...updateData, totalHT, totalTVA, totalTTC, totalDue: totalTTC - (existing!.totalPaid as any) };

      // Supprimer et recréer les lignes
      await prisma.invoiceLine.deleteMany({ where: { invoiceId: req.params.id } });
      await prisma.invoiceLine.createMany({
        data: body.lines.map(line => ({
          invoiceId: req.params.id,
          ...line,
          totalHT:  Math.round(line.unitPriceHT * line.quantity * (1 - (line.discount || 0) / 100) * 100) / 100,
          totalTTC: Math.round(line.unitPriceHT * line.quantity * (1 - (line.discount || 0) / 100) * (1 + line.vatRate / 100) * 100) / 100,
        })),
      });
    }

    const invoice = await prisma.invoice.update({ where: { id: req.params.id }, data: updateData });

    await auditLog({ userId: req.user.id, orgId: req.user.orgId,
      action: "INVOICE_UPDATED", resource: "invoice", resourceId: invoice.id,
      ipAddress: req.ip });

    res.json({ data: invoice });
  } catch (err) { next(err); }
});

// ─── POST /api/invoices/:id/send ──────────────────────────────────────────────

router.post("/:id/send", authorize("invoices", "send"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);

    const invoice = await prisma.invoice.update({
      where: { id: req.params.id },
      data:  {
        status:    "SENT",
        frozenAt:  new Date(), // Verrouillage légal à l'envoi
        statusHistory: { create: { status: "SENT", createdBy: req.user.id, note: "Envoyée par email" } },
      },
    });

    // TODO: Envoyer l'email avec le PDF en pièce jointe via emailService

    await auditLog({ userId: req.user.id, orgId: req.user.orgId,
      action: "INVOICE_SENT", resource: "invoice", resourceId: invoice.id,
      ipAddress: req.ip });

    res.json({ data: invoice });
  } catch (err) { next(err); }
});

// ─── POST /api/invoices/:id/mark-paid ────────────────────────────────────────

router.post("/:id/mark-paid", authorize("invoices", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);

    const { amount, method, reference, paidAt } = z.object({
      amount:    z.number().positive().optional(),
      method:    z.enum(["BANK_TRANSFER","CARD","CASH","CHECK","DIRECT_DEBIT","PAYPAL","OTHER"]).default("BANK_TRANSFER"),
      reference: z.string().max(100).optional(),
      paidAt:    z.string().datetime().optional(),
    }).parse(req.body);

    const paymentAmount = amount || Number(existing!.totalDue);

    await prisma.$transaction([
      prisma.payment.create({
        data: {
          orgId:      req.user.orgId,
          invoiceId:  req.params.id,
          customerId: existing!.customerId,
          amount:     paymentAmount,
          method,
          status:     "SUCCEEDED",
          reference,
          paidAt:     paidAt ? new Date(paidAt) : new Date(),
        },
      }),
      prisma.invoice.update({
        where: { id: req.params.id },
        data:  {
          totalPaid: { increment: paymentAmount },
          totalDue:  { decrement: paymentAmount },
          status:    "PAID",
          paidAt:    new Date(),
          statusHistory: { create: { status: "PAID", createdBy: req.user.id } },
        },
      }),
    ]);

    await auditLog({ userId: req.user.id, orgId: req.user.orgId,
      action: "INVOICE_PAID", resource: "invoice", resourceId: req.params.id,
      detail: `Montant: ${paymentAmount}€`, ipAddress: req.ip });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── DELETE /api/invoices/:id (soft delete — ADMIN+) ─────────────────────────

router.delete("/:id", authorize("invoices", "delete"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);

    if (existing!.frozenAt) {
      throw Errors.VALIDATION("Impossible de supprimer une facture verrouillée. Créez un avoir.");
    }

    await prisma.invoice.update({
      where: { id: req.params.id },
      data:  { deletedAt: new Date() },
    });

    await auditLog({ userId: req.user.id, orgId: req.user.orgId,
      action: "INVOICE_DELETED", resource: "invoice", resourceId: req.params.id,
      ipAddress: req.ip });

    res.json({ success: true });
  } catch (err) { next(err); }
});

export { router as invoicesRouter };
