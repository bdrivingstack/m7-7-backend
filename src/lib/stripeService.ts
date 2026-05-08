import Stripe from "stripe";
import { prisma } from "./prisma.js";
import { sendPaymentConfirmation } from "./emailService.js";
import { auditLog } from "./audit.js";

// ─── INIT ─────────────────────────────────────────────────────────────────────

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

export const stripe = new Stripe(STRIPE_SECRET_KEY || "placeholder", {
  apiVersion: "2026-02-25.clover",
  typescript:  true,
});

const APP_URL            = process.env.FRONTEND_URL          || "http://localhost:8080";
const WEBHOOK_SECRET     = process.env.STRIPE_WEBHOOK_SECRET || "";

// ─── PLANS M7Sept → Stripe Price IDs ───────────────────────────────────────────
// À renseigner dans .env après création dans le dashboard Stripe

const PLAN_PRICE_IDS: Record<string, string> = {
  MICRO:    process.env.STRIPE_PRICE_MICRO    || "",
  PRO:      process.env.STRIPE_PRICE_PRO      || "",
  BUSINESS: process.env.STRIPE_PRICE_BUSINESS || "",
  EXPERT:   process.env.STRIPE_PRICE_EXPERT   || "",
};

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — PAIEMENT FACTURE CLIENT
// Génère un lien de paiement Stripe pour une facture M7Sept
// ════════════════════════════════════════════════════════════════════════════

export async function createInvoicePaymentLink(params: {
  invoiceId:    string;
  orgId:        string;
  customerName: string;
  customerEmail:string;
  invoiceNumber:string;
  totalTTC:     number;
  currency:     string;
  description?: string;
  dueDate?:     Date;
}): Promise<{ url: string; paymentIntentId: string; sessionId: string }> {

  // Créer ou récupérer un customer Stripe pour le client M7Sept
  const stripeCustomer = await getOrCreateStripeCustomer({
    email: params.customerEmail,
    name:  params.customerName,
    orgId: params.orgId,
  });

  // Créer une Checkout Session Stripe
  const session = await stripe.checkout.sessions.create({
    customer:    stripeCustomer.id,
    mode:        "payment",
    currency:    params.currency.toLowerCase(),
    line_items:  [{
      price_data: {
        currency:     params.currency.toLowerCase(),
        product_data: {
          name:        `Facture ${params.invoiceNumber}`,
          description: params.description || `Règlement facture ${params.invoiceNumber}`,
          metadata:    { invoiceId: params.invoiceId, orgId: params.orgId },
        },
        unit_amount: Math.round(params.totalTTC * 100), // Stripe en centimes
      },
      quantity: 1,
    }],
    payment_intent_data: {
      metadata: {
        invoiceId:     params.invoiceId,
        invoiceNumber: params.invoiceNumber,
        orgId:         params.orgId,
        type:          "invoice_payment",
      },
      // Délai de capture si on veut autoriser sans capturer immédiatement
      // capture_method: "automatic",
    },
    metadata: {
      invoiceId:     params.invoiceId,
      invoiceNumber: params.invoiceNumber,
      orgId:         params.orgId,
    },
    success_url: `${APP_URL}/app/sales/invoices/${params.invoiceId}?paid=true`,
    cancel_url:  `${APP_URL}/app/sales/invoices/${params.invoiceId}?cancelled=true`,
    // Expiration du lien
    expires_at:  params.dueDate
      ? Math.min(Math.floor(params.dueDate.getTime() / 1000), Math.floor(Date.now() / 1000) + 86400 * 30)
      : Math.floor(Date.now() / 1000) + 86400 * 30, // 30 jours max
    // Permettre codes promo
    allow_promotion_codes: false,
    // Récupérer l'email si inconnu
    customer_email: stripeCustomer ? undefined : params.customerEmail,
  });

  // Sauvegarder le stripePaymentIntentId dans le Payment M7Sept
  await prisma.payment.create({
    data: {
      orgId:                req_orgId(params.orgId),
      invoiceId:            params.invoiceId,
      amount:               params.totalTTC,
      currency:             params.currency,
      method:               "CARD",
      status:               "PENDING",
      stripePaymentIntentId:session.payment_intent as string,
      reference:            `Stripe Checkout ${session.id}`,
    },
  });

  return {
    url:             session.url!,
    paymentIntentId: session.payment_intent as string,
    sessionId:       session.id,
  };
}

// ─── Helper : récupérer ou créer un customer Stripe ──────────────────────────

