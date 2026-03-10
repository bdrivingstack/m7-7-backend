import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize, requireSameOrg } from "../middleware/authorize.js";
import { uploadSingle } from "../middleware/uploadHandler.js";
import { auditLog } from "../lib/audit.js";

const router = Router();
router.use(authenticate);

// ─── GET /api/documents ───────────────────────────────────────────────────────
router.get("/", authorize("documents","read"), async (req, res, next) => {
  try {
    const invoiceId  = req.query.invoiceId  as string | undefined;
    const quoteId    = req.query.quoteId    as string | undefined;
    const customerId = req.query.customerId as string | undefined;
    const category   = req.query.category  as string | undefined;
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const where: any = {
      orgId:     req.user.orgId,
      deletedAt: null,
      ...(invoiceId  && { invoiceId }),
      ...(quoteId    && { quoteId }),
      ...(customerId && { customerId }),
      ...(category   && { category }),
    };

    const [documents, total] = await Promise.all([
      prisma.document.findMany({ where, skip:(page-1)*limit, take:limit,
        orderBy:{ createdAt:"desc" },
        select:{ id:true, name:true, originalName:true, mimeType:true, size:true,
          category:true, tags:true, invoiceId:true, quoteId:true, customerId:true, createdAt:true } }),
      prisma.document.count({ where }),
    ]);

    res.json({ data:documents, meta:{ total, page, limit, pages:Math.ceil(total/limit) } });
  } catch(err){ next(err); }
});

// ─── POST /api/documents ──────────────────────────────────────────────────────
router.post("/", authorize("documents","create"), uploadSingle, async (req, res, next) => {
  try {
    if (!req.file) throw new Error("Aucun fichier reçu.");

    const { invoiceId, quoteId, customerId, category, tags } = z.object({
      invoiceId:  z.string().cuid().optional(),
      quoteId:    z.string().cuid().optional(),
      customerId: z.string().cuid().optional(),
      category:   z.string().max(50).optional(),
      tags:       z.string().optional(), // JSON array stringifié
    }).parse(req.body);

    // SHA-256 du fichier pour piste d'audit
    const fileBuffer = fs.readFileSync(req.file.path);
    const checksum   = crypto.createHash("sha256").update(fileBuffer).digest("hex");

    const parsedTags = tags ? JSON.parse(tags) : [];

    const document = await prisma.document.create({ data: {
      orgId:        req.user.orgId,
      name:         req.file.filename,
      originalName: req.file.originalname,
      mimeType:     req.file.mimetype,
      size:         req.file.size,
      storagePath:  req.file.path,
      checksum,
      invoiceId,
      quoteId,
      customerId,
      category:     category || "other",
      tags:         parsedTags,
      uploadedById: req.user.id,
    }});

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"DOCUMENT_UPLOADED",
      resource:"document", resourceId:document.id,
      detail:`${req.file.originalname} (${req.file.size} bytes)`, ipAddress:req.ip });

    res.status(201).json({ data:{ id:document.id, name:document.name,
      originalName:document.originalName, mimeType:document.mimeType, size:document.size } });
  } catch(err){ next(err); }
});

// ─── GET /api/documents/:id/download ─────────────────────────────────────────
router.get("/:id/download", authorize("documents","read"), async (req, res, next) => {
  try {
    const doc = await prisma.document.findUnique({ where:{ id:req.params.id } });
    requireSameOrg(req, doc);
    if (!doc || doc.deletedAt) throw new Error("Document introuvable.");

    if (!fs.existsSync(doc.storagePath)) throw new Error("Fichier non trouvé sur le serveur.");

    res.setHeader("Content-Disposition", `attachment; filename="${doc.originalName}"`);
    res.setHeader("Content-Type", doc.mimeType);
    fs.createReadStream(doc.storagePath).pipe(res);
  } catch(err){ next(err); }
});

// ─── DELETE /api/documents/:id ────────────────────────────────────────────────
router.delete("/:id", authorize("documents","delete"), async (req, res, next) => {
  try {
    const doc = await prisma.document.findUnique({ where:{ id:req.params.id } });
    requireSameOrg(req, doc);

    // Soft delete — conserver le fichier physique pour les factures (piste d'audit légale)
    await prisma.document.update({ where:{ id:req.params.id }, data:{ deletedAt:new Date() } });

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"DOCUMENT_DELETED",
      resource:"document", resourceId:req.params.id, ipAddress:req.ip });

    res.json({ success: true });
  } catch(err){ next(err); }
});

export { router as documentsRouter };
