import { Resend } from "resend";

// ─── INIT ─────────────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY;

const resend = new Resend(RESEND_API_KEY || "placeholder");

const FROM_DEFAULT  = process.env.EMAIL_FROM        || "M7Sept <noreply@m7sept.fr>";
const FROM_INVOICES = process.env.EMAIL_FROM_INVOICES || "M7Sept Facturation <facturation@m7sept.fr>";
const APP_URL       = process.env.FRONTEND_URL       || "http://localhost:8080";

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface SendResult {
  success: boolean;
  id?:     string;
  error?:  string;
}

// ─── HELPER : Wrapper sécurisé ────────────────────────────────────────────────
// Ne fait jamais planter l'opération métier si l'email échoue

async function send(params: {
  from?:       string;
  to:          string | string[];
  subject:     string;
  html:        string;
  attachments?: { filename: string; content: Buffer }[];
}): Promise<SendResult> {
  try {
    const { data, error } = await resend.emails.send({
      from:        params.from || FROM_DEFAULT,
      to:          Array.isArray(params.to) ? params.to : [params.to],
      subject:     params.subject,
      html:        params.html,
      attachments: params.attachments?.map(a => ({
        filename: a.filename,
        content:  a.content.toString("base64"),
      })),
    });
    if (error) return { success: false, error: error.message };
    return { success: true, id: data?.id };
  } catch (err: any) {
    console.error("[emailService] Erreur envoi email :", err?.message);
    return { success: false, error: err?.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TEMPLATES HTML
// Design épuré, compatible tous clients mail (Outlook, Gmail, Apple Mail)
// ════════════════════════════════════════════════════════════════════════════

function baseTemplate(params: {
  preheader:    string;
  title:        string;
  body:         string;
  ctaLabel?:    string;
  ctaUrl?:      string;
  orgName?:     string;
  primaryColor?: string;
}): string {
  const color = params.primaryColor || "#6d28d9";
  const cta   = params.ctaLabel && params.ctaUrl
    ? `<div style="text-align:center;margin:32px 0">
         <a href="${params.ctaUrl}"
            style="background:${color};color:#fff;text-decoration:none;
                   padding:14px 32px;border-radius:8px;font-weight:600;
                   font-size:15px;display:inline-block">
           ${params.ctaLabel}
         </a>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>${params.title}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <!-- Preheader invisible -->
  <span style="display:none;max-height:0;overflow:hidden">${params.preheader}</span>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:40px 16px">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:12px;overflow:hidden;
                    box-shadow:0 1px 3px rgba(0,0,0,.08)">

        <!-- Header -->
        <tr>
          <td style="background:${color};padding:28px 40px;text-align:center">
            <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px">
              ${params.orgName || "M7Sept"}
            </span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px 40px 32px">
            <h1 style="margin:0 0 24px;font-size:22px;font-weight:700;color:#111">${params.title}</h1>
            <div style="font-size:15px;line-height:1.7;color:#444">${params.body}</div>
            ${cta}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px 32px;border-top:1px solid #eee">
            <p style="margin:0;font-size:12px;color:#999;text-align:center">
              ${params.orgName || "M7Sept"} — Plateforme de gestion financière
              <br/>Cet email a été envoyé automatiquement, merci de ne pas y répondre.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. VÉRIFICATION EMAIL (inscription)
// ════════════════════════════════════════════════════════════════════════════

export async function sendVerificationEmail(params: {
  to:        string;
  firstName: string;
  token:     string;
}): Promise<SendResult> {
  const url = `${APP_URL}/verify-email?token=${params.token}`;

  return send({
    to:      params.to,
    subject: "Vérifiez votre adresse email — M7Sept",
    html:    baseTemplate({
      preheader: "Confirmez votre adresse email pour activer votre compte M7Sept",
      title:     `Bonjour ${params.firstName} 👋`,
      body: `
        <p>Merci de vous être inscrit sur <strong>M7Sept</strong>.</p>
        <p>Cliquez sur le bouton ci-dessous pour vérifier votre adresse email et activer votre compte.</p>
        <p style="color:#888;font-size:13px">Ce lien expire dans <strong>24 heures</strong>.</p>
      `,
      ctaLabel: "Vérifier mon email",
      ctaUrl:   url,
    }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 2. RÉINITIALISATION MOT DE PASSE
// ════════════════════════════════════════════════════════════════════════════

export async function sendPasswordResetEmail(params: {
  to:        string;
  firstName: string;
  token:     string;
}): Promise<SendResult> {
  const url = `${APP_URL}/reset-password?token=${params.token}`;

  return send({
    to:      params.to,
    subject: "Réinitialisation de votre mot de passe — M7Sept",
    html:    baseTemplate({
      preheader: "Une demande de réinitialisation de mot de passe a été effectuée",
      title:     "Réinitialiser votre mot de passe",
      body: `
        <p>Bonjour <strong>${params.firstName}</strong>,</p>
        <p>Nous avons reçu une demande de réinitialisation du mot de passe associé à votre compte.</p>
        <p>Cliquez sur le bouton ci-dessous pour définir un nouveau mot de passe.</p>
        <p style="color:#888;font-size:13px">⏱ Ce lien expire dans <strong>15 minutes</strong>.</p>
        <p style="color:#888;font-size:13px">Si vous n'avez pas demandé cette réinitialisation, ignorez cet email — votre mot de passe reste inchangé.</p>
      `,
      ctaLabel: "Réinitialiser mon mot de passe",
      ctaUrl:   url,
    }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 3. INVITATION MEMBRE
// ════════════════════════════════════════════════════════════════════════════

export async function sendInvitationEmail(params: {
  to:          string;
  firstName:   string;
  orgName:     string;
  invitedBy:   string;
  role:        string;
  token:       string;
  primaryColor?: string;
}): Promise<SendResult> {
  const url = `${APP_URL}/accept-invitation?token=${params.token}`;
  const roleLabels: Record<string, string> = {
    ADMIN:      "Administrateur",
    ACCOUNTANT: "Comptable",
    MANAGER:    "Manager",
    VIEWER:     "Lecteur",
  };

  return send({
    to:      params.to,
    subject: `Vous avez été invité à rejoindre ${params.orgName} sur M7Sept`,
    html:    baseTemplate({
      preheader:    `${params.invitedBy} vous invite à rejoindre ${params.orgName}`,
      title:        "Vous avez été invité !",
      orgName:      params.orgName,
      primaryColor: params.primaryColor,
      body: `
        <p>Bonjour <strong>${params.firstName}</strong>,</p>
        <p><strong>${params.invitedBy}</strong> vous invite à rejoindre l'espace <strong>${params.orgName}</strong> sur M7Sept en tant que <strong>${roleLabels[params.role] || params.role}</strong>.</p>
        <p>Cliquez sur le bouton ci-dessous pour créer votre mot de passe et accéder à votre espace.</p>
        <p style="color:#888;font-size:13px">Ce lien expire dans <strong>72 heures</strong>.</p>
      `,
      ctaLabel: "Accepter l'invitation",
      ctaUrl:   url,
    }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 4. FACTURE ENVOYÉE AU CLIENT (PDF en pièce jointe)
// ════════════════════════════════════════════════════════════════════════════

export async function sendInvoiceToCustomer(params: {
  to:           string;
  customerName: string;
  orgName:      string;
  invoiceNumber:string;
  totalTTC:     number;
  dueDate?:     string;
  message?:     string;
  pdfBuffer:    Buffer;
  primaryColor?: string;
}): Promise<SendResult> {
  const dueDateStr = params.dueDate
    ? new Date(params.dueDate).toLocaleDateString("fr-FR", { day:"2-digit", month:"long", year:"numeric" })
    : null;

  return send({
    from:    FROM_INVOICES,
    to:      params.to,
    subject: `Facture ${params.invoiceNumber} — ${params.orgName}`,
    html:    baseTemplate({
      preheader:    `Votre facture ${params.invoiceNumber} d'un montant de ${params.totalTTC.toFixed(2)} €`,
      title:        `Facture ${params.invoiceNumber}`,
      orgName:      params.orgName,
      primaryColor: params.primaryColor,
      body: `
        <p>Bonjour <strong>${params.customerName}</strong>,</p>
        <p>Veuillez trouver ci-joint votre facture <strong>${params.invoiceNumber}</strong> d'un montant de
           <strong>${params.totalTTC.toFixed(2)} €</strong>.</p>
        ${dueDateStr ? `<p>📅 Date d'échéance : <strong>${dueDateStr}</strong></p>` : ""}
        ${params.message ? `<div style="background:#f8f8f8;border-left:3px solid #ddd;padding:12px 16px;margin:16px 0;border-radius:4px;font-size:14px;color:#555">${params.message}</div>` : ""}
        <p>La facture est disponible en pièce jointe à cet email au format PDF.</p>
        <p style="color:#888;font-size:13px">Pour toute question, répondez directement à cet email.</p>
      `,
    }),
    attachments: [{
      filename: `Facture-${params.invoiceNumber}.pdf`,
      content:  params.pdfBuffer,
    }],
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 5. DEVIS ENVOYÉ AU CLIENT (PDF en pièce jointe)
// ════════════════════════════════════════════════════════════════════════════

export async function sendQuoteToCustomer(params: {
  to:           string;
  customerName: string;
  orgName:      string;
  quoteNumber:  string;
  totalTTC:     number;
  validUntil?:  string;
  message?:     string;
  acceptUrl?:   string;
  pdfBuffer:    Buffer;
  primaryColor?: string;
}): Promise<SendResult> {
  const validStr = params.validUntil
    ? new Date(params.validUntil).toLocaleDateString("fr-FR", { day:"2-digit", month:"long", year:"numeric" })
    : null;

  return send({
    from:    FROM_INVOICES,
    to:      params.to,
    subject: `Devis ${params.quoteNumber} — ${params.orgName}`,
    html:    baseTemplate({
      preheader:    `Votre devis ${params.quoteNumber} d'un montant de ${params.totalTTC.toFixed(2)} €`,
      title:        `Devis ${params.quoteNumber}`,
      orgName:      params.orgName,
      primaryColor: params.primaryColor,
      body: `
        <p>Bonjour <strong>${params.customerName}</strong>,</p>
        <p>Veuillez trouver ci-joint notre devis <strong>${params.quoteNumber}</strong> d'un montant de
           <strong>${params.totalTTC.toFixed(2)} €</strong>.</p>
        ${validStr ? `<p>⏳ Ce devis est valable jusqu'au <strong>${validStr}</strong>.</p>` : ""}
        ${params.message ? `<div style="background:#f8f8f8;border-left:3px solid #ddd;padding:12px 16px;margin:16px 0;border-radius:4px;font-size:14px;color:#555">${params.message}</div>` : ""}
        <p>Le devis est disponible en pièce jointe. Vous pouvez également le consulter et l'accepter en ligne.</p>
      `,
      ctaLabel: params.acceptUrl ? "Consulter et accepter en ligne" : undefined,
      ctaUrl:   params.acceptUrl,
    }),
    attachments: [{
      filename: `Devis-${params.quoteNumber}.pdf`,
      content:  params.pdfBuffer,
    }],
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 6. RELANCE FACTURE IMPAYÉE (au client)
// ════════════════════════════════════════════════════════════════════════════

type ReminderLevel = "gentle" | "formal" | "legal";

export async function sendInvoiceReminder(params: {
  to:           string;
  customerName: string;
  orgName:      string;
  invoiceNumber:string;
  totalDue:     number;
  dueDate:      string;
  daysOverdue:  number;
  level:        ReminderLevel;
  primaryColor?: string;
}): Promise<SendResult> {
  const dueDateStr = new Date(params.dueDate).toLocaleDateString("fr-FR",
    { day:"2-digit", month:"long", year:"numeric" });

  const levelConfig = {
    gentle: {
      subject: `Rappel — Facture ${params.invoiceNumber} en attente de règlement`,
      emoji:   "📬",
      tone:    `<p>Nous vous contactons au sujet de la facture <strong>${params.invoiceNumber}</strong>
                dont l'échéance était le <strong>${dueDateStr}</strong>.</p>
                <p>Il s'agit peut-être d'un simple oubli — si le paiement a déjà été effectué,
                veuillez ignorer ce message.</p>`,
    },
    formal: {
      subject: `Mise en demeure amiable — Facture ${params.invoiceNumber}`,
      emoji:   "⚠️",
      tone:    `<p>Sauf erreur ou omission de notre part, nous constatons que la facture
                <strong>${params.invoiceNumber}</strong> d'un montant de <strong>${params.totalDue.toFixed(2)} €</strong>,
                dont l'échéance était le <strong>${dueDateStr}</strong>, reste impayée
                depuis <strong>${params.daysOverdue} jours</strong>.</p>
                <p>Nous vous demandons de procéder au règlement dans les meilleurs délais afin d'éviter
                l'application de pénalités de retard.</p>`,
    },
    legal: {
      subject: `Mise en demeure — Facture ${params.invoiceNumber} — Action requise`,
      emoji:   "🔴",
      tone:    `<p>Malgré nos précédentes relances, la facture <strong>${params.invoiceNumber}</strong>
                d'un montant de <strong>${params.totalDue.toFixed(2)} €</strong>, échue le
                <strong>${dueDateStr}</strong>, demeure impayée depuis <strong>${params.daysOverdue} jours</strong>.</p>
                <p>En l'absence de règlement sous <strong>8 jours</strong>, nous nous verrons contraints
                d'engager une procédure de recouvrement, avec application des pénalités de retard
                conformément aux conditions générales de vente.</p>`,
    },
  };

  const cfg = levelConfig[params.level];

  return send({
    from:    FROM_INVOICES,
    to:      params.to,
    subject: cfg.subject,
    html:    baseTemplate({
      preheader:    `${cfg.emoji} Facture ${params.invoiceNumber} — ${params.totalDue.toFixed(2)} € à régler`,
      title:        `${cfg.emoji} Relance — Facture ${params.invoiceNumber}`,
      orgName:      params.orgName,
      primaryColor: params.primaryColor,
      body: `
        <p>Bonjour <strong>${params.customerName}</strong>,</p>
        ${cfg.tone}
        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
          <tr style="background:#f8f8f8">
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:600">Facture</td>
            <td style="padding:10px 16px;border:1px solid #eee">${params.invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:600">Montant dû</td>
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:700;color:#e53e3e">${params.totalDue.toFixed(2)} €</td>
          </tr>
          <tr style="background:#f8f8f8">
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:600">Échéance</td>
            <td style="padding:10px 16px;border:1px solid #eee">${dueDateStr}</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:600">Retard</td>
            <td style="padding:10px 16px;border:1px solid #eee;color:#e53e3e">${params.daysOverdue} jours</td>
          </tr>
        </table>
        <p style="color:#888;font-size:13px">Pour toute question, répondez directement à cet email.</p>
      `,
    }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 7. CONFIRMATION PAIEMENT REÇU (au client)
// ════════════════════════════════════════════════════════════════════════════

export async function sendPaymentConfirmation(params: {
  to:           string;
  customerName: string;
  orgName:      string;
  invoiceNumber:string;
  amount:       number;
  paidAt:       string;
  method:       string;
  primaryColor?: string;
}): Promise<SendResult> {
  const paidAtStr = new Date(params.paidAt).toLocaleDateString("fr-FR",
    { day:"2-digit", month:"long", year:"numeric" });

  const methodLabels: Record<string, string> = {
    BANK_TRANSFER: "Virement bancaire",
    CARD:          "Carte bancaire",
    CASH:          "Espèces",
    CHECK:         "Chèque",
    DIRECT_DEBIT:  "Prélèvement",
    PAYPAL:        "PayPal",
    OTHER:         "Autre",
  };

  return send({
    from:    FROM_INVOICES,
    to:      params.to,
    subject: `Confirmation de paiement — Facture ${params.invoiceNumber}`,
    html:    baseTemplate({
      preheader:    `✅ Votre paiement de ${params.amount.toFixed(2)} € a bien été reçu`,
      title:        "✅ Paiement confirmé",
      orgName:      params.orgName,
      primaryColor: params.primaryColor,
      body: `
        <p>Bonjour <strong>${params.customerName}</strong>,</p>
        <p>Nous confirmons la bonne réception de votre paiement pour la facture
           <strong>${params.invoiceNumber}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
          <tr style="background:#f0fdf4">
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:600">Facture</td>
            <td style="padding:10px 16px;border:1px solid #eee">${params.invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:600">Montant</td>
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:700;color:#16a34a">${params.amount.toFixed(2)} €</td>
          </tr>
          <tr style="background:#f0fdf4">
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:600">Date</td>
            <td style="padding:10px 16px;border:1px solid #eee">${paidAtStr}</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;border:1px solid #eee;font-weight:600">Mode</td>
            <td style="padding:10px 16px;border:1px solid #eee">${methodLabels[params.method] || params.method}</td>
          </tr>
        </table>
        <p>Merci pour votre confiance.</p>
      `,
    }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 8. DEVIS ACCEPTÉ / REFUSÉ (notification interne à l'org)
// ════════════════════════════════════════════════════════════════════════════

export async function sendQuoteStatusNotification(params: {
  to:           string;  // Email du membre de l'org à notifier
  orgName:      string;
  quoteNumber:  string;
  customerName: string;
  status:       "accepted" | "declined";
  reason?:      string;
  primaryColor?: string;
}): Promise<SendResult> {
  const isAccepted = params.status === "accepted";

  return send({
    to:      params.to,
    subject: `Devis ${params.quoteNumber} ${isAccepted ? "accepté ✅" : "refusé ❌"} par ${params.customerName}`,
    html:    baseTemplate({
      preheader:    `${params.customerName} a ${isAccepted ? "accepté" : "refusé"} le devis ${params.quoteNumber}`,
      title:        isAccepted ? `✅ Devis accepté` : `❌ Devis refusé`,
      orgName:      params.orgName,
      primaryColor: params.primaryColor,
      body: `
        <p>Le client <strong>${params.customerName}</strong> a
           <strong>${isAccepted ? "accepté" : "refusé"}</strong>
           le devis <strong>${params.quoteNumber}</strong>.</p>
        ${params.reason ? `<div style="background:#f8f8f8;border-left:3px solid #ddd;padding:12px 16px;margin:16px 0;border-radius:4px;font-size:14px;color:#555"><strong>Motif :</strong> ${params.reason}</div>` : ""}
        ${isAccepted ? `<p>🎉 Vous pouvez maintenant convertir ce devis en facture depuis votre espace M7Sept.</p>` : ""}
      `,
      ctaLabel: "Voir le devis",
      ctaUrl:   `${APP_URL}/app/sales/quotes`,
    }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 9. FACTURE EN RETARD (notification interne à l'org)
// ════════════════════════════════════════════════════════════════════════════

export async function sendOverdueInternalAlert(params: {
  to:           string;  // Email du membre de l'org
  orgName:      string;
  overdueCount: number;
  totalDue:     number;
  invoices:     { number: string; customerName: string; totalDue: number; daysOverdue: number }[];
  primaryColor?: string;
}): Promise<SendResult> {
  const rows = params.invoices.slice(0, 10).map(inv => `
    <tr>
      <td style="padding:10px 16px;border:1px solid #eee">${inv.number}</td>
      <td style="padding:10px 16px;border:1px solid #eee">${inv.customerName}</td>
      <td style="padding:10px 16px;border:1px solid #eee;color:#e53e3e;font-weight:600">${inv.totalDue.toFixed(2)} €</td>
      <td style="padding:10px 16px;border:1px solid #eee;color:#e53e3e">${inv.daysOverdue}j de retard</td>
    </tr>`).join("");

  return send({
    to:      params.to,
    subject: `⚠️ ${params.overdueCount} facture${params.overdueCount > 1 ? "s" : ""} en retard — ${params.totalDue.toFixed(2)} € à recouvrer`,
    html:    baseTemplate({
      preheader:    `${params.overdueCount} factures en retard pour un total de ${params.totalDue.toFixed(2)} €`,
      title:        `⚠️ Factures en retard`,
      orgName:      params.orgName,
      primaryColor: params.primaryColor,
      body: `
        <p>Vous avez <strong>${params.overdueCount} facture${params.overdueCount > 1 ? "s" : ""} en retard</strong>
           pour un total de <strong style="color:#e53e3e">${params.totalDue.toFixed(2)} €</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
          <thead>
            <tr style="background:#f8f8f8">
              <th style="padding:10px 16px;border:1px solid #eee;text-align:left">Facture</th>
              <th style="padding:10px 16px;border:1px solid #eee;text-align:left">Client</th>
              <th style="padding:10px 16px;border:1px solid #eee;text-align:left">Montant dû</th>
              <th style="padding:10px 16px;border:1px solid #eee;text-align:left">Retard</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${params.invoices.length > 10 ? `<p style="color:#888;font-size:13px">Et ${params.invoices.length - 10} autre(s)...</p>` : ""}
      `,
      ctaLabel: "Gérer les relances",
      ctaUrl:   `${APP_URL}/app/sales/invoices?status=OVERDUE`,
    }),
  });
}
