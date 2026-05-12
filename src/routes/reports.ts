import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";

const router = Router();
router.use(authenticate);

const PeriodSchema = z.object({
  dateFrom: z.string().default(() => new Date(new Date().getFullYear(), 0, 1).toISOString()),
  dateTo:   z.string().default(() => new Date().toISOString()),
});

// ─── GET /api/reports/dashboard ───────────────────────────────────────────────
router.get("/dashboard", authorize("reports","read"), async (req, res, next) => {
  try {
    const orgId  = req.user.orgId;
    const period = (req.query.period as string) ?? "month";
    const now    = new Date();

    // ─── Bornes de la période sélectionnée ───────────────────────────────
    let periodStart: Date, prevStart: Date, prevEnd: Date;
    if (period === "year") {
      periodStart = new Date(now.getFullYear(), 0, 1);
      prevStart   = new Date(now.getFullYear() - 1, 0, 1);
      prevEnd     = new Date(now.getFullYear(), 0, 0, 23, 59, 59);
    } else if (period === "quarter") {
      const q   = Math.floor(now.getMonth() / 3);
      periodStart = new Date(now.getFullYear(), q * 3, 1);
      prevStart   = new Date(now.getFullYear(), (q - 1) * 3, 1);
      prevEnd     = new Date(now.getFullYear(), q * 3, 0, 23, 59, 59);
    } else {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      prevStart   = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      prevEnd     = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    }
    const since12m = new Date(now.getFullYear() - 1, now.getMonth(), 1);

    const [
      currentRevenue, prevRevenue, invoicesByStatus,
      overdueInvoices, topCustomersRaw, recentInvoicesRaw,
      quoteStats, paidForDSO, monthly12m,
    ] = await Promise.all([
      prisma.invoice.aggregate({ where:{ orgId, deletedAt:null, status:"PAID", paidAt:{ gte:periodStart } },
        _sum:{ totalHT:true, totalTTC:true } }),
      prisma.invoice.aggregate({ where:{ orgId, deletedAt:null, status:"PAID", paidAt:{ gte:prevStart, lte:prevEnd } },
        _sum:{ totalTTC:true } }),
      prisma.invoice.groupBy({ by:["status"], where:{ orgId, deletedAt:null }, _count:{ id:true } }),
      prisma.invoice.findMany({ where:{ orgId, deletedAt:null, status:{ notIn:["PAID","CANCELLED","CREDITED"] }, dueDate:{ lt:now } },
        select:{ id:true, number:true, totalDue:true, dueDate:true, customer:{ select:{ id:true, name:true } } },
        orderBy:{ dueDate:"asc" }, take:10 }),
      prisma.invoice.groupBy({ by:["customerId"], where:{ orgId, deletedAt:null, status:"PAID", paidAt:{ gte:periodStart } },
        _sum:{ totalTTC:true }, _count:{ id:true }, orderBy:{ _sum:{ totalTTC:"desc" } }, take:5 }),
      prisma.invoice.findMany({ where:{ orgId, deletedAt:null }, orderBy:{ createdAt:"desc" }, take:5,
        select:{ id:true, number:true, totalTTC:true, totalDue:true, status:true, createdAt:true,
          customer:{ select:{ name:true } } } }),
      prisma.quote.groupBy({ by:["status"], where:{ orgId, deletedAt:null }, _count:{ id:true } }),
      prisma.invoice.findMany({ where:{ orgId, deletedAt:null, status:"PAID", paidAt:{ gte:periodStart } },
        select:{ issueDate:true, paidAt:true } }),
      prisma.invoice.findMany({ where:{ orgId, deletedAt:null, status:"PAID", paidAt:{ gte:since12m } },
        select:{ totalTTC:true, paidAt:true }, orderBy:{ paidAt:"asc" } }),
    ]);

    // Enrichir top clients
    const custIds  = topCustomersRaw.map(c => c.customerId);
    const custDocs = custIds.length > 0
      ? await prisma.customer.findMany({ where:{ id:{ in:custIds } }, select:{ id:true, name:true } })
      : [];
    const custMap  = Object.fromEntries(custDocs.map(c => [c.id, c.name]));

    // KPIs
    const curTTC     = Number(currentRevenue._sum.totalTTC ?? 0);
    const prevTTC    = Number(prevRevenue._sum.totalTTC    ?? 0);
    const growth     = prevTTC > 0 ? Math.round((curTTC - prevTTC) / prevTTC * 100) : 0;
    const statusMap  = Object.fromEntries(invoicesByStatus.map(s => [s.status, s._count.id]));
    const overdueTotal = overdueInvoices.reduce((s, i) => s + Number(i.totalDue ?? 0), 0);

    let dso = 0;
    if (paidForDSO.length > 0) {
      const days = paidForDSO.reduce((s, inv) => {
        if (!inv.paidAt || !inv.issueDate) return s;
        return s + (new Date(inv.paidAt).getTime() - new Date(inv.issueDate).getTime()) / 86400000;
      }, 0);
      dso = Math.round(days / paidForDSO.length);
    }

    const quoteSent     = quoteStats.find(s => s.status === "SENT")?._count.id     ?? 0;
    const quoteAccepted = quoteStats.find(s => s.status === "ACCEPTED")?._count.id ?? 0;
    const convRate      = (quoteSent + quoteAccepted) > 0
      ? Math.round(quoteAccepted / (quoteSent + quoteAccepted) * 100) : 0;

    // Graphique CA 12 mois
    const MONTHS_FR = ["Jan","Fév","Mar","Avr","Mai","Juin","Juil","Août","Sep","Oct","Nov","Déc"];
    const byMonth: Record<string, number> = {};
    for (const inv of monthly12m) {
      const key = inv.paidAt!.toISOString().slice(0, 7);
      byMonth[key] = (byMonth[key] ?? 0) + Number(inv.totalTTC);
    }
    const revenueChart = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, revenue]) => ({
        month: MONTHS_FR[parseInt(key.split("-")[1]) - 1],
        revenue: Math.round(revenue),
        expenses: 0,
      }));

    res.json({
      kpis: {
        revenueMonthly:      Math.round(curTTC * 100) / 100,
        revenueGrowth:       growth,
        cashIn:              Math.round(curTTC * 100) / 100,
        cashOut:             0,
        netResult:           Math.round(Number(currentRevenue._sum.totalHT ?? 0) * 100) / 100,
        margin:              0,
        unpaid:              Math.round(overdueTotal * 100) / 100,
        unpaidCount:         overdueInvoices.length,
        dso,
        invoicesPaid:        statusMap["PAID"]   ?? 0,
        invoicesPending:     (statusMap["SENT"]  ?? 0) + (statusMap["DRAFT"] ?? 0),
        invoicesOverdue:     overdueInvoices.length,
        quoteConversionRate: convRate,
      },
      revenueChart,
      cashflow: [],
      alerts: overdueInvoices.slice(0, 5).map(inv => ({
        type:        "danger",
        title:       `Facture en retard : ${inv.number}`,
        description: `${inv.customer.name} — ${Math.round(Number(inv.totalDue))}€ échue le ${new Date(inv.dueDate!).toLocaleDateString("fr-FR")}`,
      })),
      aiRecommendations: [],
      topProducts:       [],
      topClients: topCustomersRaw.map(c => ({
        name:     custMap[c.customerId] ?? "—",
        revenue:  Math.round(Number(c._sum.totalTTC ?? 0) * 100) / 100,
        invoices: c._count.id,
      })),
      recentInvoices: recentInvoicesRaw.map(inv => ({
        id:     inv.number,
        client: inv.customer.name,
        date:   inv.createdAt,
        amount: Math.round(Number(inv.totalTTC) * 100) / 100,
        status: inv.status.toLowerCase(),
      })),
    });
  } catch(err){ next(err); }
});

