import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize, requireSameOrg } from "../middleware/authorize.js";
import { auditLog } from "../lib/audit.js";

const router = Router();
router.use(authenticate);

const PaymentSchema = z.object({
  invoiceId:  z.string().cuid().optional(),
  customerId: z.string().cuid().optional(),
  amount:     z.number().positive(),
  currency:   z.string().length(3).default("EUR"),
  method:     z.enum(["BANK_TRANSFER","CARD","CASH","CHECK","DIRECT_DEBIT","PAYPAL","OTHER"]).default("BANK_TRANSFER"),
  reference:  z.string().max(100).optional(),
  note:       z.string().max(500).optional(),
  paidAt:     z.string().datetime().optional(),
});

const PaginationSchema = z.object({
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(100).default(20),
  status:    z.string().optional(),
  method:    z.string().optional(),
  customerId:z.string().optional(),
  invoiceId: z.string().optional(),
  dateFrom:  z.string().optional(),
  dateTo:    z.string().optional(),
  sortBy:    z.enum(["paidAt","amount","createdAt"]).default("paidAt"),
  sortDir:   z.enum(["asc","desc"]).default("desc"),
});

// ─── GET /api/payments ────────────────────────────────────────────────────────
router.get("/", authorize("payments","read"), async (req, res, next) => {
  try {
    const { page, limit, status, method, customerId, invoiceId, dateFrom, dateTo, sortBy, sortDir } =
      PaginationSchema.parse(req.query);
    const skip = (page-1)*limit;
    const where: any = {
      orgId: req.user.orgId,
      ...(status     && { status }),
      ...(method     && { method }),
      ...(customerId && { customerId }),
      ...(invoiceId  && { invoiceId }),
      ...(dateFrom || dateTo) && { paidAt: {
        ...(dateFrom && { gte: new Date(dateFrom) }),
        ...(dateTo   && { lte: new Date(dateTo) }),
      }},
    };
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({ where, skip, take:limit, orderBy:{ [sortBy]:sortDir },
        include: { invoice:{ select:{ id:true, number:true } }, customer:{ select:{ id:true, name:true } } } }),
      prisma.payment.count({ where }),
    ]);
    res.json({ data:payments, meta:{ total, page, limit, pages:Math.ceil(total/limit) } });
  } catch(err){ next(err); }
});

// ─── GET /api/payments/:id ────────────────────────────────────────────────────
router.get("/:id", authorize("payments","read"), async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUnique({ where:{ id:req.params.id },
      include:{ invoice:true, customer:true, attempts:{ orderBy:{ attemptedAt:"desc" } } } });
    requireSameOrg(req, payment);
    res.json({ data: payment });
  } catch(err){ next(err); }
});

// ─── POST /api/payments ───────────────────────────────────────────────────────
router.post("/", authorize("payments","create"), async (req, res, next) => {
  try {
    const body = PaymentSchema.parse(req.body);

    // Vérifier appartenance org
    if (body.invoiceId) {
      const inv = await prisma.invoice.findUnique({ where:{ id:body.invoiceId } });
      requireSameOrg(req, inv);
    }

    const payment = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({ data: {
        orgId: req.user.orgId,
        invoiceId:  body.invoiceId,
        customerId: body.customerId,
        amount:     body.amount,
        currency:   body.currency,
        method:     body.method,
        status:     "SUCCEEDED",
        reference:  body.reference,
        note:       body.note,
        paidAt:     body.paidAt ? new Date(body.paidAt) : new Date(),
      }});

      // Mettre à jour la facture si liée
      if (body.invoiceId) {
        const inv = await tx.invoice.findUnique({ where:{ id:body.invoiceId } });
        const newPaid = Number(inv!.totalPaid) + body.amount;
        const newDue  = Math.max(0, Number(inv!.totalTTC) - newPaid);
        const status  = newDue <= 0 ? "PAID" : "PARTIAL";
        await tx.invoice.update({ where:{ id:body.invoiceId }, data:{
          totalPaid: newPaid, totalDue: newDue, status,
          paidAt:    status === "PAID" ? new Date() : undefined,
          statusHistory:{ create:{ status, createdBy:req.user.id, note:`Paiement ${body.amount}€` } },
        }});
      }

      return p;
    });

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"PAYMENT_CREATED", resource:"payment", resourceId:payment.id, detail:`${body.amount}€`, ipAddress:req.ip });
    res.status(201).json({ data: payment });
  } catch(err){ next(err); }
});

// ─── POST /api/payments/:id/refund ────────────────────────────────────────────
router.post("/:id/refund", authorize("payments","update"), async (req, res, next) => {
  try {
    const existing = await prisma.payment.findUnique({ where:{ id:req.params.id } });
    requireSameOrg(req, existing);
    if (existing!.refundedAt) throw new Error("Ce paiement a déjà été remboursé.");

    const { amount, reason } = z.object({
      amount: z.number().positive().optional(),
      reason: z.string().max(500).optional(),
    }).parse(req.body);

    const refundAmount = amount || Number(existing!.amount);
    const payment = await prisma.payment.update({ where:{ id:req.params.id }, data:{
      status:       "REFUNDED",
      refundedAt:   new Date(),
      refundAmount,
      refundReason: reason,
    }});

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"PAYMENT_REFUNDED", resource:"payment", resourceId:payment.id, detail:`${refundAmount}€`, ipAddress:req.ip });
    res.json({ data: payment });
  } catch(err){ next(err); }
});

// ─── POST /api/payments/stripe-webhook ────────────────────────────────────────
// Route spéciale — PAS de authenticate (Stripe signe la requête)
router.post("/stripe-webhook", async (req, res, next) => {
  try {
    const sig = req.headers["stripe-signature"] as string;
    // TODO: const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    // Traiter: payment_intent.succeeded, payment_intent.payment_failed, charge.refunded
    res.json({ received: true });
  } catch(err){ next(err); }
});

export { router as paymentsRouter };
