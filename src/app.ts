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

export const app = new Elysia()

  // ── CORS ─────────────────────────────────────────────────────────────────
  .use(
    cors({
      origin: process.env.CORS_ORIGIN || "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Professional-Code"],
    })
  )

  // ── Health check ──────────────────────────────────────────────────────────
  .get("/api/health", () => ({ status: "ok" }))

  // ── Public platform analytics ─────────────────────────────────────────────
  .get("/api/analytics", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
    const [
      totalReports,
      reportsByCategory,
      topBarrios,
      totalProfessionals,
      totalConversations,
      totalReviews,
      dailyReports,
    ] = await Promise.all([
      prisma.report.count(),
      prisma.report.groupBy({
        by: ["category"],
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 6,
      }),
      prisma.report.groupBy({
        by: ["barrio"],
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 5,
      }),
      prisma.professional.count(),
      prisma.conversation.count(),
      prisma.comercioReview.count(),
      prisma.report.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    // Agrupa reportes diarios de los últimos 30 días
    const dailyMap: Record<string, number> = {};
    for (const r of dailyReports) {
      const key = r.createdAt.toISOString().slice(0, 10);
      dailyMap[key] = (dailyMap[key] ?? 0) + 1;
    }
    const dailyVisits = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, visits]) => ({ date, visits, uniqueVisitors: visits }));

    return {
      uniqueVisitors: { today: 0, week: 0, month: 0, total: 0 },
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
