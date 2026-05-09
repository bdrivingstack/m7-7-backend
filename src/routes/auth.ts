import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import { prisma } from "../lib/prisma.js";
import { encrypt, decrypt, generateSecureToken } from "../lib/security.js";
import { Errors, AppError } from "../middleware/errorHandler.js";
import { loginLimiter, registerLimiter, forgotPasswordLimiter } from "../middleware/rateLimiter.js";
import {
  RegisterSchema, LoginSchema, MfaVerifySchema,
  ForgotPasswordSchema, ResetPasswordSchema,
} from "../lib/validation.js";
import { sendVerificationEmail, sendPasswordResetEmail, sendAccountAlreadyExistsEmail } from "../lib/emailService.js";

const router = Router();

// ─── CONSTANTES SÉCURITÉ ─────────────────────────────────────────────────────
const BCRYPT_ROUNDS       = 12;       // Coût bcrypt — ~250ms par hash
const JWT_SECRET          = process.env.JWT_SECRET || "CHANGE_THIS_IN_PRODUCTION_MINIMUM_32_CHARS";
const JWT_EXPIRES_IN      = "15m";    // Access token courte durée
const REFRESH_EXPIRES_IN  = "7d";     // Refresh token longue durée
const MAX_LOGIN_ATTEMPTS  = 5;        // Avant verrouillage
const LOCK_DURATION_MIN   = 15;       // Minutes de verrouillage
const isProd = process.env.NODE_ENV === "production";
const COOKIE_OPTS = {
  httpOnly: true,
  secure:   isProd,
  sameSite: (isProd ? "none" : "lax") as "none" | "lax",
  path:     "/",
};

// ─── HELPER : Réponse erreur identifiants (toujours le même message) ─────────
// Ne jamais dire "email inconnu" ou "mauvais mot de passe" → évite l'énumération
function invalidCredentials() { throw Errors.INVALID_CREDENTIALS(); }

// ─── HELPER : Log d'audit ────────────────────────────────────────────────────
async function auditLog(params: {
  userId?: string; orgId?: string; action: string;
  resource?: string; ipAddress?: string; userAgent?: string; detail?: string;
}) {
  try {
    await prisma.auditLog.create({ data: params });
  } catch { /* Log non bloquant */ }
}

// ─── INSCRIPTION ─────────────────────────────────────────────────────────────
router.post("/register", registerLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Validation Zod
    const body = RegisterSchema.parse(req.body);

    // 2. Email déjà utilisé ? (réponse vague pour ne pas révéler les comptes existants)
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      // Sécurité : ne jamais révéler qu'un compte existe côté frontend
      // On envoie un email discret à l'utilisateur existant
      try {
        await sendAccountAlreadyExistsEmail({ to: existing.email, firstName: existing.firstName });
      } catch (emailErr) {
        console.error("[EMAIL] Erreur envoi compte existant :", emailErr);
      }
      return res.status(200).json({
        message: "Si cet email n'est pas encore utilisé, vous recevrez un email de confirmation.",
      });
    }

    // 3. Hachage bcrypt du mot de passe (jamais stocké en clair)
    const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);

    // 4. Créer l'organisation et l'utilisateur (owner)
    const isDev = process.env.NODE_ENV !== "production";
    const org = await prisma.org.create({
      data: {
        name:      body.company,
        plan:      "MICRO",
        trialEnds: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 jours
        users: {
          create: {
            firstName:    body.firstName,
            lastName:     body.lastName,
            email:        body.email,
            passwordHash,
            role:         "OWNER",
            isVerified:   isDev, // Auto-vérifié en dev, sinon via lien email
          },
        },
      },
      include: { users: true },
    });

    const user = org.users[0];

    // 5. Token de vérification email (expiration 24h)
    const verifyToken = generateSecureToken();
    await prisma.verificationToken.create({
      data: {
        userId:    user.id,
        token:     verifyToken,
        type:      "EMAIL_VERIFY",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    // 6. Audit log
    await auditLog({
      userId: user.id, orgId: org.id,
      action: "REGISTER",
      ipAddress: req.ip,
      userAgent: req.get("User-Agent"),
      detail: `Inscription : ${user.email}`,
    });

    // 7. Envoyer l'email de vérification
    // Toujours logguer le lien pour pouvoir vérifier manuellement via les logs Railway
    console.log(`[VERIFY] ${user.email} → ${process.env.FRONTEND_URL}/verify-email?token=${verifyToken}`);
    try {
      const emailResult = await sendVerificationEmail({
        to:        user.email,
        firstName: user.firstName,
        token:     verifyToken,
      });
      if (emailResult.success) {
        console.log(`[EMAIL] ✅ Email vérification envoyé à ${user.email} (id: ${emailResult.id})`);
      } else {
        console.error(`[EMAIL] ❌ Échec envoi à ${user.email} :`, emailResult.error);
      }
    } catch (emailErr) {
      console.error("[EMAIL] Erreur envoi vérification :", emailErr);
    }

    return res.status(201).json({
      message: "Compte créé ! Vérifiez votre boîte mail pour activer votre compte.",
    });

  } catch (err) {
    next(err);
  }
});

