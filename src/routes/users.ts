import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize, requireSameOrg } from "../middleware/authorize.js";
import { auditLog } from "../lib/audit.js";
import { Errors } from "../middleware/errorHandler.js";

const router = Router();
router.use(authenticate);

const InviteSchema = z.object({
  firstName: z.string().min(1).max(100).trim(),
  lastName:  z.string().min(1).max(100).trim(),
  email:     z.string().email().toLowerCase(),
  role:      z.enum(["ADMIN","ACCOUNTANT","MANAGER","VIEWER"]), // Pas OWNER via invite
});

const UpdateUserSchema = z.object({
  firstName:  z.string().min(1).max(100).trim().optional(),
  lastName:   z.string().min(1).max(100).trim().optional(),
  role:       z.enum(["ADMIN","ACCOUNTANT","MANAGER","VIEWER"]).optional(),
  phone:      z.string().max(20).optional(),
  timezone:   z.string().optional(),
  notifyInvoicePaid:   z.boolean().optional(),
  notifyQuoteAccepted: z.boolean().optional(),
  notifyOverdue:       z.boolean().optional(),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword:     z.string().min(12).max(128)
    .regex(/[A-Z]/, "Doit contenir une majuscule")
    .regex(/[0-9]/, "Doit contenir un chiffre")
    .regex(/[^A-Za-z0-9]/, "Doit contenir un caractère spécial"),
});

// ─── GET /api/users ────────────────────────────────────────────────────────────
// ADMIN+ seulement — liste les users de l'org
router.get("/", authorize("users","read"), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where:  { orgId: req.user.orgId },
      select: { id:true, firstName:true, lastName:true, email:true, role:true,
        isVerified:true, isMfaEnabled:true, lastLoginAt:true, createdAt:true },
      orderBy:{ createdAt:"asc" },
    });
    res.json({ data: users });
  } catch(err){ next(err); }
});

// ─── GET /api/users/me ─────────────────────────────────────────────────────────
router.get("/me", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { id:true, firstName:true, lastName:true, email:true, role:true,
        phone:true, avatarUrl:true, timezone:true, locale:true,
        isVerified:true, isMfaEnabled:true, lastLoginAt:true,
        notifyInvoicePaid:true, notifyQuoteAccepted:true, notifyOverdue:true,
        orgId:true, org:{ select:{ id:true, name:true, plan:true, logoUrl:true, primaryColor:true } } },
    });
    res.json({ data: user });
  } catch(err){ next(err); }
});

// ─── PATCH /api/users/me ───────────────────────────────────────────────────────
router.patch("/me", async (req, res, next) => {
  try {
    const body = UpdateUserSchema.omit({ role:true }).parse(req.body); // Ne peut pas changer son propre rôle
    const user = await prisma.user.update({ where:{ id:req.user.id }, data: body,
      select:{ id:true, firstName:true, lastName:true, email:true, role:true, phone:true, timezone:true } });
    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"PROFILE_UPDATED", ipAddress:req.ip, userAgent:req.get("User-Agent"), detail: Object.keys(body).join(", ") });
    res.json({ data: user });
  } catch(err){ next(err); }
});

// ─── POST /api/users/me/change-password ───────────────────────────────────────
router.post("/me/change-password", async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where:{ id:req.user.id } });

    const valid = await bcrypt.compare(currentPassword, user!.passwordHash);
    if (!valid) throw Errors.INVALID_CREDENTIALS();

    const newHash = await bcrypt.hash(newPassword, 12);
    await prisma.$transaction([
      prisma.user.update({ where:{ id:req.user.id }, data:{ passwordHash:newHash } }),
      // Invalider toutes les sessions (sécurité)
      prisma.session.deleteMany({ where:{ userId:req.user.id } }),
    ]);

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"PASSWORD_CHANGED", ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ success:true, message:"Mot de passe modifié. Reconnectez-vous." });
  } catch(err){ next(err); }
});

// ─── POST /api/users/invite ────────────────────────────────────────────────────
// ADMIN+ — inviter un nouveau membre dans l'org
router.post("/invite", authorize("users","create"), async (req, res, next) => {
  try {
    const body = InviteSchema.parse(req.body);

    // Vérifier que l'email n'existe pas déjà
    const existing = await prisma.user.findUnique({ where:{ email:body.email } });
    if (existing) throw Errors.EMAIL_ALREADY_EXISTS();

    // Limites selon le plan
    const org      = await prisma.org.findUnique({ where:{ id:req.user.orgId } });
    const count    = await prisma.user.count({ where:{ orgId:req.user.orgId } });
    const limits:Record<string,number> = { MICRO:2, PRO:5, BUSINESS:20, EXPERT:999 };
    if (count >= (limits[org!.plan] || 2)) {
      throw Errors.PLAN_LIMIT("Limite d'utilisateurs atteinte pour votre plan.");
    }

    // Créer l'user avec un mot de passe temporaire
    const tempPassword = Math.random().toString(36).slice(2,12) + "A1!";
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await prisma.user.create({ data: {
      ...body, orgId:req.user.orgId, passwordHash, isVerified:false,
    }});

    // TODO: Envoyer email d'invitation avec lien de définition de mot de passe

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"USER_INVITED",
      resource:"user", resourceId:user.id, detail:body.email, ipAddress:req.ip, userAgent:req.get("User-Agent") });

    res.status(201).json({ data:{ id:user.id, email:user.email, role:user.role } });
  } catch(err){ next(err); }
});

// ─── PATCH /api/users/:id ─────────────────────────────────────────────────────
// ADMIN+ — modifier rôle / infos d'un autre user
router.patch("/:id", authorize("users","update"), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where:{ id:req.params.id } });
    requireSameOrg(req, target);
    if (target!.role === "OWNER" && req.user.role !== "OWNER") throw Errors.FORBIDDEN();

    const body = UpdateUserSchema.parse(req.body);
    const user = await prisma.user.update({ where:{ id:req.params.id }, data:body,
      select:{ id:true, firstName:true, lastName:true, email:true, role:true } });

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"USER_UPDATED",
      resource:"user", resourceId:user.id, ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ data: user });
  } catch(err){ next(err); }
});

// ─── DELETE /api/users/:id ─────────────────────────────────────────────────────
// ADMIN+ — supprimer un membre (pas OWNER)
router.delete("/:id", authorize("users","delete"), async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) throw new Error("Vous ne pouvez pas supprimer votre propre compte.");
    const target = await prisma.user.findUnique({ where:{ id:req.params.id } });
    requireSameOrg(req, target);
    if (target!.role === "OWNER") throw Errors.FORBIDDEN();

    // Invalider les sessions, puis supprimer
    await prisma.$transaction([
      prisma.session.deleteMany({ where:{ userId:req.params.id } }),
      prisma.user.delete({ where:{ id:req.params.id } }),
    ]);

    await auditLog({ userId:req.user.id, orgId:req.user.orgId, action:"USER_DELETED",
      resource:"user", resourceId:req.params.id, ipAddress:req.ip, userAgent:req.get("User-Agent") });
    res.json({ success: true });
  } catch(err){ next(err); }
});

export { router as usersRouter };
