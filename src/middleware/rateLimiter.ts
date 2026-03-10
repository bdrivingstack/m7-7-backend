import rateLimit from "express-rate-limit";

// ─── Rate limiter LOGIN — strict anti brute force ────────────────────────────
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // Fenêtre de 15 minutes
  max: 5,                      // Max 5 tentatives par IP par fenêtre
  skipSuccessfulRequests: true, // Ne compte pas les succès
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "RATE_LIMITED",
    message: "Trop de tentatives de connexion. Réessayez dans 15 minutes.",
  },
  keyGenerator: (req) => {
    // Rate limit par IP + email combinés (plus précis)
    const ip = req.ip || "unknown";
    const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "";
    return `${ip}:${email}`;
  },
});

// ─── Rate limiter REGISTER ───────────────────────────────────────────────────
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 3,                    // Max 3 inscriptions par IP par heure
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "RATE_LIMITED",
    message: "Trop de tentatives d'inscription. Réessayez dans 1 heure.",
  },
});

// ─── Rate limiter FORGOT PASSWORD ────────────────────────────────────────────
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "RATE_LIMITED",
    message: "Trop de demandes. Réessayez dans 1 heure.",
  },
});

// ─── Rate limiter API global ──────────────────────────────────────────────────
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 100,             // 100 req/min par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "RATE_LIMITED",
    message: "Trop de requêtes. Ralentissez.",
  },
});
