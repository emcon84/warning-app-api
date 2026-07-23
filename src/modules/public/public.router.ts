import { Elysia } from "elysia";

export const publicRouter = new Elysia({ prefix: "/api" })
  // Public endpoints go here
  .get("/ping", () => ({ pong: true }));
