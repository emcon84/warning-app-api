import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit, strictRateLimit } from "../../plugins/rateLimit";
import * as svc from "./posts.service";

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
  console.error("[posts]", e);
  return httpError(500, "Error interno del servidor");
}

// ── Router ────────────────────────────────────────────────────────────────────

export const postsRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)
  .use(standardRateLimit)

  // ── Públicos (lectura) ──────────────────────────────────────────────────────

  // Static route must come before /:postId to avoid "recientes" being captured as postId
  .get("/posts/recientes", async ({ query }) => {
    try { return await svc.getRecentPosts(query.limit); }
    catch (e) { return serviceError(e); }
  }, { query: t.Object({ limit: t.Optional(t.String()) }) })

  .get("/posts/:postId", async ({ params }) => {
    try { return await svc.getPostById(params.postId); }
    catch (e) { return serviceError(e); }
  })

  .get("/comercios/:slug/posts", async ({ params, query }) => {
    try { return await svc.getPostsByStore(params.slug, query.page); }
    catch (e) { return serviceError(e); }
  }, { query: t.Object({ page: t.Optional(t.String()) }) })

  // ── Escritura (strictRateLimit aplica desde acá) ────────────────────────────

  .use(strictRateLimit)

  .post("/posts/:postId/like", async ({ params, body }) => {
    try { return await svc.toggleLike(params.postId, !!(body as any)?.unlike); }
    catch (e) { return serviceError(e); }
  })

  .post("/comercios/:slug/posts", async ({ params, clerkUserId, request }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try {
      const fd   = await request.formData();
      const post = await svc.createPost(params.slug, clerkUserId, fd);
      return new Response(JSON.stringify(post), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  .delete("/comercios/:slug/posts/:postId", async ({ params, clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    try { return await svc.deletePost(params.slug, params.postId, clerkUserId); }
    catch (e) { return serviceError(e); }
  });
