import { Router, type Request, type Response, type NextFunction } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize, requireRole, requireSameOrg, can } from "../middleware/authorize.js";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../middleware/errorHandler.js";
import { z } from "zod";

const router = Router();

// ─── TOUTES LES ROUTES CI-DESSOUS SONT PROTÉGÉES ────────────────────────────
// authenticate vérifie le cookie de session sur CHAQUE requête
router.use(authenticate);

// ────────────────────────────────────────────────────────────────────────────
// EXEMPLE 1 — Route simple, tout utilisateur connecté peut y accéder
// GET /api/me  →  Retourne l'utilisateur courant
// ────────────────────────────────────────────────────────────────────────────
router.get("/me", async (req: Request, res: Response, next: NextFunction) => {
  try {
    // req.user est attaché par authenticate — pas besoin de DB
    res.json({
      id:        req.user.id,
      firstName: req.user.firstName,
      lastName:  req.user.lastName,
      email:     req.user.email,
      role:      req.user.role,
      org:       req.user.org,
      // Retourner les permissions calculées pour le frontend
      permissions: {
        canCreateInvoice:  can(req.user.role, "invoices",  "create"),
        canDeleteInvoice:  can(req.user.role, "invoices",  "delete"),
        canManageUsers:    can(req.user.role, "users",     "create"),
        canViewReports:    can(req.user.role, "reports",   "read"),
        canAccessBilling:  can(req.user.role, "billing",   "read"),
        canViewAuditLogs:  can(req.user.role, "audit-logs","read"),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// EXEMPLE 2 — Lecture (VIEWER et plus)
// GET /api/invoices  →  Liste les factures de l'organisation
// ────────────────────────────────────────────────────────────────────────────
router.get(
  "/invoices",
  authorize("invoices", "read"),   // ← VIEWER, ACCOUNTANT, MANAGER, ADMIN, OWNER
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // req.user.orgId garantit l'isolation multi-tenant
      // L'utilisateur ne voit QUE les factures de son organisation
      const invoices = await prisma.auditLog.findMany({
        where: { orgId: req.user.orgId },  // ← isolation tenant
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      res.json({ data: invoices });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// EXEMPLE 3 — Création (ACCOUNTANT et plus)
// POST /api/invoices
// ────────────────────────────────────────────────────────────────────────────
router.post(
  "/invoices",
  authorize("invoices", "create"),  // ← ACCOUNTANT, MANAGER, ADMIN, OWNER
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validation Zod
      const body = z.object({
        customerId: z.string().cuid(),
        amount:     z.number().positive().max(10_000_000),
        dueDate:    z.string().datetime(),
      }).parse(req.body);

      // orgId TOUJOURS depuis req.user — jamais depuis le body (sécurité)
      // Un utilisateur malveillant ne peut pas créer une facture dans une autre org
      console.log(`[INVOICE CREATE] orgId: ${req.user.orgId}, by: ${req.user.email}`);

      res.status(201).json({ message: "Facture créée (démo).", data: body });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// EXEMPLE 4 — Suppression avec vérification d'appartenance (ADMIN+)
// DELETE /api/invoices/:id
// ────────────────────────────────────────────────────────────────────────────
router.delete(
  "/invoices/:id",
  authorize("invoices", "delete"),   // ← ADMIN, OWNER uniquement
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // TODO: const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });

      // requireSameOrg vérifie que cette facture appartient bien à l'org de l'utilisateur
      // Si l'invoice appartient à une autre org → 404 (ne pas révéler l'existence)
      // requireSameOrg(req, invoice);

      // await prisma.invoice.delete({ where: { id: req.params.id } });

      res.json({ message: "Facture supprimée (démo)." });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// EXEMPLE 5 — Route réservée OWNER uniquement
// DELETE /api/org   →  Supprimer l'organisation
// ────────────────────────────────────────────────────────────────────────────
router.delete(
  "/org",
  requireRole("OWNER"),   // ← OWNER uniquement — authorize() hiérarchique
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Seul l'OWNER peut supprimer son organisation
      // Prisma cascade supprime tout (users, sessions, etc. — voir schema.prisma)
      // await prisma.org.delete({ where: { id: req.user.orgId } });
      res.json({ message: "Organisation supprimée (démo)." });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// EXEMPLE 6 — Gestion utilisateurs (ADMIN+)
// GET /api/users  →  Liste des utilisateurs de l'organisation
// ────────────────────────────────────────────────────────────────────────────
router.get(
  "/users",
  authorize("users", "read"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const users = await prisma.user.findMany({
        where:  { orgId: req.user.orgId },   // ← isolation tenant toujours
        select: {
          id:          true,
          firstName:   true,
          lastName:    true,
          email:       true,
          role:        true,
          isVerified:  true,
          isMfaEnabled:true,
          lastLoginAt: true,
          createdAt:   true,
          // passwordHash: false — JAMAIS renvoyé
        },
        orderBy: { createdAt: "asc" },
      });
      res.json({ data: users });
    } catch (err) {
      next(err);
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// EXEMPLE 7 — Logs d'audit (ADMIN+ seulement)
// GET /api/audit-logs
// ────────────────────────────────────────────────────────────────────────────
router.get(
  "/audit-logs",
  authorize("audit-logs", "read"),   // ← ADMIN, OWNER
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const logs = await prisma.auditLog.findMany({
        where:   { orgId: req.user.orgId },
        orderBy: { createdAt: "desc" },
        take:    100,
      });
      res.json({ data: logs });
    } catch (err) {
      next(err);
    }
  },
);

export { router as protectedRouter };
