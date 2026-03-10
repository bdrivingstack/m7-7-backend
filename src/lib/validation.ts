import { z } from "zod";

// ─── Règles partagées (identiques au frontend) ────────────────────────────────
export const emailSchema = z
  .string()
  .min(1, "Email requis.")
  .email("Format d'email invalide.")
  .max(254, "Email trop long.")
  .transform(v => v.toLowerCase().trim());

export const passwordSchema = z
  .string()
  .min(8,   "Minimum 8 caractères.")
  .max(128, "Maximum 128 caractères.")
  .regex(/[A-Z]/,           "Au moins 1 majuscule.")
  .regex(/[a-z]/,           "Au moins 1 minuscule.")
  .regex(/[0-9]/,           "Au moins 1 chiffre.")
  .regex(/[@$!%*?&\-_#^]/,  "Au moins 1 caractère spécial (@$!%*?&).")
  .refine(p => !/[àâäéèêëîïôùûüç]/i.test(p), "Les accents sont interdits.");

// ─── Schémas de routes ────────────────────────────────────────────────────────
export const RegisterSchema = z.object({
  firstName: z.string().min(1).max(50).trim(),
  lastName:  z.string().min(1).max(50).trim(),
  company:   z.string().min(1).max(100).trim(),
  email:     emailSchema,
  password:  passwordSchema,
});

export const LoginSchema = z.object({
  email:    emailSchema,
  password: z.string().min(1, "Mot de passe requis.").max(128),
});

export const MfaVerifySchema = z.object({
  code: z.string().length(6, "Le code doit faire 6 chiffres.").regex(/^\d+$/, "Chiffres uniquement."),
});

export const ForgotPasswordSchema = z.object({
  email: emailSchema,
});

export const ResetPasswordSchema = z.object({
  token:    z.string().min(1),
  password: passwordSchema,
});
