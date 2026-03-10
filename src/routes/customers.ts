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

const CustomerSchema = z.object({
  name:               z.string().min(1).max(200).trim(),
  firstName:          z.string().max(100).optional(),
  lastName:           z.string().max(100).optional(),
  isCompany:          z.boolean().default(true),
  reference:          z.string().max(50).optional(),
  siret:              z.string().max(14).optional(),
  siren:              z.string().max(9).optional(),
  tvaNumber:          z.string().max(20).optional(),
  nafCode:            z.string().max(10).optional(),
  email:              z.string().email().optional().or(z.literal("")),
  phone:              z.string().max(20).optional(),
  website:            z.string().url().optional().or(z.literal("")),
  address:            z.string().max(200).optional(),
  address2:           z.string().max(200).optional(),
  city:               z.string().max(100).optional(),
  postalCode:         z.string().max(10).optional(),
  country:            z.string().length(2).default("FR"),
  deliveryAddress:    z.string().max(200).optional(),
  deliveryCity:       z.string().max(100).optional(),
  deliveryPostalCode: z.string().max(10).optional(),
  deliveryCountry:    z.string().length(2).optional(),
  defaultVatRate:     z.number().min(0).max(100).optional(),
  defaultPaymentTerms:z.number().int().min(0).max(365).optional(),
  creditLimit:        z.number().min(0).optional(),
  currency:           z.string().length(3).default("EUR"),
  discount:           z.number().min(0).max(100).optional(),
  portalEnabled:      z.boolean().default(false),
  portalEmail:        z.string().email().optional().or(z.literal("")),
  notes:              z.string().max(2000).optional(),
  tags:               z.array(z.string().max(50)).max(20).default([]),
});

const ContactSchema = z.object({
  firstName: z.string().min(1).max(100).trim(),
  lastName:  z.string().min(1).max(100).trim(),
  email:     z.string().email().optional().or(z.literal("")),
  phone:     z.string().max(20).optional(),
  role:      z.string().max(100).optional(),
  isPrimary: z.boolean().default(false),
});

const PaginationSchema = z.object({
  page:    z.coerce.number().int().min(1).default(1),
  limit:   z.coerce.number().int().min(1).max(100).default(20),
  search:  z.string().max(100).optional(),
  sortBy:  z.enum(["name", "createdAt", "balance"]).default("name"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
});

// ─── GET /api/customers ───────────────────────────────────────────────────────

router.get("/", authorize("customers", "read"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit, search, sortBy, sortDir } = PaginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const where = {
      orgId:     req.user.orgId,
      deletedAt: null,
      ...(search && {
        OR: [
          { name:  { contains: search, mode: "insensitive" as const } },
          { email: { contains: search, mode: "insensitive" as const } },
          { siret: { contains: search } },
          { siren: { contains: search } },
        ],
      }),
    };

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where, skip, take: limit,
        orderBy: { [sortBy]: sortDir },
        select: {
          id: true, name: true, email: true, phone: true,
          siret: true, siren: true, isCompany: true,
          city: true, country: true, balance: true,
          portalEnabled: true, tags: true, createdAt: true,
          _count: { select: { invoices: true, quotes: true } },
        },
      }),
      prisma.customer.count({ where }),
    ]);

    res.json({
      data: customers,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/customers/:id ───────────────────────────────────────────────────

router.get("/:id", authorize("customers", "read"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      include: {
        contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        _count: { select: { invoices: true, quotes: true, payments: true } },
      },
    });
    requireSameOrg(req, customer);
    res.json({ data: customer });
  } catch (err) { next(err); }
});

// ─── POST /api/customers ──────────────────────────────────────────────────────

router.post("/", authorize("customers", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CustomerSchema.parse(req.body);

    const customer = await prisma.customer.create({
      data: { ...body, orgId: req.user.orgId }, // orgId TOUJOURS depuis req.user
    });

    await auditLog({ userId: req.user.id, orgId: req.user.orgId,
      action: "CUSTOMER_CREATED", resource: "customer", resourceId: customer.id,
      ipAddress: req.ip });

    res.status(201).json({ data: customer });
  } catch (err) { next(err); }
});

// ─── PATCH /api/customers/:id ─────────────────────────────────────────────────

router.patch("/:id", authorize("customers", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.customer.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);

    const body = CustomerSchema.partial().parse(req.body);
    const customer = await prisma.customer.update({ where: { id: req.params.id }, data: body });

    await auditLog({ userId: req.user.id, orgId: req.user.orgId,
      action: "CUSTOMER_UPDATED", resource: "customer", resourceId: customer.id,
      ipAddress: req.ip });

    res.json({ data: customer });
  } catch (err) { next(err); }
});

// ─── DELETE /api/customers/:id (soft delete) ──────────────────────────────────

router.delete("/:id", authorize("customers", "delete"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.customer.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, existing);

    // Soft delete — conservation historique comptable
    await prisma.customer.update({
      where: { id: req.params.id },
      data:  { deletedAt: new Date() },
    });

    await auditLog({ userId: req.user.id, orgId: req.user.orgId,
      action: "CUSTOMER_DELETED", resource: "customer", resourceId: req.params.id,
      ipAddress: req.ip });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── CONTACTS ─────────────────────────────────────────────────────────────────

router.post("/:id/contacts", authorize("customers", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, customer);

    const body = ContactSchema.parse(req.body);

    // Si isPrimary, retirer l'ancien primary
    if (body.isPrimary) {
      await prisma.customerContact.updateMany({
        where: { customerId: req.params.id },
        data:  { isPrimary: false },
      });
    }

    const contact = await prisma.customerContact.create({
      data: { ...body, customerId: req.params.id },
    });

    res.status(201).json({ data: contact });
  } catch (err) { next(err); }
});

router.delete("/:id/contacts/:contactId", authorize("customers", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    requireSameOrg(req, customer);
    await prisma.customerContact.delete({ where: { id: req.params.contactId } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export { router as customersRouter };
