import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { authRouter }        from "./routes/auth.js";
import { customersRouter }   from "./routes/customers.js";
import { invoicesRouter }    from "./routes/invoices.js";
import { quotesRouter }      from "./routes/quotes.js";
import { paymentsRouter }    from "./routes/payments.js";
import { creditNotesRouter } from "./routes/credit-notes.js";
import { reportsRouter }     from "./routes/reports.js";
import { usersRouter }       from "./routes/users.js";
import { settingsRouter }    from "./routes/settings.js";
import { documentsRouter }   from "./routes/documents.js";
import { einvoicingRouter }  from "./routes/einvoicing.js";
import { urssafRouter }      from "./routes/urssaf.js";
import { stripeRouter }      from "./routes/stripe.js";
import { globalLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
const PORT = process.env.PORT || 4000;

app.set("trust proxy", 1); // Railway reverse proxy

// ─── CORS — doit être EN PREMIER avant Helmet ─────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "https://m7sept-front.vercel.app",
].filter(Boolean) as string[];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS bloqué pour l'origine : ${origin}`));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.options("*", cors(corsOptions));
app.use(cors(corsOptions));

// ─── SÉCURITÉ — Headers HTTP ──────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,        // désactivé — géré côté frontend
  crossOriginResourcePolicy: false,    // permet les requêtes cross-origin
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xFrameOptions: { action: "deny" },
}));

// ─── STRIPE WEBHOOK — doit être AVANT express.json() (body brut requis) ─────────
app.use("/api/stripe", express.raw({ type: "application/json" }), stripeRouter);

// ─── PARSING ──────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10kb" }));    // Limite taille body — anti DoS
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(cookieParser());

// ─── LOGS ─────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  app.use(morgan("combined"));
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use("/api", globalLimiter);          // Rate limit global sur toute l'API
app.use("/api/auth",        authRouter);
app.use("/api/customers",   customersRouter);
app.use("/api/invoices",    invoicesRouter);
app.use("/api/quotes",      quotesRouter);
app.use("/api/payments",    paymentsRouter);
app.use("/api/credit-notes",creditNotesRouter);
app.use("/api/reports",     reportsRouter);
app.use("/api/users",       usersRouter);
app.use("/api/settings",    settingsRouter);
app.use("/api/documents",   documentsRouter);
app.use("/api/einvoicing",  einvoicingRouter);
app.use("/api/urssaf",      urssafRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Test email — à supprimer après validation
app.get("/api/test-email", async (_req, res) => {
  const { sendVerificationEmail } = await import("./lib/emailService.js");
  const result = await sendVerificationEmail({
    to:        process.env.TEST_EMAIL || "belvederedriving@gmail.com",
    firstName: "Test",
    token:     "test-token-123",
  });
  res.json(result);
});

// ─── GESTION ERREURS ─────────────────────────────────────────────────────────
app.use(errorHandler);

// 404
app.use((_req, res) => {
  res.status(404).json({ code: "NOT_FOUND", message: "Route introuvable." });
});

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`✅ M7Sept Backend démarré sur http://0.0.0.0:${PORT}`);
});

export default app;
