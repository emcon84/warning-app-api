import { Elysia } from "elysia";

const WINDOW_MS = 60_000;
const STANDARD_LIMIT = 60;
const STRICT_LIMIT = 10;

const standardMap = new Map<string, { count: number; resetAt: number }>();
const strictMap   = new Map<string, { count: number; resetAt: number }>();

// Limpiar entradas viejas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of standardMap) if (now > v.resetAt) standardMap.delete(k);
  for (const [k, v] of strictMap)   if (now > v.resetAt) strictMap.delete(k);
}, 300_000);

function getClientIP(headers: Record<string, string | undefined>): string {
  return (
    headers["x-forwarded-for"]?.split(",")[0].trim() ||
    headers["x-real-ip"] ||
    headers["cf-connecting-ip"] ||
    "unknown"
  );
}

function checkLimit(
  key: string,
  map: Map<string, { count: number; resetAt: number }>,
  limit: number
): boolean {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now > entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

const RATE_LIMIT_RESPONSE = {
  error: "Demasiadas solicitudes. Intentá en un momento.",
};

/**
 * Rate limit estándar: 60 req/min por IP.
 * Aplicar a escrituras generales.
 */
export const standardRateLimit = new Elysia({ name: "rateLimit-standard" })
  .onBeforeHandle({ as: "global" }, ({ headers }) => {
    const ip = getClientIP(headers as Record<string, string | undefined>);
    if (!checkLimit(ip, standardMap, STANDARD_LIMIT)) {
      return new Response(JSON.stringify(RATE_LIMIT_RESPONSE), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
  });

/**
 * Rate limit estricto: 10 req/min por IP.
 * Aplicar a creaciones críticas (registros, reviews, etc).
 */
export const strictRateLimit = new Elysia({ name: "rateLimit-strict" })
  .onBeforeHandle({ as: "global" }, ({ headers }) => {
    const ip = getClientIP(headers as Record<string, string | undefined>);
    if (!checkLimit(ip, strictMap, STRICT_LIMIT)) {
      return new Response(JSON.stringify(RATE_LIMIT_RESPONSE), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
  });