// ─── GET /api/reports/revenue ─────────────────────────────────────────────────
// CA par mois sur la période
router.get("/revenue", authorize("reports","read"), async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = PeriodSchema.parse(req.query);
    const orgId = req.user.orgId;

    const invoices = await prisma.invoice.findMany({
      where: { orgId, deletedAt:null, status:"PAID",
        paidAt:{ gte:new Date(dateFrom), lte:new Date(dateTo) } },
      select: { totalHT:true, totalTVA:true, totalTTC:true, paidAt:true },
      orderBy:{ paidAt:"asc" },
    });

    // Grouper par mois
    const byMonth: Record<string,{ month:string, ht:number, tva:number, ttc:number }> = {};
    for (const inv of invoices) {
      const key = inv.paidAt!.toISOString().slice(0,7); // "2025-01"
      if (!byMonth[key]) byMonth[key] = { month:key, ht:0, tva:0, ttc:0 };
      byMonth[key].ht  += Number(inv.totalHT);
      byMonth[key].tva += Number(inv.totalTVA);
      byMonth[key].ttc += Number(inv.totalTTC);
    }

    const monthly = Object.values(byMonth).map(m => ({
      ...m,
      ht:  Math.round(m.ht  * 100) / 100,
      tva: Math.round(m.tva * 100) / 100,
      ttc: Math.round(m.ttc * 100) / 100,
    }));

    const total = { ht:0, tva:0, ttc:0 };
    for (const m of monthly) { total.ht += m.ht; total.tva += m.tva; total.ttc += m.ttc; }

    res.json({ data: { monthly, total } });
  } catch(err){ next(err); }
});

