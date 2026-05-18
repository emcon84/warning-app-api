import { Elysia, t } from "elysia";
import { authPlugin, requireAuth } from "../../plugins/auth";
import * as svc from "./events.service";

function httpError(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function serviceError(e: unknown) {
  if (typeof e === "object" && e !== null && "status" in e) {
    const err = e as { status: number; message: string };
    return httpError(err.status, err.message);
  }
  console.error("[eventos]", e);
  return httpError(500, "Error interno del servidor");
}

export const eventsRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)

  // ── Públicos ────────────────────────────────────────────────────────────────

  .get("/eventos", async ({ query }) => {
    try {
      return await svc.listEvents({
        categoria: query.categoria,
        barrio:    query.barrio,
        upcoming:  query.upcoming === "true",
      });
    } catch (e) { return serviceError(e); }
  }, {
    query: t.Object({
      categoria: t.Optional(t.String()),
      barrio:    t.Optional(t.String()),
      upcoming:  t.Optional(t.String()),
    }),
  })

  .get("/eventos/destacados", async ({ query }) => {
    try {
      const limit = Math.min(parseInt(query.limit ?? "5"), 10);
      return await svc.getUpcomingEvents(limit);
    } catch (e) { return serviceError(e); }
  }, { query: t.Object({ limit: t.Optional(t.String()) }) })

  .get("/eventos/:slug", async ({ params }) => {
    try { return await svc.getEventBySlug(params.slug); }
    catch (e) { return serviceError(e); }
  })

  .get("/eventos/:slug/comentarios", async ({ params }) => {
    try { return await svc.getComments(params.slug); }
    catch (e) { return serviceError(e); }
  })

  .get("/categorias-eventos", () => svc.CATEGORIAS_EVENTO)

  .get("/eventos/:slug/likes", async ({ params }) => {
    try { return await svc.getEventLikes(params.slug); }
    catch (e) { return serviceError(e); }
  })

  .post("/eventos/:slug/like", async ({ params, headers }) => {
    const ip = (headers as any)["x-forwarded-for"]?.split(",")[0].trim()
            || (headers as any)["x-real-ip"]
            || "unknown";
    try { return await svc.likeEvent(params.slug, ip); }
    catch (e) { return serviceError(e); }
  })

  // ── Comentarios (auth) ──────────────────────────────────────────────────────

  .post("/eventos/:slug/comentarios", async ({ params, body, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "Tenés que iniciar sesión para comentar");
    const b = body as any;
    try {
      const comment = await svc.addComment(params.slug, clerkUserId, b?.autorNombre ?? "", b?.texto ?? "");
      return new Response(JSON.stringify(comment), { status: 201 });
    } catch (e) { return serviceError(e); }
  })

  // ── Autenticados (me) ───────────────────────────────────────────────────────

  .use(requireAuth)

  .get("/eventos/me", async ({ clerkUserId }) => {
    try { return await svc.getMyEvents(clerkUserId!); }
    catch (e) { return serviceError(e); }
  })

  .post("/eventos", async ({ clerkUserId, request }) => {
    try {
      const fd     = await request.formData();
      const result = await svc.createEvent(clerkUserId!, fd);
      return new Response(JSON.stringify(result), { status: 201 });
    } catch (e) { return serviceError(e); }
  })

  .put("/eventos/:slug", async ({ clerkUserId, params, request }) => {
    try {
      const fd = await request.formData();
      return await svc.updateEvent(clerkUserId!, params.slug, fd);
    } catch (e) { return serviceError(e); }
  })

  .delete("/eventos/:slug", async ({ clerkUserId, params }) => {
    try { return await svc.deleteEvent(clerkUserId!, params.slug); }
    catch (e) { return serviceError(e); }
  });
