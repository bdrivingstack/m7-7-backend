# M7:7 — Backend API

## Stack
Node.js + Express + TypeScript + Prisma + PostgreSQL

## Installation

```bash
npm install
cp .env.example .env
# Remplir les valeurs dans .env

npx prisma migrate dev --name init
npm run dev
```

## Routes auth
| Méthode | Route | Description |
|---|---|---|
| POST | /api/auth/register | Inscription |
| POST | /api/auth/login | Connexion |
| POST | /api/auth/logout | Déconnexion |
| POST | /api/auth/2fa/verify | Vérification OTP |
| POST | /api/auth/forgot-password | Demande reset mdp |
| POST | /api/auth/reset-password | Reset mdp avec token |
| GET  | /api/auth/verify-email?token= | Vérification email |

## Sécurité implémentée
- bcrypt (cost 12) pour les mots de passe
- Cookies HttpOnly + SameSite=Strict (jamais localStorage)
- Rate limiting par IP+email (5 tentatives login / 15min)
- Verrouillage compte après 5 tentatives
- Messages d'erreur volontairement vagues (anti-énumération)
- Timing constant (faux bcrypt si user inconnu)
- Validation Zod sur toutes les entrées
- AES-256-GCM pour les secrets 2FA en DB
- Tokens de vérification email (24h) et reset (15min)
- Invalidation de toutes les sessions après reset mdp
- Audit log de toutes les actions sensibles
- Helmet (CSP, HSTS, X-Frame-Options...)
- CORS strict
- Body limit 10kb (anti-DoS)
