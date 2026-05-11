import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { storesRouter } from "./modules/stores/stores.router";
import { postsRouter } from "./modules/posts/posts.router";
import { reportsRouter } from "./modules/reports/reports.router";
import { doctorsRouter } from "./modules/doctors/doctors.router";
import { pharmaciesRouter } from "./modules/pharmacies/pharmacies.router";
import { professionalsRouter } from "./modules/professionals/professionals.router";
import { employeesRouter } from "./modules/employees/employees.router";
import { vacanciesRouter } from "./modules/vacancies/vacancies.router";

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

  // ── Modules ───────────────────────────────────────────────────────────────
  .use(storesRouter)
  .use(postsRouter)
  .use(reportsRouter)
  .use(doctorsRouter)
  .use(pharmaciesRouter)
  .use(professionalsRouter)
  .use(employeesRouter)
  .use(vacanciesRouter)

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
