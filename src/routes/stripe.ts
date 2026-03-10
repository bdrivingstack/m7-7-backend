import { Router, type Request, type Response, type NextFunction } from "express";
import { constructWebhookEvent, handleWebhookEvent } from "../lib/stripeService.js";

const router = Router();

// ⚠️ IMPORTANT : Cette route doit être montée AVANT express.json()
// car Stripe exige le body brut (Buffer) pour vérifier la signature HMAC
// Dans index.ts : app.use("/api/stripe", stripeRouter) AVANT app.use(express.json())

router.post(
  "/webhook",
  // Pas de authenticate — Stripe signe la requête avec HMAC-SHA256
  async (req: Request, res: Response, next: NextFunction) => {
    const sig = req.headers["stripe-signature"] as string;

    if (!sig) {
      res.status(400).json({ error: "Signature Stripe manquante." });
      return;
    }

    let event;
    try {
      // req.body est un Buffer ici (express.raw() configuré dans index.ts)
      event = constructWebhookEvent(req.body as Buffer, sig);
    } catch (err: any) {
      console.error("[Stripe Webhook] Signature invalide :", err.message);
      res.status(400).json({ error: `Webhook error: ${err.message}` });
      return;
    }

    try {
      await handleWebhookEvent(event);
      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  }
);

export { router as stripeRouter };
