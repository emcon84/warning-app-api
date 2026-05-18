import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit, strictRateLimit } from "../../plugins/rateLimit";
import * as svc from "./reports.service";

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
  console.error("[reports]", e);
  return httpError(500, "Error interno del servidor");
}

// ── Router ────────────────────────────────────────────────────────────────────

export const reportsRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)
  .use(standardRateLimit)

  // ── Lectura pública ─────────────────────────────────────────────────────────

  .get("/stats", async () => {
    try { return await svc.getStats(); }
    catch (e) { return serviceError(e); }
  })

  .get("/reports", async ({ query }) => {
    try {
      return await svc.listReports({
        category:  query.category,
        barrio:    query.barrio,
        startDate: query.startDate,
        endDate:   query.endDate,
      });
    } catch (e) { return serviceError(e); }
  }, {
    query: t.Object({
      category:  t.Optional(t.String()),
      barrio:    t.Optional(t.String()),
      startDate: t.Optional(t.String()),
      endDate:   t.Optional(t.String()),
    }),
  })

  .get("/reports/:id", async ({ params }) => {
    try { return await svc.getReport(params.id); }
    catch (e) { return serviceError(e); }
  })

  // ── Escritura (strictRateLimit desde acá) ───────────────────────────────────

  .use(strictRateLimit)

  .post("/reports", async ({ request }) => {
    try {
      const fd     = await request.formData();
      const report = await svc.createReport(fd);
      return new Response(JSON.stringify(report), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  .put("/reports/:id", async ({ params, body }) => {
    try { return await svc.updateReport(params.id, body as Record<string, unknown>); }
    catch (e) { return serviceError(e); }
  })

  .delete("/reports/:id", async ({ params }) => {
    try { return await svc.deleteReport(params.id); }
    catch (e) { return serviceError(e); }
  });
