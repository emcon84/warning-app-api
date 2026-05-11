import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit, strictRateLimit } from "../../plugins/rateLimit";
import * as svc from "./vacantes.service";

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
  console.error("[vacantes]", e);
  return httpError(500, "Error interno del servidor");
}

// ── Router ────────────────────────────────────────────────────────────────────

export const vacantesRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)
  .use(standardRateLimit)

  // ── Lectura pública ─────────────────────────────────────────────────────────

  .get("/vacantes", async ({ query }) => {
    try { return await svc.listVacantes({ barrio: query.barrio, habilidad: query.habilidad }); }
    catch (e) { return serviceError(e); }
  }, { query: t.Object({ barrio: t.Optional(t.String()), habilidad: t.Optional(t.String()) }) })

  // Static routes BEFORE /:id

  .get("/vacantes/mis", async ({ clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.getMisVacantes(clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  .get("/vacantes/mis/conversaciones", async ({ clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.getMisConversaciones(clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  .get("/vacantes/conversaciones/:id", async ({ params, query, clerkUserId }) => {
    try {
      return await svc.getConversacion(params.id, clerkUserId, query.clientToken ?? null);
    } catch (e) { return serviceError(e); }
  }, { query: t.Object({ clientToken: t.Optional(t.String()) }) })

  // ── Escritura (strictRateLimit desde acá) ───────────────────────────────────

  .use(strictRateLimit)

  .post("/vacantes", async ({ clerkUserId, body }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try {
      const v = await svc.createVacante(clerkUserId, body as Record<string, unknown>);
      return new Response(JSON.stringify(v), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  // Dynamic /:id — AFTER static routes

  .get("/vacantes/:id", async ({ params }) => {
    try { return await svc.getVacante(params.id); }
    catch (e) { return serviceError(e); }
  })

  .put("/vacantes/:id", async ({ params, body, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.updateVacante(clerkUserId, params.id, body as Record<string, unknown>); }
    catch (e) { return serviceError(e); }
  })

  .delete("/vacantes/:id", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.deleteVacante(clerkUserId, params.id); }
    catch (e) { return serviceError(e); }
  })

  .post("/vacantes/:id/conversaciones", async ({ params, body }) => {
    try {
      const convo = await svc.startConversacion(params.id, body as Record<string, unknown>);
      return new Response(JSON.stringify(convo), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  .post("/vacantes/conversaciones/:id/mensajes", async ({ params, body, clerkUserId }) => {
    try {
      const msg = await svc.sendMensaje(params.id, clerkUserId, body as Record<string, unknown>);
      return new Response(JSON.stringify(msg), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  });
