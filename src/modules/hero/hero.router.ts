import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import * as svc from "./hero.service";

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
  console.error("[hero]", e);
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

export const heroRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)

  // ── Public: GET /api/hero-slides ──────────────────────────────────────────
  .get("/hero-slides", async ({ set }) => {
    try {
      const result = await svc.getActiveSlides();
      set.headers["Cache-Control"] = "public, max-age=3600, s-maxage=86400";
      return result;
    } catch (e) {
      return serviceError(e);
    }
  })

  // ── Cron: GET /api/cron/recalculate-hero-slides ──────────────────────────
  .get("/cron/recalculate-hero-slides", async ({ headers, clerkUserId, set }) => {
    // Accept either CRON_API_KEY (system cron) or admin Clerk token (admin UI)
    const apiKey = headers["x-api-key"];
    const expectedKey = process.env.CRON_API_KEY;
    const isCronAuth = expectedKey && apiKey === expectedKey;
    const isAdminAuth = clerkUserId ? isAdmin(clerkUserId) : false;

    if (!isCronAuth && !isAdminAuth) {
      set.status = 401;
      return { error: "No autorizado" };
    }

    try {
      const report = await svc.recalculateRanking();
      return { ok: true, ...report };
    } catch (e) {
      return serviceError(e);
    }
  })

  // ── Admin: CRUD for hero slides ──────────────────────────────────────────
  .get("/admin/hero-slides", async ({ clerkUserId }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try {
      return await svc.listAllSlides();
    } catch (e) {
      return serviceError(e);
    }
  })

  .post("/admin/hero-slides", async ({ clerkUserId, request }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try {
      const fd = await request.formData();
      const title = fd.get("title") as string;
      if (!title) return httpError(400, "El título es obligatorio");
      return await svc.createPromoSlide({
        title,
        subtitle: fd.get("subtitle") as string | undefined,
        ctaText: fd.get("ctaText") as string | undefined,
        ctaUrl: fd.get("ctaUrl") as string | undefined,
        file: fd.get("file") as File | null,
        startsAt: fd.get("startsAt") as string | undefined,
        endsAt: fd.get("endsAt") as string | undefined,
      });
    } catch (e) {
      return serviceError(e);
    }
  })

  .put("/admin/hero-slides/:id", async ({ clerkUserId, params, request }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try {
      const ct = request.headers.get("content-type") ?? "";
      if (ct.includes("multipart/form-data")) {
        const fd = await request.formData();
        return await svc.updatePromoSlide(params.id, {
          title: fd.get("title") as string | undefined,
          subtitle: fd.get("subtitle") as string | null,
          ctaText: fd.get("ctaText") as string | null,
          ctaUrl: fd.get("ctaUrl") as string | null,
          file: fd.get("file") as File | null,
          imagePosition: fd.get("imagePosition") as string | undefined,
          isPinned: fd.get("isPinned") === "true" ? true : fd.get("isPinned") === "false" ? false : undefined,
          sortOrder: fd.get("sortOrder") ? parseInt(fd.get("sortOrder") as string) : undefined,
          startsAt: fd.get("startsAt") as string | null,
          endsAt: fd.get("endsAt") as string | null,
        });
      }
      const json = await request.json() as Record<string, unknown>;
      return await svc.updatePromoSlide(params.id, {
        title: json.title as string | undefined,
        subtitle: json.subtitle as string | null | undefined,
        ctaText: json.ctaText as string | null | undefined,
        ctaUrl: json.ctaUrl as string | null | undefined,
        imageUrl: json.imageUrl as string | null | undefined,
        imagePosition: json.imagePosition as string | undefined,
        isPinned: json.isPinned as boolean | undefined,
        sortOrder: json.sortOrder as number | undefined,
        startsAt: json.startsAt as string | null | undefined,
        endsAt: json.endsAt as string | null | undefined,
      });
    } catch (e) {
      return serviceError(e);
    }
  })

  .patch("/admin/hero-slides/:id/pin", async ({ clerkUserId, params, body }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try {
      const isPinned = (body as Record<string, unknown>).isPinned === true;
      return await svc.toggleSlidePin(params.id, isPinned);
    } catch (e) {
      return serviceError(e);
    }
  })

  .delete("/admin/hero-slides/:id", async ({ clerkUserId, params }) => {
    if (!clerkUserId) return httpError(401, "No autorizado");
    if (!isAdmin(clerkUserId)) return httpError(403, "Acceso denegado");
    try {
      return await svc.removeSlide(params.id);
    } catch (e) {
      return serviceError(e);
    }
  });
