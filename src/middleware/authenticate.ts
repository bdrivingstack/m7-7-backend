import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { Errors } from "./errorHandler.js";

// ─── Extension du type Request Express ───────────────────────────────────────
// On attache l'utilisateur courant à chaque requête authentifiée
declare global {
  namespace Express {
    interface Request {
      user: {
        id:        string;
        firstName: string;
        lastName:  string;
        email:     string;
        role:      string;
        orgId:     string;
        org: {
          id:   string;
          name: string;
          plan: string;
        };
      };
      sessionId: string;
    }
  }
}

// ─── MIDDLEWARE AUTHENTICATE ──────────────────────────────────────────────────
// À placer sur toutes les routes protégées : router.use(authenticate)
// Vérifie le cookie HttpOnly "session_token" en base de données
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // 1. Récupérer le token depuis le cookie HttpOnly
    //    (jamais depuis Authorization header ou localStorage — sécurité XSS)
    const sessionToken = req.cookies?.session_token;

    if (!sessionToken) {
      throw Errors.UNAUTHORIZED();
    }

    // 2. Vérifier la session en base (lookup DB — plus sûr qu'un JWT stateless
    //    car on peut invalider instantanément en cas de compromission)
    const session = await prisma.session.findUnique({
      where: { token: sessionToken },
      include: {
        user: {
          select: {
            id:          true,
            firstName:   true,
            lastName:    true,
            email:       true,
            role:        true,
            orgId:       true,
            isVerified:  true,
            lockedUntil: true,
            org: {
              select: { id: true, name: true, plan: true },
            },
          },
        },
      },
    });

    // 3. Session introuvable ou expirée
    if (!session) {
      throw Errors.UNAUTHORIZED();
    }

    if (session.expiresAt < new Date()) {
      // Nettoyer la session expirée
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
      res.clearCookie("session_token");
      throw Errors.TOKEN_EXPIRED();
    }

    // 4. Compte verrouillé ou non vérifié
    if (session.user.lockedUntil && session.user.lockedUntil > new Date()) {
      throw Errors.ACCOUNT_LOCKED();
    }

    if (!session.user.isVerified) {
      throw Errors.ACCOUNT_NOT_VERIFIED();
    }

    // 5. Attacher l'utilisateur à la requête pour les middlewares suivants
    req.user      = session.user;
    req.sessionId = session.id;

    // 6. Sliding session — renouveler l'expiration si elle se rapproche
    //    (si < 2 jours restants → repousser à 7 jours)
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    if (session.expiresAt.getTime() - Date.now() < twoDaysMs) {
      await prisma.session.update({
        where: { id: session.id },
        data:  { expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      }).catch(() => {});
    }

    next();

  } catch (err) {
    next(err);
  }
}
