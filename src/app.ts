import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { comerciosRouter } from "./modules/comercios/comercios.router";

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
