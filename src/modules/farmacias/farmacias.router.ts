import { Elysia } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit, strictRateLimit } from "../../plugins/rateLimit";
import * as svc from "./farmacias.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function serviceError(e: unknown): Response {
  if (typeof e === "object" && e !== null && "status" in e) {
    const err = e as { status: number; message: string };
    return httpError(err.status, err.message);
  }
  console.error("[farmacias]", e);
  return httpError(500, "Error interno del servidor");
}

// ── Router ────────────────────────────────────────────────────────────────────

export const farmaciasRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)
  .use(standardRateLimit)

  // ── Lectura pública ─────────────────────────────────────────────────────────

  .get("/farmacias", async () => {
    try { return await svc.listFarmacias(); }
    catch (e) { return serviceError(e); }
  })

  // Static route registered before /:id to avoid "turno" being captured as param
  .get("/farmacias/turno", async () => {
    try { return await svc.getTurno(); }
    catch (e) { return serviceError(e); }
  })

  // ── Escritura (strictRateLimit desde acá) ───────────────────────────────────

  .use(strictRateLimit)

  .put("/farmacias/:id", async ({ params, body }) => {
    try { return await svc.updateFarmacia(params.id, body as Record<string, unknown>); }
    catch (e) { return serviceError(e); }
  });
