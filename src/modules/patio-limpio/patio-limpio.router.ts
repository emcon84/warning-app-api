import { Elysia } from "elysia";
import * as svc from "./patio-limpio.service";

export const patioLimpioRouter = new Elysia({ prefix: "/api" })

  .get("/patio-limpio", async ({ set }) => {
    try {
      // Try cached first
      const cached = svc.getCached();
      if (cached) {
        set.headers["Cache-Control"] = "public, max-age=3600, s-maxage=86400";
        return cached;
      }

      // Scrape fresh
      const data = await svc.scrapePatioLimpio();
      set.headers["Cache-Control"] = "public, max-age=3600, s-maxage=86400";
      return data;
    } catch (e: any) {
      set.status = e?.status || 500;
      return { error: e?.message || "Error interno" };
    }
  })

  .get("/patio-limpio/refresh", async ({ set }) => {
    try {
      const data = await svc.scrapePatioLimpio();
      return data;
    } catch (e: any) {
      set.status = e?.status || 500;
      return { error: e?.message || "Error interno" };
    }
  });
