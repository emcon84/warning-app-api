import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit, strictRateLimit } from "../../plugins/rateLimit";
import * as svc from "./empleados.service";

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
  console.error("[empleados]", e);
  return httpError(500, "Error interno del servidor");
}

// ── Router ────────────────────────────────────────────────────────────────────

export const empleadosRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)
  .use(standardRateLimit)

  // ── Lectura pública ─────────────────────────────────────────────────────────

  .get("/empleados", async ({ query }) => {
    try { return await svc.listEmpleados({ barrio: query.barrio, habilidad: query.habilidad }); }
    catch (e) { return serviceError(e); }
  }, { query: t.Object({ barrio: t.Optional(t.String()), habilidad: t.Optional(t.String()) }) })

  // Static routes before /:slug

  .get("/empleados/me", async ({ clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.getMyProfile(clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  .get("/empleados/me/conversaciones", async ({ clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.getMyConversaciones(clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  .get("/empleados/conversaciones/:id", async ({ params, query, clerkUserId }) => {
    try {
      return await svc.getConversacion(params.id, clerkUserId, query.clientToken ?? null);
    } catch (e) { return serviceError(e); }
  }, { query: t.Object({ clientToken: t.Optional(t.String()) }) })

  // ── Escritura (strictRateLimit desde acá) ───────────────────────────────────

  .use(strictRateLimit)

  .post("/empleados", async ({ clerkUserId, request }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try {
      const fd  = await request.formData();
      const emp = await svc.createEmpleado(clerkUserId, fd);
      return new Response(JSON.stringify(emp), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  .put("/empleados/me", async ({ clerkUserId, request }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try {
      const fd  = await request.formData();
      return await svc.updateMyProfile(clerkUserId, fd);
    } catch (e) { return serviceError(e); }
  })

  .post("/empleados/conversaciones/:id/mensajes", async ({ params, body, clerkUserId }) => {
    try {
      const msg = await svc.sendMensaje(params.id, clerkUserId, body as Record<string, unknown>);
      return new Response(JSON.stringify(msg), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  // Generic /:slug — AFTER static routes

  .get("/empleados/:slug", async ({ params }) => {
    try { return await svc.getPublicProfile(params.slug); }
    catch (e) { return serviceError(e); }
  })

  .post("/empleados/:slug/conversaciones", async ({ params, body }) => {
    try {
      const convo = await svc.startConversacion(params.slug, body as Record<string, unknown>);
      return new Response(JSON.stringify(convo), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  });