async function getOrCreateStripeCustomer(params: {
  email: string;
  name:  string;
  orgId: string;
}): Promise<Stripe.Customer> {
  // Chercher si un customer Stripe existe déjà avec cet email
  const existing = await stripe.customers.list({ email: params.email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];

  return stripe.customers.create({
    email:    params.email,
    name:     params.name,
    metadata: { orgId: params.orgId },
  });
}

// ─── Helper interne (orgId sans req) ─────────────────────────────────────────
function req_orgId(orgId: string) { return orgId; }

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — ABONNEMENTS SAAS (Plans M7Sept)
// Gestion des abonnements Stripe Billing pour M7Sept lui-même
// ════════════════════════════════════════════════════════════════════════════

export async function createSubscription(params: {
  orgId:        string;
  plan:         "MICRO" | "PRO" | "BUSINESS" | "EXPERT";
  ownerEmail:   string;
  ownerName:    string;
  trialDays?:   number;
}): Promise<{ subscriptionId: string; clientSecret: string; checkoutUrl: string }> {

  const priceId = PLAN_PRICE_IDS[params.plan];
  if (!priceId) throw new Error(`Prix Stripe non configuré pour le plan ${params.plan}. Vérifiez STRIPE_PRICE_${params.plan} dans .env`);

  // Créer ou récupérer le customer Stripe de l'org
  const customer = await getOrCreateStripeCustomer({
    email: params.ownerEmail,
    name:  params.ownerName,
    orgId: params.orgId,
  });

  // Checkout Session pour l'abonnement
  const session = await stripe.checkout.sessions.create({
    customer: customer.id,
    mode:     "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: params.trialDays,
      metadata: { orgId: params.orgId, plan: params.plan },
    },
    metadata:   { orgId: params.orgId, plan: params.plan, type: "saas_subscription" },
    success_url:`${APP_URL}/app/settings/billing?subscribed=true`,
    cancel_url: `${APP_URL}/app/settings/billing?cancelled=true`,
  });

  return {
    subscriptionId: "",            // Sera connu après webhook checkout.session.completed
    clientSecret:   "",            // Non applicable en mode redirect
    checkoutUrl:    session.url!,
  };
}

// ─── Changer de plan ──────────────────────────────────────────────────────────

export async function changePlan(params: {
  orgId:      string;
  newPlan:    "MICRO" | "PRO" | "BUSINESS" | "EXPERT";
}): Promise<void> {
  const priceId = PLAN_PRICE_IDS[params.newPlan];
  if (!priceId) throw new Error(`Prix Stripe non configuré pour le plan ${params.newPlan}`);

  // Récupérer l'abonnement actif via l'intégration stockée
  const integration = await prisma.integration.findFirst({
    where: { orgId: params.orgId, type: "STRIPE", isActive: true },
  });
  if (!integration?.configJson) throw new Error("Aucun abonnement Stripe actif trouvé.");

  const config       = integration.configJson as any;
  const subscription = await stripe.subscriptions.retrieve(config.subscriptionId);
  const itemId       = subscription.items.data[0].id;

  // Mise à jour immédiate avec prorata
  await stripe.subscriptions.update(config.subscriptionId, {
    items: [{ id: itemId, price: priceId }],
    proration_behavior: "always_invoice",
    metadata: { orgId: params.orgId, plan: params.newPlan },
  });

  // Mettre à jour le plan en base
  await prisma.org.update({
    where: { id: params.orgId },
    data:  { plan: params.newPlan as any },
  });
}

// ─── Annuler l'abonnement ─────────────────────────────────────────────────────