// ─── CONNEXION ────────────────────────────────────────────────────────────────
router.post("/login", loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Validation Zod
    const body = LoginSchema.parse(req.body);

    // 2. Trouver l'utilisateur
    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { org: true },
    });

    // Si l'utilisateur n'existe pas → même délai qu'un vrai bcrypt pour éviter le timing attack
    if (!user) {
      await bcrypt.hash(body.password, BCRYPT_ROUNDS); // Faux hash pour timing constant
      return invalidCredentials();
    }

    // 3. Compte verrouillé ?
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await auditLog({ userId: user.id, orgId: user.orgId, action: "LOGIN_BLOCKED_LOCKED", ipAddress: req.ip });
      throw Errors.ACCOUNT_LOCKED();
    }

    // 4. Vérification mot de passe (bcrypt.compare — timing constant)
    const pwdOk = await bcrypt.compare(body.password, user.passwordHash);

    if (!pwdOk) {
      // Incrémenter les tentatives
      const newAttempts = user.loginAttempts + 1;
      const shouldLock  = newAttempts >= MAX_LOGIN_ATTEMPTS;

      await prisma.user.update({
        where: { id: user.id },
        data: {
          loginAttempts: newAttempts,
          lockedUntil: shouldLock
            ? new Date(Date.now() + LOCK_DURATION_MIN * 60 * 1000)
            : null,
        },
      });

      await auditLog({
        userId: user.id, orgId: user.orgId,
        action: shouldLock ? "ACCOUNT_LOCKED" : "LOGIN_FAILED",
        ipAddress: req.ip, userAgent: req.get("User-Agent"),
        detail: `Tentative ${newAttempts}/${MAX_LOGIN_ATTEMPTS}`,
      });

      if (shouldLock) throw Errors.ACCOUNT_LOCKED();
      return invalidCredentials();
    }

    // 5. Email vérifié ?
    if (!user.isVerified) {
      throw Errors.ACCOUNT_NOT_VERIFIED();
    }

    // 6. Reset les tentatives après succès
    await prisma.user.update({
      where: { id: user.id },
      data: { loginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: req.ip },
    });

    // 7. 2FA requis ?
    if (user.isMfaEnabled) {
      // Token temporaire pour l'étape 2FA (stocké en cookie short-lived)
      const preAuthToken = jwt.sign(
        { userId: user.id, orgId: user.orgId, type: "PRE_AUTH" },
        JWT_SECRET,
        { expiresIn: "5m" },
      );
      res.cookie("pre_auth_token", preAuthToken, { ...COOKIE_OPTS, maxAge: 5 * 60 * 1000 });
      return res.json({ requiresMfa: true });
    }

    // 8. Créer la session et les cookies
    await createSession(user, req, res);

    await auditLog({
      userId: user.id, orgId: user.orgId,
      action: "LOGIN_SUCCESS",
      ipAddress: req.ip, userAgent: req.get("User-Agent"),
    });

    return res.json({ success: true, requiresMfa: false });

  } catch (err) {
    next(err);
  }
});

// ─── VÉRIFICATION 2FA ─────────────────────────────────────────────────────────
router.post("/2fa/verify", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = MfaVerifySchema.parse(req.body);

    // Récupérer le token pre-auth du cookie
    const preAuthToken = req.cookies?.pre_auth_token;
    if (!preAuthToken) throw Errors.UNAUTHORIZED();

    let payload: any;
    try {
      payload = jwt.verify(preAuthToken, JWT_SECRET);
    } catch {
      throw Errors.TOKEN_EXPIRED();
    }

    if (payload.type !== "PRE_AUTH") throw Errors.UNAUTHORIZED();

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || !user.mfaSecret) throw Errors.UNAUTHORIZED();

    // Vérifier le code TOTP
    const secret = decrypt(user.mfaSecret); // Déchiffre le secret AES-256
    const isValid = authenticator.verify({ token: code, secret });

    if (!isValid) {
      await auditLog({ userId: user.id, orgId: user.orgId, action: "MFA_FAILED", ipAddress: req.ip });
      throw Errors.INVALID_2FA();
    }

    // Supprimer le pre-auth cookie
    res.clearCookie("pre_auth_token");

    // Créer la session complète
    await createSession(user, req, res);

    await auditLog({
      userId: user.id, orgId: user.orgId,
      action: "MFA_SUCCESS", ipAddress: req.ip,
    });

    return res.json({ success: true });

  } catch (err) {
    next(err);
  }
});

