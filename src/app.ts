import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { prisma } from "./lib/prisma";
import { storesRouter } from "./modules/stores/stores.router";
import { postsRouter } from "./modules/posts/posts.router";
import { reportsRouter } from "./modules/reports/reports.router";
import { doctorsRouter } from "./modules/doctors/doctors.router";
import { pharmaciesRouter } from "./modules/pharmacies/pharmacies.router";
import { professionalsRouter } from "./modules/professionals/professionals.router";
import { employeesRouter } from "./modules/employees/employees.router";
import { vacanciesRouter } from "./modules/vacancies/vacancies.router";
import { adminRouter } from "./modules/admin/admin.router";
import { publicRouter } from "./modules/public/public.router";
import { heroRouter } from "./modules/hero/hero.router";
import { eventsRouter } from "./modules/events/events.router";
import { newsRouter } from "./modules/news/news.router";
import { searchRouter } from "./modules/search/search.router";
import { patioLimpioRouter } from "./modules/patio-limpio/patio-limpio.router";

export const app = new Elysia()

  // ── CORS ─────────────────────────────────────────────────────────────────
  .use(
    cors({
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(",").map(o => o.trim())
        : true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Professional-Code"],
    })
  )

  // ── Health check ──────────────────────────────────────────────────────────
  .get("/api/health", () => ({ status: "ok" }))

  // ── Public platform analytics ─────────────────────────────────────────────
  .get("/api/pixel", async ({ request, set }) => {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
            || request.headers.get("x-real-ip")
            || "unknown";
    const ua = request.headers.get("user-agent") || "";
    const section = new URL(request.url).searchParams.get("section") || "home";
    const sessionId = new URL(request.url).searchParams.get("s") || ip;

    try {
      await prisma.pageView.create({ data: { ip, section, sessionId, userAgent: ua.slice(0, 500) } });
    } catch {}

    // Return transparent 1x1 GIF
    set.headers["Content-Type"] = "image/gif";
    set.headers["Cache-Control"] = "no-cache, no-store";
    return Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  })

  .get("/api/analytics", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 86400_000);

    const [
      totalReports,
      reportsByCategory,
      topBarrios,
      totalProfessionals,
      totalConversations,
      totalReviews,
      dailyVisitsRaw,
      todayVisits,
      weekVisits,
      monthVisits,
      totalVisits,
    ] = await Promise.all([
      prisma.report.count(),
      prisma.report.groupBy({ by: ["category"], _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 6 }),
      prisma.report.groupBy({ by: ["barrio"], _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 5 }),
      prisma.professional.count(),
      prisma.conversation.count(),
      prisma.comercioReview.count(),
      prisma.pageView.findMany({ where: { createdAt: { gte: thirtyDaysAgo }, section: "home" }, select: { createdAt: true, ip: true, userAgent: true }, orderBy: { createdAt: "asc" } }),
      prisma.pageView.count({ where: { createdAt: { gte: today }, section: "home" } }),
      prisma.pageView.count({ where: { createdAt: { gte: weekAgo }, section: "home" } }),
      prisma.pageView.count({ where: { createdAt: { gte: thirtyDaysAgo }, section: "home" } }),
      prisma.pageView.count({ where: { section: "home" } }),
    ]);

    // Daily unique IPs + device breakdown (home section only)
    const dailyMap: Record<string, Set<string>> = {};
    let mobileCount = 0;
    let desktopCount = 0;

    for (const v of dailyVisitsRaw) {
      const key = v.createdAt!.toISOString().slice(0, 10);
      if (!dailyMap[key]) dailyMap[key] = new Set();
      dailyMap[key].add(v.ip ?? "unknown");

      // Detect device type from user-agent
      const ua = (v.userAgent || "").toLowerCase();
      if (ua.includes("mobi") || ua.includes("android") && !ua.includes("tablet")) {
        mobileCount++;
      } else {
        desktopCount++;
      }
    }
    const dailyVisits = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, ips]) => ({ date, visits: ips.size, uniqueVisitors: ips.size }));

    // Unique IPs for today/week/month (home section only)
    const [todayIPs, weekIPs, monthIPs] = await Promise.all([
      prisma.pageView.findMany({ where: { createdAt: { gte: today }, section: "home" }, select: { ip: true }, distinct: ["ip"] }),
      prisma.pageView.findMany({ where: { createdAt: { gte: weekAgo }, section: "home" }, select: { ip: true }, distinct: ["ip"] }),
      prisma.pageView.findMany({ where: { createdAt: { gte: thirtyDaysAgo }, section: "home" }, select: { ip: true }, distinct: ["ip"] }),
    ]);

    return {
      uniqueVisitors: {
        today: todayIPs.length,
        week: weekIPs.length,
        month: monthIPs.length,
        total: totalVisits,
      },
      devices: {
        mobile: Math.round((mobileCount / (dailyVisitsRaw.length || 1)) * 100),
        desktop: Math.round((desktopCount / (dailyVisitsRaw.length || 1)) * 100),
        totalViews: dailyVisitsRaw.length,
      },
      topSections: [],
      dailyVisits,
      totalReports,
      reportsByCategory: reportsByCategory.map(r => ({ category: r.category, count: r._count.id })),
      topBarrios: topBarrios.map(b => ({ barrio: b.barrio, count: b._count.id })),
      professionals: { total: totalProfessionals, active: totalProfessionals },
      conversations: { total: totalConversations, active: 0 },
      reviews: totalReviews,
    };
  })

  // ── Modules ───────────────────────────────────────────────────────────────
  .use(storesRouter)
  .use(postsRouter)
  .use(reportsRouter)
  .use(doctorsRouter)
  .use(pharmaciesRouter)
  .use(professionalsRouter)
  .use(employeesRouter)
  .use(vacanciesRouter)
  .use(adminRouter)
  .use(publicRouter)
  .use(heroRouter)
  .use(eventsRouter)
  .use(newsRouter)
  .use(searchRouter)
  .use(patioLimpioRouter)

  // ── Global error handler ──────────────────────────────────────────────────
  .onError(({ code, error, set }) => {
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Ruta no encontrada" };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { error: "Datos inválidos", details: error.message };
    }
    console.error(`[${code}]`, error);
    set.status = 500;
    return { error: "Error interno del servidor" };
  });