export async function cancelSubscription(params: {
  orgId:          string;
  cancelAtPeriodEnd: boolean; // true = fin de période, false = immédiat
}): Promise<void> {
  const integration = await prisma.integration.findFirst({
    where: { orgId: params.orgId, type: "STRIPE", isActive: true },
  });
  if (!integration?.configJson) throw new Error("Aucun abonnement actif.");

  const config = integration.configJson as any;

  if (params.cancelAtPeriodEnd) {
    await stripe.subscriptions.update(config.subscriptionId, {
      cancel_at_period_end: true,
    });
  } else {
    await stripe.subscriptions.cancel(config.subscriptionId);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — REMBOURSEMENTS
// ════════════════════════════════════════════════════════════════════════════

export async function refundPayment(params: {
  paymentId:    string; // ID Payment M7Sept
  amount?:      number; // Partiel si défini, total sinon
  reason?:      "duplicate" | "fraudulent" | "requested_by_customer";
  orgId:        string;
  userId:       string;
}): Promise<Stripe.Refund> {

  const payment = await prisma.payment.findUnique({ where: { id: params.paymentId } });
  if (!payment) throw new Error("Paiement introuvable.");
  if (payment.orgId !== params.orgId) throw new Error("Accès interdit.");
  if (!payment.stripePaymentIntentId) throw new Error("Ce paiement n'a pas été effectué via Stripe.");
  if (payment.refundedAt) throw new Error("Ce paiement a déjà été remboursé.");

  // Créer le remboursement Stripe
  const refund = await stripe.refunds.create({
    payment_intent: payment.stripePaymentIntentId,
    ...(params.amount && { amount: Math.round(params.amount * 100) }),
    reason: params.reason || "requested_by_customer",
    metadata: { paymentId: params.paymentId, orgId: params.orgId },
  });

  const refundAmount = (refund.amount / 100);

  // Mettre à jour le Payment en base
  await prisma.payment.update({
    where: { id: params.paymentId },
    data: {
      status:       refund.amount === payment.amount.toNumber() * 100 ? "REFUNDED" : "PARTIALLY_REFUNDED",
      refundedAt:   new Date(),
      refundAmount: refundAmount,
      refundReason: params.reason,
      stripeChargeId: refund.charge as string,
    },
  });

  await auditLog({
    userId:     params.userId,
    orgId:      params.orgId,
    action:     "PAYMENT_REFUNDED",
    resource:   "payment",
    resourceId: params.paymentId,
    detail:     `Remboursement Stripe: ${refundAmount}€ — ID: ${refund.id}`,
  });

  return refund;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4 — PORTAIL CLIENT STRIPE
// Permet au client de gérer ses moyens de paiement, voir ses factures
// ════════════════════════════════════════════════════════════════════════════

export async function createCustomerPortalSession(params: {
  orgId:       string;
  returnUrl?:  string;
}): Promise<{ url: string }> {

  const integration = await prisma.integration.findFirst({
    where: { orgId: params.orgId, type: "STRIPE", isActive: true },
  });
  if (!integration?.configJson) throw new Error("Aucun abonnement Stripe actif trouvé.");

  const config   = integration.configJson as any;
  const session  = await stripe.billingPortal.sessions.create({
    customer:   config.customerId,
    return_url: params.returnUrl || `${APP_URL}/app/settings/billing`,
  });

  return { url: session.url };
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5 — WEBHOOKS STRIPE ENTRANTS
// Traitement des événements Stripe → mise à jour M7Sept
// ════════════════════════════════════════════════════════════════════════════

export function constructWebhookEvent(
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  if (!WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET manquant dans .env");
  return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
}

export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {

    // ── Paiement facture client réussi ───────────────────────────────────
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const { invoiceId, orgId } = pi.metadata;
      if (!invoiceId || !orgId) break;

      const amount = pi.amount_received / 100;

      await prisma.$transaction(async (tx) => {
        // Mettre à jour le Payment
        await tx.payment.updateMany({
          where: { stripePaymentIntentId: pi.id },
          data:  { status: "SUCCEEDED", paidAt: new Date(),
            stripeChargeId: pi.latest_charge as string },
        });

        // Mettre à jour la Facture
        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
        if (!invoice) return;

        const newPaid = Number(invoice.totalPaid) + amount;
        const newDue  = Math.max(0, Number(invoice.totalTTC) - newPaid);
        const status  = newDue <= 0 ? "PAID" : "PARTIAL";

        await tx.invoice.update({
          where: { id: invoiceId },
          data:  { totalPaid: newPaid, totalDue: newDue, status,
            paidAt: status === "PAID" ? new Date() : undefined,
            statusHistory: { create: { status, note: `Paiement Stripe reçu: ${amount}€` } },
          },
        });

        // Envoyer email de confirmation au client
        const customer = await tx.customer.findUnique({
          where:  { id: invoice.customerId },
          select: { email: true, name: true },
        });
        if (customer?.email) {
          await sendPaymentConfirmation({
            to:           customer.email,
            customerName: customer.name,
            orgName:      "M7Sept", // TODO: récupérer le nom de l'org
            invoiceNumber:invoice.number,
            amount,
            paidAt:       new Date().toISOString(),
            method:       "CARD",
          });
        }
      });

      await auditLog({ orgId, action: "PAYMENT_STRIPE_SUCCEEDED",
        resource: "invoice", resourceId: invoiceId, detail: `${amount}€` });
      break;
    }

    // ── Paiement échoué ────────────────────────────────────────────────
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const { invoiceId } = pi.metadata;

      await prisma.payment.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data:  { status: "FAILED" },
      });

      await prisma.paymentAttempt.create({
        data: {
          paymentId:   "", // Sera lié si on a le paymentId
          amount:      pi.amount / 100,
          status:      "FAILED",
          errorCode:   pi.last_payment_error?.code || "unknown",
          errorMsg:    pi.last_payment_error?.message || "Paiement refusé",
          gatewayRef:  pi.id,
        },
      }).catch(() => {}); // Non bloquant
      break;
    }

    // ── Remboursement ─────────────────────────────────────────────────
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const refundAmount = charge.amount_refunded / 100;

      await prisma.payment.updateMany({
        where: { stripeChargeId: charge.id },
        data:  {
          status:       charge.refunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
          refundedAt:   new Date(),
          refundAmount: refundAmount,
        },
      });
      break;
    }

    // ── Abonnement SaaS créé / activé ─────────────────────────────────
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") break;

      const { orgId, plan } = session.metadata || {};
      if (!orgId || !plan) break;

      const subscriptionId = session.subscription as string;
      const customerId     = session.customer     as string;

      // Activer le plan en base + sauvegarder l'intégration Stripe
      await prisma.$transaction([
        prisma.org.update({
          where: { id: orgId },
          data:  { plan: plan as any, trialEnds: null },
        }),
        prisma.integration.upsert({
          where:  { orgId_type: { orgId, type: "STRIPE" } },
          create: { orgId, type: "STRIPE", name: "Stripe Billing", isActive: true,
            configJson: { subscriptionId, customerId, plan } },
          update: { isActive: true, configJson: { subscriptionId, customerId, plan } },
        }),
      ]);

      await auditLog({ orgId, action: "SUBSCRIPTION_ACTIVATED", detail: `Plan: ${plan}` });
      break;
    }

    // ── Paiement abonnement réussi ─────────────────────────────────────
    case "invoice.payment_succeeded": {
      const stripeInvoice = event.data.object as Stripe.Invoice;
      const orgId = ((stripeInvoice as any).subscription_details?.metadata?.orgId ||
                     stripeInvoice.metadata?.orgId) as string;
      if (!orgId) break;

      await auditLog({ orgId, action: "SUBSCRIPTION_PAYMENT_SUCCEEDED",
        detail: `${stripeInvoice.amount_paid / 100}€` });
      break;
    }

    // ── Paiement abonnement échoué ─────────────────────────────────────
    case "invoice.payment_failed": {
      const stripeInvoice = event.data.object as Stripe.Invoice;
      const orgId = stripeInvoice.metadata?.orgId as string;
      if (!orgId) break;
      // TODO: Envoyer un email d'alerte au OWNER de l'org
      await auditLog({ orgId, action: "SUBSCRIPTION_PAYMENT_FAILED" });
      break;
    }

    // ── Abonnement annulé ──────────────────────────────────────────────
    case "customer.subscription.deleted": {
      const sub   = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.orgId as string;
      if (!orgId) break;

      // Rétrograder au plan MICRO
      await prisma.org.update({
        where: { id: orgId },
        data:  { plan: "MICRO" },
      });

      await prisma.integration.updateMany({
        where: { orgId, type: "STRIPE" },
        data:  { isActive: false },
      });

      await auditLog({ orgId, action: "SUBSCRIPTION_CANCELLED" });
      break;
    }

    // ── Abonnement mis à jour (changement de plan) ─────────────────────
    case "customer.subscription.updated": {
      const sub   = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.orgId as string;
      const plan  = sub.metadata?.plan  as string;
      if (!orgId || !plan) break;

      await prisma.org.update({
        where: { id: orgId },
        data:  { plan: plan as any },
      });

      await auditLog({ orgId, action: "SUBSCRIPTION_UPDATED", detail: `Plan: ${plan}` });
      break;
    }

    default:
      // Événement non géré — on ignore silencieusement
      break;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6 — UTILITAIRES
