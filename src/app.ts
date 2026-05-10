import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { comerciosRouter } from "./modules/comercios/comercios.router";
import { postsRouter } from "./modules/posts/posts.router";
import { reportsRouter } from "./modules/reports/reports.router";
import { doctorsRouter } from "./modules/doctors/doctors.router";
import { farmaciasRouter } from "./modules/farmacias/farmacias.router";
import { professionalsRouter } from "./modules/professionals/professionals.router";

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

  // ── Módulos ───────────────────────────────────────────────────────────────
  .use(comerciosRouter)
  .use(postsRouter)
  .use(reportsRouter)
  .use(doctorsRouter)
  .use(farmaciasRouter)
  .use(professionalsRouter)

  // ── Error handler global ──────────────────────────────────────────────────
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

// Los módulos se irán agregando acá a medida que se migren:
// .use(comerciosModule)
// .use(productosModule)
// .use(postsModule)
// ...
