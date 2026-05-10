import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit, strictRateLimit } from "../../plugins/rateLimit";
import * as svc from "./doctors.service";

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
  console.error("[doctors]", e);
  return httpError(500, "Error interno del servidor");
}

// ── Router ────────────────────────────────────────────────────────────────────

export const doctorsRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)
  .use(standardRateLimit)

  // ── Lectura pública ─────────────────────────────────────────────────────────

  .get("/doctors", async ({ query }) => {
    try {
      return await svc.listDoctors({
        especialidad: query.especialidad,
        obraSocial:   query.obraSocial,
        ciudad:        query.ciudad,
        iapos:         query.iapos,
      });
    } catch (e) { return serviceError(e); }
  }, {
    query: t.Object({
      especialidad: t.Optional(t.String()),
      obraSocial:   t.Optional(t.String()),
      ciudad:        t.Optional(t.String()),
      iapos:         t.Optional(t.String()),
    }),
  })

  .get("/doctors/:id", async ({ params }) => {
    try { return await svc.getDoctor(params.id); }
    catch (e) { return serviceError(e); }
  })

  .get("/doctors/:id/disponibilidad", async ({ params }) => {
    try { return await svc.getDisponibilidad(params.id); }
    catch (e) { return serviceError(e); }
  })

  // ── Escritura (strictRateLimit desde acá) ───────────────────────────────────

  .use(strictRateLimit)

  .post("/doctors", async ({ body }) => {
    try {
      const doctor = await svc.createDoctor(body as Record<string, unknown>);
      return new Response(JSON.stringify(doctor), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  .put("/doctors/:id", async ({ params, body }) => {
    try { return await svc.updateDoctor(params.id, body as Record<string, unknown>); }
    catch (e) { return serviceError(e); }
  })

  .delete("/doctors/:id", async ({ params }) => {
    try { return await svc.deleteDoctor(params.id); }
    catch (e) { return serviceError(e); }
  })

  .post("/doctors/:id/confirmaciones", async ({ params, body }) => {
    try {
      const doctor = await svc.addConfirmacion(params.id, body as Record<string, unknown>);
      return new Response(JSON.stringify(doctor), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  })

  .post("/doctors/:id/disponibilidad", async ({ params, body }) => {
    try {
      const disp = await svc.addDisponibilidad(params.id, body as Record<string, unknown>);
      return new Response(JSON.stringify(disp), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) { return serviceError(e); }
  });