// ════════════════════════════════════════════════════════════════════════════

// Récupérer l'abonnement actif d'une org
export async function getActiveSubscription(orgId: string): Promise<{
  plan:              string;
  status:            string;
  currentPeriodEnd:  Date;
  cancelAtPeriodEnd: boolean;
} | null> {
  const integration = await prisma.integration.findFirst({
    where: { orgId, type: "STRIPE", isActive: true },
  });
  if (!integration?.configJson) return null;

  const config = integration.configJson as any;
  if (!config.subscriptionId) return null;

  try {
    const sub = await stripe.subscriptions.retrieve(config.subscriptionId);
    return {
      plan:             config.plan,
      status:           sub.status,
      currentPeriodEnd: new Date((sub as any).current_period_end * 1000),
      cancelAtPeriodEnd:sub.cancel_at_period_end,
    };
  } catch {
    return null;
  }
}

// Récupérer les factures Stripe d'une org (historique de facturation SaaS)
export async function getBillingHistory(orgId: string): Promise<Stripe.Invoice[]> {
  const integration = await prisma.integration.findFirst({
    where: { orgId, type: "STRIPE", isActive: true },
  });
  if (!integration?.configJson) return [];

  const config = integration.configJson as any;
  if (!config.customerId) return [];

  const invoices = await stripe.invoices.list({
    customer: config.customerId,
    limit:    24,
  });

  return invoices.data;
}
