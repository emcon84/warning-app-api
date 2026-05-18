import { Elysia } from "elysia";
import { verifyToken } from "@clerk/backend";

const AUTHORIZED_PARTIES = [
  "http://localhost:3000",
  "https://reportesreconquista.com",
  "https://dev.reportesreconquista.com",
];

/**
 * Plugin de autenticación Clerk.
 * Inyecta `clerkUserId: string | null` en el contexto de cada request.
 * Las rutas que requieren auth verifican que no sea null.
 */
export const authPlugin = new Elysia({ name: "auth" }).derive(
  { as: "global" },
  async ({ headers }) => {
    const authorization = headers["authorization"];
    if (!authorization?.startsWith("Bearer ")) return { clerkUserId: null };

    const token = authorization.slice(7);
    if (token.split(".").length !== 3) return { clerkUserId: null };

    try {
      const payload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY!,
        authorizedParties: AUTHORIZED_PARTIES,
      });
      return { clerkUserId: payload.sub as string };
    } catch (e: any) {
      if (e?.reason === "token-expired" || e?.reason === "token-invalid") {
        return { clerkUserId: null };
      }
      console.error("[auth] unexpected error:", e?.message);
      return { clerkUserId: null };
    }
  }
);

/**
 * Helper para rutas que requieren autenticación obligatoria.
 * Lanza 401 si clerkUserId es null.
 */
export const requireAuth = new Elysia({ name: "requireAuth" })
  .use(authPlugin)
  .onBeforeHandle({ as: "scoped" }, ({ clerkUserId }) => {
    if (!clerkUserId)
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
  });