// ─── GET /api/reports/vat ─────────────────────────────────────────────────────
// Déclaration TVA (CA3) par taux
router.get("/vat", authorize("reports","read"), async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = PeriodSchema.parse(req.query);
    const orgId = req.user.orgId;

    const lines = await prisma.invoiceLine.findMany({
      where: { invoice:{ orgId, deletedAt:null, status:{ notIn:["DRAFT","CANCELLED"] },
        issueDate:{ gte:new Date(dateFrom), lte:new Date(dateTo) } } },
      select: { vatRate:true, totalHT:true, totalTTC:true },
    });

    // Grouper par taux de TVA
    const byRate: Record<string,{ rate:number, baseHT:number, tva:number }> = {};
    for (const line of lines) {
      const rate = Number(line.vatRate);
      const key  = String(rate);
      if (!byRate[key]) byRate[key] = { rate, baseHT:0, tva:0 };
      const ht  = Number(line.totalHT);
      byRate[key].baseHT += ht;
      byRate[key].tva    += ht * rate / 100;
    }

    const byRateArray = Object.values(byRate).map(r => ({
      rate:   r.rate,
      baseHT: Math.round(r.baseHT * 100) / 100,
      tva:    Math.round(r.tva    * 100) / 100,
    })).sort((a,b) => b.rate - a.rate);

    const totalBaseHT = byRateArray.reduce((s,r) => s+r.baseHT, 0);
    const totalTVA    = byRateArray.reduce((s,r) => s+r.tva,    0);

    res.json({ data: { byRate:byRateArray,
      total:{ baseHT:Math.round(totalBaseHT*100)/100, tva:Math.round(totalTVA*100)/100 } } });
  } catch(err){ next(err); }
});