// ─── DÉCONNEXION ─────────────────────────────────────────────────────────────
router.post("/logout", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.session_token;
    if (token) {
      // Invalider la session en base
      await prisma.session.deleteMany({ where: { token } }).catch(() => {});
    }
    res.clearCookie("session_token");
    res.clearCookie("refresh_token");
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── MOT DE PASSE OUBLIÉ ──────────────────────────────────────────────────────
router.post("/forgot-password", forgotPasswordLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = ForgotPasswordSchema.parse(req.body);

    // Toujours répondre 200 — ne jamais révéler si l'email existe
    const GENERIC_RESPONSE = {
      message: "Si cet email est associé à un compte, vous recevrez un lien dans quelques minutes.",
    };

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json(GENERIC_RESPONSE); // Silencieux

    // Invalider les anciens tokens
    await prisma.verificationToken.updateMany({
      where: { userId: user.id, type: "PASSWORD_RESET", usedAt: null },
      data: { usedAt: new Date() },
    });

    // Créer le nouveau token (expiration 15 minutes)
    const resetToken = generateSecureToken();
    await prisma.verificationToken.create({
      data: {
        userId:    user.id,
        token:     resetToken,
        type:      "PASSWORD_RESET",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    try {
      await sendPasswordResetEmail({
        to:        user.email,
        firstName: user.firstName,
        token:     resetToken,
      });
    } catch (emailErr) {
      console.error("[EMAIL] Erreur envoi reset password :", emailErr);
      console.log(`[DEV] Reset link: ${process.env.FRONTEND_URL}/forgot-password?token=${resetToken}`);
    }

    await auditLog({ userId: user.id, orgId: user.orgId, action: "PASSWORD_RESET_REQUESTED", ipAddress: req.ip });

    return res.json(GENERIC_RESPONSE);

  } catch (err) {
    next(err);
  }
});

// ─── RÉINITIALISATION MOT DE PASSE ───────────────────────────────────────────
router.post("/reset-password", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = ResetPasswordSchema.parse(req.body);

    const record = await prisma.verificationToken.findUnique({ where: { token } });

    if (!record || record.type !== "PASSWORD_RESET" || record.usedAt || record.expiresAt < new Date()) {
      throw Errors.TOKEN_EXPIRED();
    }

    // Hacher le nouveau mot de passe
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Mettre à jour + invalider le token + invalider toutes les sessions actives
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash, loginAttempts: 0, lockedUntil: null } }),
      prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.session.deleteMany({ where: { userId: record.userId } }), // Forcer reconnexion partout
    ]);

    await auditLog({ userId: record.userId, action: "PASSWORD_RESET_SUCCESS", ipAddress: req.ip });

    return res.json({ message: "Mot de passe réinitialisé avec succès." });

  } catch (err) {
    next(err);
  }
});

// ─── VÉRIFICATION EMAIL ───────────────────────────────────────────────────────
router.get("/verify-email", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.query.token as string;
    if (!token) throw Errors.VALIDATION("Token manquant.");

    const record = await prisma.verificationToken.findUnique({ where: { token } });
    if (!record || record.type !== "EMAIL_VERIFY" || record.usedAt || record.expiresAt < new Date()) {
      throw Errors.TOKEN_EXPIRED();
    }

    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { isVerified: true } }),
      prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);

    // Redirect frontend
    return res.redirect(`${process.env.FRONTEND_URL}/login?verified=true`);

  } catch (err) {
    next(err);
  }
});

// ─── HELPER : Créer session + cookies ────────────────────────────────────────
async function createSession(user: any, req: Request, res: Response) {
  // Token de session (stocké en DB + cookie HttpOnly)
  const sessionToken = generateSecureToken(64);

  await prisma.session.create({
    data: {
      userId:    user.id,
      orgId:     user.orgId,
      token:     sessionToken,
      userAgent: req.get("User-Agent"),
      ipAddress: req.ip,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 jours
    },
  });

  // Cookie session HttpOnly — JAMAIS accessible depuis JS
  res.cookie("session_token", sessionToken, {
    ...COOKIE_OPTS,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

// ─── SESSION COURANTE (/me) ───────────────────────────────────────────────────
// Appelée par AuthContext au démarrage pour savoir si l'utilisateur est connecté
router.get("/me", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.session_token;
    if (!token) return res.status(401).json({ message: "Non authentifié" });

    // Vérifier la session en base
    const session = await prisma.session.findUnique({
      where:   { token },
      include: {
        user: {
          include: { org: { select: { id: true, name: true, legalForm: true, plan: true } } },
        },
      },
    });

    if (!session || session.expiresAt < new Date()) {
      res.clearCookie("session_token");
      return res.status(401).json({ message: "Session expirée" });
    }

    // Session valide — on continue

    const { user } = session;
    return res.json({
      user: {
        id:        user.id,
        email:     user.email,
        firstName: user.firstName,
        lastName:  user.lastName,
        role:      user.role,
        orgId:     user.orgId,
        orgName:   user.org.name,
        legalForm: user.org.legalForm,
        plan:      user.org.plan,
        avatarUrl: user.avatarUrl ?? undefined,
      },
    });
  } catch (err) {
    next(err);
  }
});

export { router as authRouter };
