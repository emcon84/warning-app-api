import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit, strictRateLimit } from "../../plugins/rateLimit";
import * as svc from "./professionals.service";
import { prisma } from "../../lib/prisma";

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
  console.error("[professionals]", e);
  return httpError(500, "Error interno del servidor");
}

// ── Router ────────────────────────────────────────────────────────────────────

export const professionalsRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)
  .use(standardRateLimit)

  // ── Lectura pública ─────────────────────────────────────────────────────────

  .get("/professionals", async ({ query }) => {
    try {
      return await svc.listProfessionals({
        oficio: query.oficio,
        barrio: query.barrio,
        tipo:   query.tipo,
      });
    } catch (e) { return serviceError(e); }
  }, {
    query: t.Object({
      oficio: t.Optional(t.String()),
      barrio: t.Optional(t.String()),
      tipo:   t.Optional(t.String()),
    }),
  })

  // Static routes before /:slug

  .get("/professionals/me", async ({ clerkUserId, headers }) => {
    try {
      const proCode = headers["x-professional-code"];
      return await svc.getMyProfile(clerkUserId, proCode);
    } catch (e) { return serviceError(e); }
  })

  .get("/professionals/id/:id", async ({ params }) => {
    try { return await svc.getProfileById(params.id); }
    catch (e) { return serviceError(e); }
  })

  // Reviews — specific paths before generic /:slug

  .get("/professionals/:slug/reviews", async ({ params }) => {
    try { return await svc.getReviews(params.slug); }
    catch (e) { return serviceError(e); }
  })

  // Generic slug — LAST GET

  .get("/professionals/:slug", async ({ params }) => {
    try { return await svc.getPublicProfile(params.slug); }
    catch (e) { return serviceError(e); }
  })

  // ── Escritura (strictRateLimit desde acá) ───────────────────────────────────

  .use(strictRateLimit)

  .post("/professionals/:slug/reviews", async ({ params, body, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try {
      const review = await svc.addReview(params.slug, clerkUserId, body as Record<string, unknown>);
      return new Response(JSON.stringify(review), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  .post("/professionals/:slug/reviews/:reviewId/report", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.reportReview(params.reviewId, clerkUserId); }
    catch (e) { return serviceError(e); }
  })

  .post("/professionals/:slug/recommend", async ({ params, headers }) => {
    try {
      const ip = headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? "unknown";
      return await svc.recommendProfessional(params.slug, ip);
    } catch (e) { return serviceError(e); }
  })

  // Static POSTs — before generic POST /professionals

  .post("/professionals/auth", async ({ body }) => {
    try {
      const b = body as Record<string, unknown>;
      return await svc.authWithPin(b.whatsapp as string, b.pin as string);
    } catch (e) { return serviceError(e); }
  })

  .post("/professionals", async ({ body, clerkUserId }) => {
    try {
      const pro = await svc.createProfessional(clerkUserId, body as Record<string, unknown>);
      return new Response(JSON.stringify(pro), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  // Profile management

  .put("/professionals/me", async ({ body, clerkUserId, headers }) => {
    try {
      const proCode = headers["x-professional-code"];
      return await svc.updateMyProfile(clerkUserId, proCode, body as Record<string, unknown>);
    } catch (e) { return serviceError(e); }
  })

  .post("/professionals/me/photo", async ({ clerkUserId, headers, request }) => {
    try {
      const proCode = headers["x-professional-code"];
      const fd      = await request.formData();
      const file    = fd.get("photo") as File | null;
      return await svc.uploadProfilePhoto(clerkUserId, proCode, file);
    } catch (e) { return serviceError(e); }
  })

  .post("/professionals/me/fotos", async ({ clerkUserId, headers, request }) => {
    try {
      const proCode = headers["x-professional-code"];
      const fd      = await request.formData();
      const file    = fd.get("photo") as File | null;
      return await svc.addGalleryPhoto(clerkUserId, proCode, file);
    } catch (e) { return serviceError(e); }
  })

  .delete("/professionals/me/fotos", async ({ clerkUserId, headers, body }) => {
    try {
      const proCode = headers["x-professional-code"];
      const { fotoUrl } = body as { fotoUrl: string };
      return await svc.deleteGalleryPhoto(clerkUserId, proCode, fotoUrl);
    } catch (e) { return serviceError(e); }
  })

  .get("/conversations/unread-count", async ({ clerkUserId }) => {
    try {
      if (!clerkUserId) return { count: 0 };
      const professional = await prisma.professional.findUnique({ where: { clerkUserId }, select: { id: true } });
      if (!professional) return { count: 0 };
      const count = await prisma.message.count({
        where: { read: false, senderType: "client", Conversation: { professionalId: professional.id } },
      });
      return { count };
    } catch { return { count: 0 }; }
  });