// ─── GET /api/reports/cashflow ────────────────────────────────────────────────
// Trésorerie prévisionnelle (factures dues non payées)
router.get("/cashflow", authorize("reports","read"), async (req, res, next) => {
  try {
    const orgId = req.user.orgId;
    const now   = new Date();
    const in90d = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const unpaidInvoices = await prisma.invoice.findMany({
      where:{ orgId, deletedAt:null, status:{ notIn:["PAID","CANCELLED","CREDITED"] },
        dueDate:{ lte:in90d } },
      select:{ id:true, number:true, totalDue:true, dueDate:true, status:true,
        customer:{ select:{ id:true, name:true } } },
      orderBy:{ dueDate:"asc" },
    });

    // Grouper par semaine
    const byWeek: Record<string,{ week:string, expected:number, invoices:any[] }> = {};
    let totalOverdue = 0, totalExpected = 0;

    for (const inv of unpaidInvoices) {
      const due = inv.dueDate ? new Date(inv.dueDate) : null;
      if (!due) continue;
      const isOverdue = due < now;
      if (isOverdue) { totalOverdue += Number(inv.totalDue); continue; }

      // Semaine ISO
      const weekStart = new Date(due);
      weekStart.setDate(due.getDate() - due.getDay() + 1);
      const key = weekStart.toISOString().slice(0,10);
      if (!byWeek[key]) byWeek[key] = { week:key, expected:0, invoices:[] };
      byWeek[key].expected += Number(inv.totalDue);
      byWeek[key].invoices.push(inv);
      totalExpected += Number(inv.totalDue);
    }

    res.json({ data: {
      overdue:  { total: Math.round(totalOverdue*100)/100, invoices: unpaidInvoices.filter(i => i.dueDate && new Date(i.dueDate) < now) },
      forecast: Object.values(byWeek),
      totalExpected: Math.round(totalExpected*100)/100,
    }});
  } catch(err){ next(err); }
});

// ─── GET /api/reports/customers ───────────────────────────────────────────────
// Top clients par CA
router.get("/customers", authorize("reports","read"), async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = PeriodSchema.parse(req.query);
    const orgId = req.user.orgId;

    const grouped = await prisma.invoice.groupBy({
      by:["customerId"],
      where:{ orgId, deletedAt:null, status:"PAID", paidAt:{ gte:new Date(dateFrom), lte:new Date(dateTo) } },
      _sum:{ totalHT:true, totalTTC:true }, _count:{ id:true },
      orderBy:{ _sum:{ totalTTC:"desc" } }, take:20,
    });

    const customerIds = grouped.map(g => g.customerId);
    const customers   = await prisma.customer.findMany({ where:{ id:{ in:customerIds } },
      select:{ id:true, name:true, email:true } });
    const customerMap = Object.fromEntries(customers.map(c => [c.id, c]));

    const result = grouped.map(g => ({
      customer:       customerMap[g.customerId],
      invoiceCount:   g._count.id,
      totalHT:        Math.round(Number(g._sum.totalHT)  * 100) / 100,
      totalTTC:       Math.round(Number(g._sum.totalTTC) * 100) / 100,
    }));

    res.json({ data: result });
  } catch(err){ next(err); }
});

// ─── GET /api/reports/urssaf ──────────────────────────────────────────────────
// CA par trimestre / mois pour déclaration auto-entrepreneur
router.get("/urssaf", authorize("reports","read"), async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year as string) || new Date().getFullYear();
    const orgId = req.user.orgId;

    const invoices = await prisma.invoice.findMany({
      where:{ orgId, deletedAt:null, status:"PAID",
        paidAt:{ gte:new Date(year,0,1), lte:new Date(year,11,31,23,59,59) } },
      select:{ totalTTC:true, paidAt:true },
    });

    // Par trimestre
    const quarters = [0,0,0,0];
    const monthly  = Array(12).fill(0);
    for (const inv of invoices) {
      const month   = inv.paidAt!.getMonth();
      const quarter = Math.floor(month / 3);
      quarters[quarter] += Number(inv.totalTTC);
      monthly[month]    += Number(inv.totalTTC);
    }

    res.json({ data: {
      year,
      quarterly: quarters.map((ca,i) => ({ quarter:`T${i+1}`, ca:Math.round(ca*100)/100 })),
      monthly:   monthly.map((ca,i)  => ({ month:i+1,         ca:Math.round(ca*100)/100 })),
      total:     Math.round(invoices.reduce((s,i) => s+Number(i.totalTTC),0)*100)/100,
    }});
  } catch(err){ next(err); }
});

export { router as reportsRouter };
