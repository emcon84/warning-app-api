import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit, strictRateLimit } from "../../plugins/rateLimit";
import * as svc from "./admin.service";

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
  console.error("[admin]", e);
  return httpError(500, "Error interno del servidor");
}

function getAdminIds(): string[] {
  return (process.env.ADMIN_CLERK_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function isAdmin(clerkUserId: string | null): boolean {
  if (!clerkUserId) return false;
  return getAdminIds().includes(clerkUserId);
}

// ── Router ────────────────────────────────────────────────────────────────────

export const adminRouter = new Elysia({ prefix: "/api/admin" })
  .use(authPlugin)
  .use(standardRateLimit)

  // ── Professionals ───────────────────────────────────────────────────────────

  .get("/professionals", async ({ clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.listProfessionals(); }
    catch (e) { return serviceError(e); }
  })

  .use(strictRateLimit)

  .patch("/professionals/:id/pin", async ({ clerkUserId, params, body }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.setPin(params.id, (body as Record<string, unknown>).pin); }
    catch (e) { return serviceError(e); }
  })

  .delete("/professionals/:id", async ({ clerkUserId, params }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.removeProfessional(params.id); }
    catch (e) { return serviceError(e); }
  })

  // ── Reports ─────────────────────────────────────────────────────────────────

  .get("/reports", async ({ clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.listReports(); }
    catch (e) { return serviceError(e); }
  })

  .delete("/reports/:id", async ({ clerkUserId, params }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.removeReport(params.id); }
    catch (e) { return serviceError(e); }
  })

  // ── Reviews ─────────────────────────────────────────────────────────────────

  .get("/reviews", async ({ clerkUserId, query }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.listReviews(query.reported); }
    catch (e) { return serviceError(e); }
  }, { query: t.Object({ reported: t.Optional(t.String()) }) })

  .delete("/reviews/:id", async ({ clerkUserId, params }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.removeReview(params.id); }
    catch (e) { return serviceError(e); }
  })

  // ── Stores (routes kept as /comercios — frontend contract) ──────────────────

  .get("/comercios", async ({ clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.listStores(); }
    catch (e) { return serviceError(e); }
  })

  // /premium before /:id to avoid Elysia capturing "premium" as id param
  .patch("/comercios/:id/premium", async ({ clerkUserId, params, body }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.togglePremium(params.id, (body as Record<string, unknown>).isPremium); }
    catch (e) { return serviceError(e); }
  })

  .patch("/comercios/:id", async ({ clerkUserId, params, body }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.patchStore(params.id, body as Record<string, unknown>); }
    catch (e) { return serviceError(e); }
  })

  .delete("/comercios/:id", async ({ clerkUserId, params }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try { return await svc.removeStore(params.id); }
    catch (e) { return serviceError(e); }
  });
