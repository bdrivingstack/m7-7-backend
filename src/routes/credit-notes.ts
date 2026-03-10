import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize, requireSameOrg } from "../middleware/authorize.js";
import { auditLog } from "../lib/audit.js";

const router = Router();
router.use(authenticate);

const LineSchema = z.object({
  position:   z.number().int().min(0),
  designation:z.string().min(1).max(500),
  quantity:   z.number().positive(),
  unitPriceHT:z.number(),
  vatRate:    z.number().min(0).max(100).default(20),
  totalHT:    z.number(),
  totalTTC:   z.number(),
});

const CreditNoteSchema = z.object({
  invoiceId:  z.string().cuid(),
  reason:     z.string().max(500).optional(),
  lines:      z.array(LineSchema).min(1).max(200),
});

async function generateCreditNoteNumber(orgId: string) {
  const org = await prisma.org.update({
    where:{ id:orgId }, data:{ creditNoteCounter:{ increment:1 } },
    select:{ creditNotePrefix:true, creditNoteCounter:true },
  });
  return `${org.creditNotePrefix}-${new Date().getFullYear()}-${String(org.creditNoteCounter).padStart(4,"0")}`;
}

// ─── GET /api/credit-notes ────────────────────────────────────────────────────
router.get("/", authorize("invoices","read"), async (req, res, next) => {
  try {
    const page  = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const where = { orgId: req.user.orgId };
    const [creditNotes, total] = await Promise.all([
      prisma.creditNote.findMany({ where, skip:(page-1)*limit, take:limit,
        orderBy:{ createdAt:"desc" },
        include:{ customer:{ select:{ id:true, name:true } }, invoice:{ select:{ id:true, number:true } } } }),
      prisma.creditNote.count({ where }),
    ]);
    res.json({ data:creditNotes, meta:{ total, page, limit, pages:Math.ceil(total/limit) } });
  } catch(err){ next(err); }
});

// ─── GET /api/credit-notes/:id ────────────────────────────────────────────────
router.get("/:id", authorize("invoices","read"), async (req, res, next) => {
  try {
    const cn = await prisma.creditNote.findUnique({ where:{ id:req.params.id },
      include:{ customer:true, invoice:true, lines:{ orderBy:{ position:"asc" } } } });
    requireSameOrg(req, cn);
    res.json({ data: cn });
  } catch(err){ next(err); }
});

// ─── POST /api/credit-notes ───────────────────────────────────────────────────
router.post("/", authorize("invoices","create"), async (req, res, next) => {
  try {
    const body = CreditNoteSchema.parse(req.body);
    const invoice = await prisma.invoice.findUnique({ where:{ id:body.invoiceId } });
    requireSameOrg(req, invoice);

    const number = await generateCreditNoteNumber(req.user.orgId);
    const totalHT  = body.lines.reduce((s,l) => s+l.totalHT,  0);
    const totalTTC = body.lines.reduce((s,l) => s+l.totalTTC, 0);
    const totalTVA = Math.round((totalTTC-totalHT)*100)/100;

    const cn = await prisma.$transaction(async (tx) => {
      const creditNote = await tx.creditNote.create({ data: {
        orgId: req.user.orgId, customerId: invoice!.customerId,
        invoiceId: body.invoiceId, number, reason: body.reason,
        totalHT: Math.round(totalHT*100)/100,
        totalTVA, totalTTC: Math.round(totalTTC*100)/100,
        lines: { create: body.lines },
      }});
      // Marquer la facture comme partiellement créditée
      await tx.invoice.update({ where:{ id:body.invoiceId }, data:{
        status: "CREDITED",
        statusHistory:{ create:{ status:"CREDITED", createdBy:req.user.id, note:`Avoir ${number}` } },
      }});
      return creditNote;
    });

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"CREDIT_NOTE_CREATED", resource:"creditNote", resourceId:cn.id, detail:`Avoir sur facture ${invoice!.number}`, ipAddress:req.ip });
    res.status(201).json({ data: cn });
  } catch(err){ next(err); }
});

export { router as creditNotesRouter };
