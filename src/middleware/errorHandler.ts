import type { Request, Response, NextFunction } from "express";

// ─── Erreurs métier structurées ───────────────────────────────────────────────
export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ─── Codes d'erreur standardisés (partagés avec le frontend) ─────────────────
export const Errors = {
  INVALID_CREDENTIALS:  () => new AppError("INVALID_CREDENTIALS",  "Identifiants incorrects.",                           401),
  ACCOUNT_LOCKED:       () => new AppError("ACCOUNT_LOCKED",       "Compte verrouillé. Réessayez dans 15 minutes.",      403),
  ACCOUNT_NOT_VERIFIED: () => new AppError("ACCOUNT_NOT_VERIFIED", "Email non vérifié. Vérifiez votre boîte mail.",      403),
  EMAIL_EXISTS:         () => new AppError("EMAIL_ALREADY_EXISTS",  "Cet email est déjà utilisé.",                        409),
  INVALID_2FA:          () => new AppError("INVALID_2FA_CODE",     "Code 2FA invalide ou expiré.",                       401),
  TOKEN_EXPIRED:        () => new AppError("TOKEN_EXPIRED",        "Lien expiré. Faites une nouvelle demande.",          401),
  VALIDATION:           (msg: string) => new AppError("VALIDATION_ERROR", msg,                                           422),
  UNAUTHORIZED:         () => new AppError("UNAUTHORIZED",         "Non autorisé.",                                      401),
  NOT_FOUND:            () => new AppError("NOT_FOUND",            "Ressource introuvable.",                             404),
  SERVER:               () => new AppError("SERVER_ERROR",         "Erreur serveur. Réessayez dans quelques instants.", 500),
  FORBIDDEN:            () => new AppError("FORBIDDEN",             "Accès refusé.",                                     403),
  EMAIL_ALREADY_EXISTS: () => new AppError("EMAIL_ALREADY_EXISTS",  "Cet email est déjà utilisé.",                       409),
  PLAN_LIMIT:           (msg: string) => new AppError("PLAN_LIMIT", msg,                                                 403),
};

// ─── Middleware global de gestion d'erreurs ───────────────────────────────────
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  // Erreur métier connue → réponse structurée propre
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
    });
  }

  // Erreur Zod (validation)
  if (err.name === "ZodError") {
    return res.status(422).json({
      code: "VALIDATION_ERROR",
      message: "Données invalides.",
      details: (err as any).errors?.map((e: any) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    });
  }

  // Erreur Prisma connue (contrainte unique, foreign key, colonne manquante…)
  if (err.constructor?.name === "PrismaClientKnownRequestError") {
    const pe = err as any;
    console.error("[PRISMA ERROR]", pe.code, pe.meta, pe.message);
    if (pe.code === "P2002") {
      return res.status(409).json({ code: "DUPLICATE", message: "Cette valeur existe déjà." });
    }
    if (pe.code === "P2025") {
      return res.status(404).json({ code: "NOT_FOUND", message: "Ressource introuvable." });
    }
  }

  if (err.constructor?.name === "PrismaClientValidationError") {
    console.error("[PRISMA VALIDATION]", err.message);
    return res.status(422).json({ code: "VALIDATION_ERROR", message: "Données invalides." });
  }

  // Erreur inconnue — NE PAS révéler les détails en production
  console.error("[SERVER ERROR]", err);
  return res.status(500).json({
    code: "SERVER_ERROR",
    message: "Erreur serveur. Notre équipe a été notifiée.",
  });
}
