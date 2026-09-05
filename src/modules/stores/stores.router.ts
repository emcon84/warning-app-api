import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit, strictRateLimit } from "../../plugins/rateLimit";
import * as svc from "./stores.service";
import * as repo from "./stores.repository";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clientIP(headers: Record<string, string | undefined>): string {
  return (
    headers["x-forwarded-for"]?.split(",")[0].trim() ||
    headers["x-real-ip"] ||
    "unknown"
  );
}

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
  console.error("[comercios]", e);
  return httpError(500, "Error interno del servidor");
}

// ── Router ────────────────────────────────────────────────────────────────────

export const storesRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)

  // ── Productos públicos ──────────────────────────────────────────────────────

  .get("/productos/buscar", async ({ query }) => {
    const q = (query.q ?? "").trim();
    if (q.length < 2) return [];
    return repo.searchProducts(q, 10);
  }, { query: t.Object({ q: t.Optional(t.String()) }) })

  .get("/productos/recientes", async ({ query }) => {
    const limit = Math.min(parseInt(query.limit ?? "20"), 40);
    return repo.findRecentProducts(limit);
  }, { query: t.Object({ limit: t.Optional(t.String()) }) })

  // ── Comercios públicos ──────────────────────────────────────────────────────

  .get("/comercios", async ({ query }) =>
    svc.listStores({ barrio: query.barrio, rubro: query.rubro }),
    { query: t.Object({ barrio: t.Optional(t.String()), rubro: t.Optional(t.String()) }) }
  )

  .get("/comercios/:slug", async ({ params }) => {
    const c = await svc.getStoreBySlug(params.slug);
    if (!c) return httpError(404, "Comercio no encontrado");
    return c;
  })

  .get("/comercios/:slug/offers", async ({ params }) => {
    const store = await repo.findStoreBySlug(params.slug);
    if (!store) return httpError(404, "No encontrado");
    return repo.findOffersByStoreId(store.id);
  })

  .get("/comercios/:slug/reviews", async ({ params }) => {
    try { return await svc.getReviews(params.slug); }
    catch (e) { return serviceError(e); }
  })

  .get("/comercios/:slug/sumate", async ({ params, clerkUserId }) => {
    try { return await svc.getFollowStatus(params.slug, clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  // ── Recommend (anónimo, dedup por IP) ──────────────────────────────────────

  .use(strictRateLimit)
  .post("/comercios/:slug/recommend", async ({ params, headers }) => {
    try { return await svc.recommendStore(params.slug, clientIP(headers as any)); }
    catch (e) { return serviceError(e); }
  })

  // ── Track (público, fire-and-forget) ───────────────────────────────────────

  .post("/comercios/:slug/track", async ({ params, body }) => {
    try { return await svc.trackEvent(params.slug, (body as any)?.type ?? ""); }
    catch (e) { return serviceError(e); }
  })

  // ── Reviews autenticadas ────────────────────────────────────────────────────

  .post("/comercios/:slug/reviews", async ({ params, body, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "Tenés que iniciar sesión para calificar");
    try {
      const result = await svc.submitReview(params.slug, clerkUserId, (body as any)?.score);
      return new Response(JSON.stringify(result), { status: 201 });
    } catch (e) { return serviceError(e); }
  })

  // ── Sumate/desumate ─────────────────────────────────────────────────────────

  .post("/comercios/:slug/sumate", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.follow(params.slug, clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  .delete("/comercios/:slug/sumate", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.unfollow(params.slug, clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  // ── Auth por PIN (público) ──────────────────────────────────────────────────

  .post("/comercios/auth", async ({ body }) => {
    try {
      const b = body as Record<string, unknown>;
      return await svc.authWithPin(b.whatsapp as string, b.pin as string);
    } catch (e) { return serviceError(e); }
  })

  // ── Rutas autenticadas (me) ─────────────────────────────────────────────────

  .post("/comercios", async ({ clerkUserId, request }) => {
    try {
      const fd = await request.formData();
      const result = await svc.createStore(clerkUserId, fd);
      return new Response(JSON.stringify(result), { status: 201 });
    } catch (e) { return serviceError(e); }
  })

  .get("/comercios/me", async ({ clerkUserId, headers }) => {
    try {
      const storeCode = headers["x-store-code"];
      return await svc.getMyStore(clerkUserId, storeCode);
    } catch (e) { return serviceError(e); }
  })

  .put("/comercios/me", async ({ clerkUserId, headers, request }) => {
    try {
      const storeCode = headers["x-store-code"];
      const fd = await request.formData();
      return await svc.updateMyStore(clerkUserId, storeCode, fd);
    } catch (e) { return serviceError(e); }
  })

  .delete("/comercios/me/fotos", async ({ clerkUserId, headers, body }) => {
    const url = (body as any)?.url;
    if (!url) return httpError(400, "URL requerida");
    try {
      const storeCode = headers["x-store-code"];
      return await svc.deleteGalleryPhoto(clerkUserId, storeCode, url);
    } catch (e) { return serviceError(e); }
  })

  .get("/comercios/me/analytics", async ({ clerkUserId, headers }) => {
    try {
      const storeCode = headers["x-store-code"];
      return await svc.getAnalytics(clerkUserId, storeCode);
    } catch (e) { console.error("[analytics]", e); return serviceError(e); }
  })

  .get("/comercios/me/plan", async ({ clerkUserId, headers }) => {
    try {
      const storeCode = headers["x-store-code"];
      return await svc.getPlan(clerkUserId, storeCode);
    } catch (e) { return serviceError(e); }
  })

  // ── Offers (me) ─────────────────────────────────────────────────────────────

  .post("/comercios/me/offers", async ({ clerkUserId, headers, request }) => {
    try {
      const storeCode = headers["x-store-code"];
      const fd = await request.formData();
      const result = await svc.createOffer(clerkUserId, storeCode, fd);
      return new Response(JSON.stringify(result), { status: 201 });
    } catch (e) { return serviceError(e); }
  })

  .patch("/comercios/me/offers/:offerId", async ({ clerkUserId, headers, params, request }) => {
    try {
      const storeCode = headers["x-store-code"];
      const ct = request.headers.get("content-type") ?? "";
      const isJson = ct.includes("application/json");
      const body = isJson ? await request.json() : await request.formData();
      return await svc.updateOffer(clerkUserId, storeCode, params.offerId, body as any, isJson);
    } catch (e) { return serviceError(e); }
  })

  .delete("/comercios/me/offers/:offerId", async ({ clerkUserId, headers, params }) => {
    try {
      const storeCode = headers["x-store-code"];
      return await svc.deleteOffer(clerkUserId, storeCode, params.offerId);
    } catch (e) { return serviceError(e); }
  })

  // ── Productos (me) ──────────────────────────────────────────────────────────

  .post("/comercios/me/productos", async ({ clerkUserId, headers, request }) => {
    try {
      const storeCode = headers["x-store-code"];
      const fd = await request.formData();
      const result = await svc.createProduct(clerkUserId, storeCode, fd);
      return new Response(JSON.stringify(result), { status: 201 });
    } catch (e) { return serviceError(e); }
  })

  .put("/comercios/me/productos/:productoId", async ({ clerkUserId, headers, params, request }) => {
    try {
      const storeCode = headers["x-store-code"];
      const fd = await request.formData();
      return await svc.updateProduct(clerkUserId, storeCode, params.productoId, fd);
    } catch (e) { return serviceError(e); }
  })

  .delete("/comercios/me/productos/:productoId", async ({ clerkUserId, headers, params }) => {
    try {
      const storeCode = headers["x-store-code"];
      return await svc.deleteProduct(clerkUserId, storeCode, params.productoId);
    } catch (e) { return serviceError(e); }
  })

  // ── AI (productos) ──────────────────────────────────────────────────────────

  .post("/comercios/me/recommendations", async ({ clerkUserId, headers }) => {
    try {
      const storeCode = headers["x-store-code"];
      return await svc.generateRecommendations(clerkUserId, storeCode);
    } catch (e) { return serviceError(e); }
  })

  .post("/comercios/me/productos/autocompletar", async ({ clerkUserId, headers }) => {
    try {
      const storeCode = headers["x-store-code"];
      await svc.checkAndIncrementAiUsage(clerkUserId, storeCode, "analysis");
      return httpError(501, "IA en migración — disponible pronto");
    } catch (e) { return serviceError(e); }
  })

  .post("/comercios/me/productos/generar-imagen", async ({ clerkUserId, headers }) => {
    try {
      const storeCode = headers["x-store-code"];
      await svc.checkAndIncrementAiUsage(clerkUserId, storeCode, "image");
      return httpError(501, "IA en migración — disponible pronto");
    } catch (e) { return serviceError(e); }
  });
