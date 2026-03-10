import type { Request, Response, NextFunction } from "express";
import { Errors } from "./errorHandler.js";

// ─── HIÉRARCHIE DES RÔLES ─────────────────────────────────────────────────────
//
//   OWNER  →  Tout (supprimer l'org, gérer la facturation, tous les droits)
//   ADMIN  →  Tout sauf supprimer l'org et changer le plan
//   MANAGER    →  Lire + créer + modifier (pas supprimer les utilisateurs)
//   ACCOUNTANT →  Factures, devis, paiements, rapports (pas gestion utilisateurs)
//   VIEWER →  Lecture seule
//
// La hiérarchie est CUMULATIVE : OWNER a tous les droits des rôles inférieurs.

export type Role = "OWNER" | "ADMIN" | "MANAGER" | "ACCOUNTANT" | "VIEWER";

const ROLE_HIERARCHY: Record<Role, number> = {
  OWNER:      5,
  ADMIN:      4,
  MANAGER:    3,
  ACCOUNTANT: 2,
  VIEWER:     1,
};

// ─── PERMISSIONS PAR RESSOURCE ────────────────────────────────────────────────
// Définit qui peut faire quoi sur chaque ressource.
// Utilisé par authorize() et authorizeAction().

export const PERMISSIONS: Record<string, Record<string, Role[]>> = {
  // ── Utilisateurs & Organisation ──────────────────────────────────────────
  users: {
    read:   ["VIEWER", "ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    create: ["ADMIN", "OWNER"],
    update: ["ADMIN", "OWNER"],
    delete: ["OWNER"],
  },
  org: {
    read:   ["VIEWER", "ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    update: ["ADMIN", "OWNER"],
    delete: ["OWNER"],
  },
  billing: {
    read:   ["ADMIN", "OWNER"],
    update: ["OWNER"],
  },

  // ── Clients ──────────────────────────────────────────────────────────────
  customers: {
    read:   ["VIEWER", "ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    create: ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    update: ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    delete: ["MANAGER", "ADMIN", "OWNER"],
  },

  // ── Factures ─────────────────────────────────────────────────────────────
  invoices: {
    read:   ["VIEWER", "ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    create: ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    update: ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    delete: ["ADMIN", "OWNER"],
    send:   ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
  },

  // ── Devis ─────────────────────────────────────────────────────────────────
  quotes: {
    read:   ["VIEWER", "ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    create: ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    update: ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    delete: ["ADMIN", "OWNER"],
    send:   ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
  },

  // ── Paiements ─────────────────────────────────────────────────────────────
  payments: {
    read:   ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    create: ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    refund: ["ADMIN", "OWNER"],
  },

  // ── Rapports ──────────────────────────────────────────────────────────────
  reports: {
    read:   ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    export: ["ACCOUNTANT", "ADMIN", "OWNER"],
  },

  // ── Documents ─────────────────────────────────────────────────────────────
  documents: {
    read:   ["VIEWER", "ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    create: ["ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    delete: ["ADMIN", "OWNER"],
  },

  // ── Paramètres ────────────────────────────────────────────────────────────
  settings: {
    read:   ["VIEWER", "ACCOUNTANT", "MANAGER", "ADMIN", "OWNER"],
    update: ["ADMIN", "OWNER"],
  },

  // ── Logs d'audit ──────────────────────────────────────────────────────────
  "audit-logs": {
    read: ["ADMIN", "OWNER"],
  },

  // ── API Keys ──────────────────────────────────────────────────────────────
  "api-keys": {
    read:   ["ADMIN", "OWNER"],
    create: ["OWNER"],
    delete: ["OWNER"],
  },
};

// ─── MIDDLEWARE : Niveau de rôle minimum ──────────────────────────────────────
// Usage : router.get("/admin", authenticate, requireRole("ADMIN"), handler)
//
// requireRole("ADMIN") → accepte ADMIN et OWNER
// requireRole("OWNER") → accepte OWNER uniquement
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(Errors.UNAUTHORIZED());
    }

    const userLevel = ROLE_HIERARCHY[req.user.role as Role] ?? 0;
    const hasAccess = allowedRoles.some(
      role => userLevel >= ROLE_HIERARCHY[role],
    );

    if (!hasAccess) {
      return next(
        new (Errors.UNAUTHORIZED().constructor as any)(
          "FORBIDDEN",
          `Accès refusé. Rôle requis : ${allowedRoles.join(" ou ")}.`,
          403,
        ),
      );
    }

    next();
  };
}

// ─── MIDDLEWARE : Permission granulaire sur une ressource ─────────────────────
// Usage : router.delete("/invoices/:id", authenticate, authorize("invoices", "delete"), handler)
//
// Vérifie que l'utilisateur a la permission "delete" sur "invoices"
export function authorize(resource: string, action: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(Errors.UNAUTHORIZED());
    }

    const resourcePerms = PERMISSIONS[resource];
    if (!resourcePerms) {
      // Ressource inconnue → refus par défaut (fail-safe)
      return next(
        new (Errors.UNAUTHORIZED().constructor as any)(
          "FORBIDDEN",
          "Ressource inconnue.",
          403,
        ),
      );
    }

    const allowedRoles = resourcePerms[action];
    if (!allowedRoles) {
      return next(
        new (Errors.UNAUTHORIZED().constructor as any)(
          "FORBIDDEN",
          `Action "${action}" non autorisée sur "${resource}".`,
          403,
        ),
      );
    }

    const userRole    = req.user.role as Role;
    const userLevel   = ROLE_HIERARCHY[userRole] ?? 0;
    const hasAccess   = allowedRoles.some(
      role => userLevel >= ROLE_HIERARCHY[role],
    );

    if (!hasAccess) {
      return next(
        new (Errors.UNAUTHORIZED().constructor as any)(
          "FORBIDDEN",
          `Accès refusé. Vous n'avez pas le droit "${action}" sur "${resource}". Votre rôle : ${userRole}.`,
          403,
        ),
      );
    }

    next();
  };
}

// ─── MIDDLEWARE : Isolation multi-tenant ──────────────────────────────────────
// Vérifie que la ressource demandée appartient bien à l'organisation de l'utilisateur.
// À utiliser APRÈS avoir récupéré la ressource depuis la DB.
//
// Usage :
//   const invoice = await prisma.invoice.findUnique({ where: { id } });
//   requireSameOrg(req, invoice);   ← lance une erreur si orgId différent
//
export function requireSameOrg(req: Request, resource: { orgId: string } | null) {
  if (!resource) throw Errors.NOT_FOUND();
  if (resource.orgId !== req.user.orgId) {
    // Ne pas révéler que la ressource existe pour une autre org
    throw Errors.NOT_FOUND();
  }
}

// ─── HELPER : Vérifier une permission sans lancer d'erreur ───────────────────
// Usage : if (can(req.user.role, "invoices", "delete")) { ... }
export function can(role: string, resource: string, action: string): boolean {
  const resourcePerms = PERMISSIONS[resource];
  if (!resourcePerms) return false;
  const allowedRoles = resourcePerms[action];
  if (!allowedRoles) return false;
  const userLevel = ROLE_HIERARCHY[role as Role] ?? 0;
  return allowedRoles.some(r => userLevel >= ROLE_HIERARCHY[r]);
}
