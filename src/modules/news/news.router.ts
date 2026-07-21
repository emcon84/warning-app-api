import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { standardRateLimit } from "../../plugins/rateLimit";
import * as svc from "./news.service";

function serviceError(e: unknown): Response {
  if (typeof e === "object" && e !== null && "status" in e) {
    const err = e as { status: number; message: string };
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  console.error("[news]", e);
  return new Response(JSON.stringify({ error: "Error interno del servidor" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

svc.startPeriodicRefresh();

export const newsRouter = new Elysia({ prefix: "/api" })
  .use(authPlugin)
  .use(standardRateLimit)

  .get("/news", async ({ query }) => {
    try {
      return await svc.getNews(query.portal || "reconquistahoy");
    } catch (e) { return serviceError(e); }
  }, {
    query: t.Object({
      portal: t.Optional(t.String()),
    }),
  })

  .get("/news/refresh", async ({ query }) => {
    try {
      return await svc.refreshNews(query.portal || "reconquistahoy");
    } catch (e) { return serviceError(e); }
  }, {
    query: t.Object({
      portal: t.Optional(t.String()),
    }),
  });
