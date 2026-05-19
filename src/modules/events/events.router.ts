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

  // ── Barra ───────────────────────────────────────────────────────────────────

  .get("/eventos/:slug/barra", async ({ params }) => {
    try { return await svc.getBarra(params.slug); }
    catch (e) { return serviceError(e); }
  })

  .post("/eventos/:slug/barra", async ({ params, clerkUserId, request }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try {
      const fd = await request.formData();
      return await svc.addBarraProduct(params.slug, clerkUserId, fd);
    } catch (e) { return serviceError(e); }
  })

  .patch("/eventos/:slug/barra/:productoId", async ({ params, clerkUserId, request }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try {
      const fd = await request.formData();
      return await svc.updateBarraProduct(params.slug, clerkUserId, params.productoId, fd);
    } catch (e) { return serviceError(e); }
  })

  .delete("/eventos/:slug/barra/:productoId", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.deleteBarraProduct(params.slug, clerkUserId, params.productoId); }
    catch (e) { return serviceError(e); }
  })

  .patch("/eventos/:slug/barra/mp-alias", async ({ params, clerkUserId, body }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    const alias = (body as any)?.mpAlias ?? null;
    try { return await svc.updateMpAlias(params.slug, clerkUserId, alias); }
    catch (e) { return serviceError(e); }
  })

  // ── Sorteo ──────────────────────────────────────────────────────────────────

  .get("/eventos/:slug/sorteo", async ({ params, clerkUserId }) => {
    try { return await svc.getSorteoStatus(params.slug, clerkUserId ?? null); }
    catch (e) { return serviceError(e); }
  })

  .post("/eventos/:slug/sorteo/participar", async ({ params, clerkUserId, body }) => {
    if (!clerkUserId) return httpError(401, "Tenés que iniciar sesión");
    const nombre = (body as any)?.nombre ?? "Participante";
    try { return await svc.participarSorteo(params.slug, clerkUserId, nombre); }
    catch (e) { return serviceError(e); }
  })

  .get("/eventos/:slug/sorteo/participantes", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.getParticipantes(params.slug, clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  .post("/eventos/:slug/sorteo/ejecutar", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.ejecutarSorteo(params.slug, clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  // ── Follow status ────────────────────────────────────────────────────────────

  .get("/eventos/:slug/follow", async ({ params, clerkUserId }) => {
    try { return await svc.getFollowStatus(params.slug, clerkUserId ?? null); }
    catch (e) { return serviceError(e); }
  })

  .post("/eventos/:slug/follow", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "Tenés que iniciar sesión");
    try { return await svc.followEvent(params.slug, clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  .delete("/eventos/:slug/follow", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "Tenés que iniciar sesión");
    try { return await svc.unfollowEvent(params.slug, clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  .get("/eventos/:slug/likes", async ({ params }) => {
    try { return await svc.getEventLikes(params.slug); }
    catch (e) { return serviceError(e); }
  })

  .get("/eventos/:slug/fotos", async ({ params }) => {
    try { return await svc.getEventPhotos(params.slug); }
    catch (e) { return serviceError(e); }
  })

  .post("/eventos/:slug/fotos/:fotoId/like", async ({ params, headers }) => {
    const ip = (headers as any)["x-forwarded-for"]?.split(",")[0].trim()
            || (headers as any)["x-real-ip"] || "unknown";
    try { return await svc.likeEventPhoto(params.fotoId, ip); }
    catch (e) { return serviceError(e); }
  })

  .post("/eventos/:slug/fotos", async ({ params, clerkUserId, request }) => {
    if (!clerkUserId) return httpError(401, "Tenés que iniciar sesión para subir fotos");
    try {
      const fd  = await request.formData();
      const file = fd.get("photo") as File | null;
      const nombre = (fd.get("autorNombre") as string | null) ?? "";
      if (!file) return httpError(400, "Foto requerida");
      const foto = await svc.uploadEventPhoto(params.slug, clerkUserId, nombre, file);
      return new Response(JSON.stringify(foto), { status: 201 });
    } catch (e) { return serviceError(e); }
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

  .patch("/eventos/:slug/estado", async ({ clerkUserId, params, body }) => {
    const borrador = (body as any)?.borrador ?? true;
    try {
      const fd = new FormData();
      fd.append("borrador", String(borrador));
      return await svc.updateEvent(clerkUserId!, params.slug, fd);
    } catch (e) { return serviceError(e); }
  })

  .delete("/eventos/:slug", async ({ clerkUserId, params }) => {
    try { return await svc.deleteEvent(clerkUserId!, params.slug); }
    catch (e) { return serviceError(e); }
  });
