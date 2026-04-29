import { db } from "./lib/db";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import webPush from "web-push";
import { OBRAS_SOCIALES } from "./lib/constants";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { PrismaClient } from "@prisma/client";
import { Resend } from "resend";

// Declaración global para que TypeScript reconozca Bun
declare global {
  const Bun: {
    write: (
      path: string,
      data: ArrayBuffer | Uint8Array | string,
    ) => Promise<void>;
  };
}

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const prisma = new PrismaClient();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

// ── Rate limiting ─────────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 60; // requests por ventana
const RATE_WINDOW = 60_000; // 1 minuto en ms

const strictRateLimitMap = new Map<
  string,
  { count: number; resetAt: number }
>();
const STRICT_RATE_LIMIT = 10; // requests por ventana para escrituras críticas

function getRateLimitKey(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

function checkRateLimit(req: Request): boolean {
  const key = getRateLimitKey(req);
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function checkStrictRateLimit(req: Request): boolean {
  const key = getRateLimitKey(req);
  const now = Date.now();
  const entry = strictRateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    strictRateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= STRICT_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Limpiar entradas viejas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
  for (const [key, entry] of strictRateLimitMap.entries()) {
    if (now > entry.resetAt) strictRateLimitMap.delete(key);
  }
}, 5 * 60_000);

// ── Sanitización ──────────────────────────────────────────────────────────────

function sanitizeText(input: unknown, maxLength = 1000): string {
  if (typeof input !== "string") return "";
  return (
    input
      .trim()
      .slice(0, maxLength)
      // Remover caracteres de control excepto newlines y tabs
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      // Remover secuencias que parecen SQL injection
      .replace(
        /(['";])\s*(--|\/\*|DROP|DELETE|INSERT|UPDATE|SELECT|UNION|ALTER|CREATE|EXEC|EXECUTE)\s/gi,
        "",
      )
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function verifyClerkToken(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  // Si no tiene forma de JWT (3 partes separadas por puntos), no intentar verificar
  if (token.split(".").length !== 3) return null;
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
      authorizedParties: [
        "http://localhost:3000",
        "http://reportesreconquista.com",
        "https://reportesreconquista.com",
      ],
    });
    return payload.sub;
  } catch (e: any) {
    // token-expired y token-invalid son casos normales (refresh de Clerk), no loguear
    if (e?.reason === "token-expired" || e?.reason === "token-invalid")
      return null;
    console.error("[verifyClerkToken] unexpected error:", e);
    return null;
  }
}

function generateSlug(
  nombre: string,
  apellido: string,
  oficios: string[],
): string {
  const base = `${nombre}-${apellido}-${oficios[0] ?? "oficio"}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

async function recalcProfessionalRating(professionalId: string) {
  const result = await prisma.rating.aggregate({
    where: { professionalId, scoreByClient: { not: null } },
    _avg: { scoreByClient: true },
    _count: { scoreByClient: true },
  });
  await prisma.professional.update({
    where: { id: professionalId },
    data: {
      ratingAvg: result._avg.scoreByClient ?? 0,
      ratingCount: result._count.scoreByClient,
    },
  });
}

// Caché en memoria para el turno de farmacias (1 hora)
let turnoCache: { timestamp: number; data: any } | null = null;

// Cargar .env manualmente (necesario para PM2)
try {
  const envPath = join(import.meta.dir, ".env");
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    envContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0) {
          const value = valueParts.join("=").replace(/^["']|["']$/g, "");
          process.env[key.trim()] = value.trim();
        }
      }
    });
    console.log("✅ Variables .env cargadas correctamente");
  }
} catch (error) {
  console.error("⚠️ Error cargando .env:", error);
}

// Configurar VAPID
webPush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@reconquista.gob.ar",
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
);

// Opciones de push: urgency high para que FCM entregue inmediatamente aunque la pantalla esté apagada
const PUSH_OPTIONS = { urgency: "high" as const, TTL: 60 };

// Tipos
type ReportCategory =
  | "basura"
  | "alumbrado"
  | "baches"
  | "pastizales"
  | "robo"
  | "personas_sospechosas"
  | "fugas_agua"
  | "drenaje"
  | "banquetas"
  | "semaforos"
  | "limpieza"
  | "graffiti"
  | "escombros"
  | "arboles"
  | "vandalismo"
  | "vehiculos_abandonados"
  | "iluminacion"
  | "animales_callejeros"
  | "plagas"
  | "senalizacion"
  | "estacionamiento"
  | "transporte";

interface CreateReportBody {
  lat: number;
  lng: number;
  category: ReportCategory;
  description: string;
  barrio: string;
  direccion: string;
  photo?: string;
  fecha?: string;
  isUrgent?: boolean;
}

// Crear directorio uploads si no existe
const uploadsDir = join(import.meta.dir, "uploads");
if (!existsSync(uploadsDir)) {
  mkdirSync(uploadsDir, { recursive: true });
}

// Crear tablas de ofertas si no existen
await db.query(`
  CREATE TABLE IF NOT EXISTS "Supermarket" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    lat DOUBLE PRECISION DEFAULT -29.15,
    lng DOUBLE PRECISION DEFAULT -59.65,
    logo TEXT,
    "createdAt" TIMESTAMP DEFAULT NOW()
  )
`);
await db.query(`
  CREATE TABLE IF NOT EXISTS "Offer" (
    id TEXT PRIMARY KEY,
    "supermarketId" TEXT NOT NULL,
    description TEXT NOT NULL,
    price TEXT DEFAULT '',
    photo TEXT,
    "validUntil" DATE,
    "createdAt" TIMESTAMP DEFAULT NOW()
  )
`);

await db.query(`
  CREATE TABLE IF NOT EXISTS "PageView" (
    id TEXT PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    section TEXT NOT NULL,
    "createdAt" TIMESTAMP DEFAULT NOW()
  )
`);
await db.query(
  `CREATE INDEX IF NOT EXISTS "PageView_sessionId_idx" ON "PageView" ("sessionId")`,
);
await db.query(
  `CREATE INDEX IF NOT EXISTS "PageView_createdAt_idx" ON "PageView" ("createdAt")`,
);

// Configuración CORS
const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Professional-Code",
};

// Servidor Bun
const server = Bun.serve({
  port: process.env.PORT || 3001,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Manejar preflight CORS
    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Rutas excluidas del rate limit:
    // - WebSocket y assets estáticos
    // - GETs públicos de lectura (no necesitan protección, el SW los cachea)
    const isPublicReadGet =
      method === "GET" &&
      (path === "/api/health" ||
        path.startsWith("/api/reports") ||
        path.startsWith("/api/doctors") ||
        path.startsWith("/api/farmacias") ||
        path.startsWith("/api/stats") ||
        path.startsWith("/api/offers") ||
        path.startsWith("/api/supermarkets") ||
        path.startsWith("/api/profesionales") ||
        path.startsWith("/api/comercios") ||
        path.startsWith("/api/empleados") ||
        path.startsWith("/api/vacantes"));

    if (!isPublicReadGet && path !== "/ws" && !path.startsWith("/uploads/")) {
      if (!checkRateLimit(req)) {
        return new Response(
          JSON.stringify({
            error: "Demasiadas solicitudes. Intentá en un momento.",
          }),
          {
            status: 429,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
              "Retry-After": "60",
            },
          },
        );
      }
    }

    // Health check
    if (path === "/api/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // WebSocket upgrade — /ws?conversationId=xxx&token=yyy&senderType=client|professional
    if (path === "/ws") {
      const conversationId = url.searchParams.get("conversationId");
      const token = url.searchParams.get("token");
      const senderType = url.searchParams.get("senderType") as
        | "client"
        | "professional"
        | null;

      if (!conversationId || !token || !senderType) {
        return new Response(JSON.stringify({ error: "Faltan parámetros" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { Professional: true },
      });

      if (!conversation) {
        return new Response(
          JSON.stringify({ error: "Conversación no encontrada" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // Validar que el token pertenece a esta conversación
      let isClient = false;
      let isProfessional = false;

      // Para ambos tipos: intentar verificar como JWT de Clerk primero
      try {
        const fakeReq = new Request("http://x", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const clerkUserId = await verifyClerkToken(fakeReq);
        if (clerkUserId) {
          if (senderType === "professional") {
            isProfessional =
              clerkUserId === conversation.Professional.clerkUserId;
          } else if (senderType === "client") {
            // El clientToken en la DB es el userId de Clerk del cliente
            isClient = conversation.clientToken === clerkUserId;
          }
        }
      } catch {}

      // Fallback: comparación directa del token (para conversaciones anónimas legacy)
      if (!isClient && senderType === "client") {
        isClient = conversation.clientToken === token;
      }

      if (!isClient && !isProfessional) {
        return new Response(JSON.stringify({ error: "No autorizado" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const upgraded = server.upgrade(req, {
        data: { conversationId, senderType, token },
      });

      if (upgraded) return undefined as any;
      return new Response(
        JSON.stringify({ error: "WebSocket upgrade fallido" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    try {
      // GET /uploads/:filename - Servir imágenes
      if (path.startsWith("/uploads/") && method === "GET") {
        const filename = path.split("/")[2];
        const filePath = join(uploadsDir, filename);

        if (!existsSync(filePath)) {
          return new Response("Imagen no encontrada", { status: 404 });
        }

        const file = Bun.file(filePath);
        return new Response(file);
      }

      // GET /api/reports - Obtener todos los reportes
      if (path === "/api/reports" && method === "GET") {
        const category = url.searchParams.get("category");
        const barrio = url.searchParams.get("barrio");
        const startDate = url.searchParams.get("startDate");
        const endDate = url.searchParams.get("endDate");

        let query = 'SELECT * FROM "Report" WHERE 1=1';
        const params: any[] = [];
        let paramCount = 1;

        if (category) {
          query += ` AND category = $${paramCount++}`;
          params.push(category);
        }
        if (barrio) {
          query += ` AND barrio ILIKE $${paramCount++}`;
          params.push(`%${barrio}%`);
        }
        if (startDate) {
          query += ` AND "createdAt" >= $${paramCount++}`;
          params.push(new Date(startDate));
        }
        if (endDate) {
          query += ` AND "createdAt" <= $${paramCount++}`;
          params.push(new Date(endDate));
        }

        query += ' ORDER BY "createdAt" DESC';

        const result = await db.query(query, params);

        return new Response(JSON.stringify(result.rows), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/reports/:id - Obtener un reporte específico
      if (path.startsWith("/api/reports/") && method === "GET") {
        const id = path.split("/")[3];

        const result = await db.query('SELECT * FROM "Report" WHERE id = $1', [
          id,
        ]);

        if (result.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Reporte no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        return new Response(JSON.stringify(result.rows[0]), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/reports - Crear un nuevo reporte
      if (path === "/api/reports" && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(
            JSON.stringify({
              error: "Demasiadas solicitudes. Intentá en un momento.",
            }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          );
        }
        const contentType = req.headers.get("content-type") || "";

        let body: any;
        let photoPaths: string[] = [];

        // Manejar FormData (con imágenes)
        if (contentType.includes("multipart/form-data")) {
          const formData = await req.formData();

          body = {
            lat: parseFloat(formData.get("lat") as string),
            lng: parseFloat(formData.get("lng") as string),
            category: formData.get("category") as ReportCategory,
            description: formData.get("description") as string,
            barrio: formData.get("barrio") as string,
            direccion: formData.get("direccion") as string,
            fecha: formData.get("fecha") as string,
          };

          // Obtener todas las fotos (photo, photo0, photo1, photo2, etc.)
          const photos: File[] = [];

          // Intentar obtener 'photo' (compatibilidad)
          const singlePhoto = formData.get("photo") as File | null;
          if (singlePhoto && singlePhoto.size > 0) {
            photos.push(singlePhoto);
          }

          // Intentar obtener múltiples fotos (photo0, photo1, etc.)
          let index = 0;
          while (true) {
            const photo = formData.get(`photo${index}`) as File | null;
            if (!photo || photo.size === 0) break;
            photos.push(photo);
            index++;
          }

          // Guardar todas las fotos
          for (const photo of photos) {
            const ext = photo.name.split(".").pop() || "jpg";
            const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${ext}`;
            const filePath = join(uploadsDir, filename);
            await Bun.write(filePath, await photo.arrayBuffer());
            photoPaths.push(`/uploads/${filename}`);
          }
        } else {
          // Manejar JSON (sin imagen o con base64 - retrocompatibilidad)
          const contentLength = parseInt(
            req.headers.get("content-length") || "0",
          );
          if (contentLength > 10 * 1024 * 1024) {
            return new Response(
              JSON.stringify({ error: "Payload demasiado grande" }),
              { status: 413, headers: corsHeaders },
            );
          }
          body = await req.json();
          body.description = sanitizeText(body.description, 1000);
          body.category = sanitizeText(body.category, 100);
          if (body.photo) {
            photoPaths = [body.photo];
          }
        }

        // Validaciones
        if (
          !body.lat ||
          !body.lng ||
          !body.category ||
          !body.description ||
          !body.barrio ||
          !body.direccion
        ) {
          return new Response(
            JSON.stringify({ error: "Faltan campos requeridos" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const createdAt = body.fecha ? new Date(body.fecha) : new Date();
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const result = await db.query(
          `INSERT INTO "Report" (id, lat, lng, category, description, barrio, direccion, photo, photos, "isUrgent", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            id,
            body.lat,
            body.lng,
            body.category,
            body.description,
            body.barrio,
            body.direccion,
            photoPaths[0] || null, // Mantener compatibilidad con photo
            photoPaths, // Array de fotos
            body.isUrgent || false,
            createdAt,
            createdAt,
          ],
        );

        const newReport = result.rows[0];

        // Enviar notificaciones push a todos los suscriptores
        try {
          const subscriptions = await db.query(
            'SELECT endpoint, p256dh, auth FROM "PushSubscription"',
          );

          const notificationPayload = JSON.stringify({
            title: `Nuevo Reporte: ${newReport.category}`,
            body: `${newReport.description.substring(0, 100)}${newReport.description.length > 100 ? "..." : ""}`,
            icon: "/icon-192x192.png",
            badge: "/icon-192x192.png",
            data: {
              reportId: newReport.id,
              url: "/",
            },
          });

          const sendPromises = subscriptions.rows.map(async (sub) => {
            try {
              await webPush.sendNotification(
                {
                  endpoint: sub.endpoint,
                  keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth,
                  },
                },
                notificationPayload,
                PUSH_OPTIONS,
              );
            } catch (error: any) {
              console.error("Error enviando notificación:", error);
              // Si la suscripción es inválida (410), eliminarla
              if (error.statusCode === 410) {
                await db.query(
                  'DELETE FROM "PushSubscription" WHERE endpoint = $1',
                  [sub.endpoint],
                );
              }
            }
          });

          await Promise.all(sendPromises);
          console.log(
            `Notificaciones enviadas a ${subscriptions.rows.length} suscriptores`,
          );
        } catch (notifError) {
          console.error("Error enviando notificaciones push:", notifError);
          // No fallar la creación del reporte si las notificaciones fallan
        }

        return new Response(JSON.stringify(newReport), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/reports/:id - Actualizar un reporte
      if (path.startsWith("/api/reports/") && method === "PUT") {
        const id = path.split("/")[3];
        const body = (await req.json()) as Partial<CreateReportBody>;

        const updates: string[] = [];
        const params: any[] = [];
        let paramCount = 1;

        if (body.lat !== undefined) {
          updates.push(`lat = $${paramCount++}`);
          params.push(body.lat);
        }
        if (body.lng !== undefined) {
          updates.push(`lng = $${paramCount++}`);
          params.push(body.lng);
        }
        if (body.category) {
          updates.push(`category = $${paramCount++}`);
          params.push(body.category);
        }
        if (body.description) {
          updates.push(`description = $${paramCount++}`);
          params.push(body.description);
        }
        if (body.barrio) {
          updates.push(`barrio = $${paramCount++}`);
          params.push(body.barrio);
        }
        if (body.direccion) {
          updates.push(`direccion = $${paramCount++}`);
          params.push(body.direccion);
        }
        if (body.photo !== undefined) {
          updates.push(`photo = $${paramCount++}`);
          params.push(body.photo);
        }

        updates.push(`"updatedAt" = $${paramCount++}`);
        params.push(new Date());

        params.push(id);

        const result = await db.query(
          `UPDATE "Report" SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
          params,
        );

        if (result.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Reporte no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        return new Response(JSON.stringify(result.rows[0]), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/reports/:id - Actualizar un reporte
      if (path.startsWith("/api/reports/") && method === "PUT") {
        const id = path.split("/")[3];
        const formData = await req.formData();

        const category = formData.get("category") as ReportCategory;
        const description = formData.get("description") as string;
        const barrio = formData.get("barrio") as string;
        const direccion = formData.get("direccion") as string;
        const isUrgent = formData.get("isUrgent") === "true";

        // Validar campos requeridos
        if (!category || !description || !barrio || !direccion) {
          return new Response(
            JSON.stringify({ error: "Faltan campos requeridos" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Manejar fotos nuevas si se enviaron
        const photoFiles: File[] = [];
        let photoIndex = 0;
        while (formData.has(`photo${photoIndex}`)) {
          const file = formData.get(`photo${photoIndex}`) as File;
          if (file && file.size > 0) {
            photoFiles.push(file);
          }
          photoIndex++;
        }

        let photoPaths: string[] = [];
        if (photoFiles.length > 0) {
          // Guardar las nuevas fotos
          for (const file of photoFiles) {
            const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
            const filepath = join(uploadsDir, filename);
            await Bun.write(filepath, await file.arrayBuffer());
            photoPaths.push(`/uploads/${filename}`);
          }
        } else {
          // Mantener las fotos existentes si no se subieron nuevas
          const existingReport = await db.query(
            'SELECT photos FROM "Report" WHERE id = $1',
            [id],
          );
          if (existingReport.rows.length > 0) {
            photoPaths = existingReport.rows[0].photos || [];
          }
        }

        // Actualizar el reporte
        const result = await db.query(
          `UPDATE "Report" 
           SET category = $1, description = $2, barrio = $3, direccion = $4, 
               photos = $5, "isUrgent" = $6, "updatedAt" = NOW()
           WHERE id = $7
           RETURNING *`,
          [category, description, barrio, direccion, photoPaths, isUrgent, id],
        );

        if (result.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Reporte no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const updatedReport = result.rows[0];

        return new Response(JSON.stringify(updatedReport), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/reports/:id - Eliminar un reporte
      if (path.startsWith("/api/reports/") && method === "DELETE") {
        const id = path.split("/")[3];

        const result = await db.query(
          'DELETE FROM "Report" WHERE id = $1 RETURNING *',
          [id],
        );

        if (result.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Reporte no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        return new Response(JSON.stringify({ message: "Reporte eliminado" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/stats - Estadísticas
      if (path === "/api/stats" && method === "GET") {
        const totalResult = await db.query(
          'SELECT COUNT(*) as total FROM "Report"',
        );
        const byCategoryResult = await db.query(
          'SELECT category, COUNT(*) as count FROM "Report" GROUP BY category',
        );
        const byBarrioResult = await db.query(
          'SELECT barrio, COUNT(*) as count FROM "Report" GROUP BY barrio ORDER BY count DESC LIMIT 10',
        );
        const recentResult = await db.query(
          'SELECT * FROM "Report" ORDER BY "createdAt" DESC LIMIT 5',
        );

        return new Response(
          JSON.stringify({
            total: parseInt(totalResult.rows[0].total),
            byCategory: byCategoryResult.rows,
            byBarrio: byBarrioResult.rows,
            recent: recentResult.rows,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // POST /api/push/subscribe - Suscribir a notificaciones push
      if (path === "/api/push/subscribe" && method === "POST") {
        const body = await req.json();
        const { endpoint, keys, clientToken: bodyClientToken } = body;

        if (!endpoint || !keys?.p256dh || !keys?.auth) {
          return new Response(
            JSON.stringify({ error: "Datos de suscripción inválidos" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Si el usuario está logueado, asociar la suscripción con su clerkUserId
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        // clientToken identifica usuarios anónimos para poder notificarles cuando alguien les responde
        const clientToken = bodyClientToken || null;

        await db.query(
          `INSERT INTO "PushSubscription" (id, endpoint, p256dh, auth, "clerkUserId", "clientToken", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (endpoint) DO UPDATE SET
           p256dh = $2, auth = $3, "clerkUserId" = $4, "clientToken" = $5, "updatedAt" = NOW()`,
          [endpoint, keys.p256dh, keys.auth, clerkUserId, clientToken],
        );

        return new Response(
          JSON.stringify({ message: "Suscripción guardada exitosamente" }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // POST /api/push/unsubscribe - Desuscribir de notificaciones
      if (path === "/api/push/unsubscribe" && method === "POST") {
        const body = await req.json();
        const { endpoint } = body;

        if (!endpoint) {
          return new Response(JSON.stringify({ error: "Endpoint requerido" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        await db.query('DELETE FROM "PushSubscription" WHERE endpoint = $1', [
          endpoint,
        ]);

        return new Response(
          JSON.stringify({ message: "Suscripción eliminada exitosamente" }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // GET /api/push/vapid-public-key - Obtener clave pública VAPID
      if (path === "/api/push/vapid-public-key" && method === "GET") {
        return new Response(
          JSON.stringify({ publicKey: process.env.VAPID_PUBLIC_KEY }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // ─── DOCTORS ─────────────────────────────────────────────────────────

      // GET /api/doctors - Lista médicos con filtros opcionales
      if (path === "/api/doctors" && method === "GET") {
        const especialidad = url.searchParams.get("especialidad");
        const obraSocial = url.searchParams.get("obraSocial");
        const ciudad = url.searchParams.get("ciudad");
        const soloIapos = url.searchParams.get("iapos") === "true";

        let query = 'SELECT * FROM "Doctor" WHERE activo = true';
        const params: any[] = [];
        let paramCount = 1;

        if (soloIapos) {
          query += ` AND iapos = true`;
        }
        if (especialidad) {
          query += ` AND especialidad = $${paramCount++}`;
          params.push(especialidad);
        }
        if (ciudad) {
          query += ` AND ciudad ILIKE $${paramCount++}`;
          params.push(`%${ciudad}%`);
        }
        if (obraSocial) {
          query += ` AND $${paramCount++} = ANY("obrasSociales")`;
          params.push(obraSocial);
        }

        query += " ORDER BY nombre ASC";

        const doctorsResult = await db.query(query, params);
        const doctors = doctorsResult.rows;

        // Para cada doctor, obtener últimas 10 confirmaciones agrupadas por obraSocial
        const doctorsWithConfirmaciones = await Promise.all(
          doctors.map(async (doctor: any) => {
            const confResult = await db.query(
              `SELECT * FROM "Confirmacion"
               WHERE "doctorId" = $1
               ORDER BY "createdAt" DESC
               LIMIT 10`,
              [doctor.id],
            );
            return { ...doctor, confirmaciones: confResult.rows };
          }),
        );

        return new Response(JSON.stringify(doctorsWithConfirmaciones), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/doctors/:id - Un doctor con todas sus confirmaciones
      if (path.match(/^\/api\/doctors\/[^/]+$/) && method === "GET") {
        const id = path.split("/")[3];

        const doctorResult = await db.query(
          'SELECT * FROM "Doctor" WHERE id = $1',
          [id],
        );

        if (doctorResult.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Médico no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const confResult = await db.query(
          `SELECT * FROM "Confirmacion"
           WHERE "doctorId" = $1
           ORDER BY "createdAt" DESC`,
          [id],
        );

        const doctor = {
          ...doctorResult.rows[0],
          confirmaciones: confResult.rows,
        };

        return new Response(JSON.stringify(doctor), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/doctors - Crear doctor
      if (path === "/api/doctors" && method === "POST") {
        const body = await req.json();
        const {
          nombre,
          especialidad,
          direccion,
          barrio,
          ciudad,
          telefono,
          whatsapp,
          lat,
          lng,
          obrasSociales,
        } = body;

        if (
          !nombre ||
          !especialidad ||
          !direccion ||
          lat === undefined ||
          lng === undefined
        ) {
          return new Response(
            JSON.stringify({
              error:
                "Faltan campos requeridos: nombre, especialidad, direccion, lat, lng",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();

        const result = await db.query(
          `INSERT INTO "Doctor" (id, nombre, especialidad, direccion, barrio, ciudad, telefono, whatsapp, lat, lng, "obrasSociales", activo, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13)
           RETURNING *`,
          [
            id,
            nombre,
            especialidad,
            direccion,
            barrio || "",
            ciudad || "Reconquista",
            telefono || null,
            whatsapp || null,
            lat,
            lng,
            obrasSociales || [],
            now,
            now,
          ],
        );

        return new Response(JSON.stringify(result.rows[0]), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/doctors/:id - Actualizar doctor
      if (path.match(/^\/api\/doctors\/[^/]+$/) && method === "PUT") {
        const id = path.split("/")[3];
        const body = await req.json();

        const updates: string[] = [];
        const params: any[] = [];
        let paramCount = 1;

        if (body.nombre !== undefined) {
          updates.push(`nombre = $${paramCount++}`);
          params.push(body.nombre);
        }
        if (body.especialidad !== undefined) {
          updates.push(`especialidad = $${paramCount++}`);
          params.push(body.especialidad);
        }
        if (body.direccion !== undefined) {
          updates.push(`direccion = $${paramCount++}`);
          params.push(body.direccion);
        }
        if (body.barrio !== undefined) {
          updates.push(`barrio = $${paramCount++}`);
          params.push(body.barrio);
        }
        if (body.ciudad !== undefined) {
          updates.push(`ciudad = $${paramCount++}`);
          params.push(body.ciudad);
        }
        if (body.telefono !== undefined) {
          updates.push(`telefono = $${paramCount++}`);
          params.push(body.telefono);
        }
        if (body.whatsapp !== undefined) {
          updates.push(`whatsapp = $${paramCount++}`);
          params.push(body.whatsapp);
        }
        if (body.lat !== undefined) {
          updates.push(`lat = $${paramCount++}`);
          params.push(body.lat);
        }
        if (body.lng !== undefined) {
          updates.push(`lng = $${paramCount++}`);
          params.push(body.lng);
        }
        if (body.obrasSociales !== undefined) {
          updates.push(`"obrasSociales" = $${paramCount++}`);
          params.push(body.obrasSociales);
        }
        if (body.activo !== undefined) {
          updates.push(`activo = $${paramCount++}`);
          params.push(body.activo);
        }

        updates.push(`"updatedAt" = $${paramCount++}`);
        params.push(new Date());
        params.push(id);

        const result = await db.query(
          `UPDATE "Doctor" SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
          params,
        );

        if (result.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Médico no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        return new Response(JSON.stringify(result.rows[0]), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/doctors/:id - Eliminar doctor
      if (path.match(/^\/api\/doctors\/[^/]+$/) && method === "DELETE") {
        const id = path.split("/")[3];

        const result = await db.query(
          'DELETE FROM "Doctor" WHERE id = $1 RETURNING *',
          [id],
        );

        if (result.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Médico no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        return new Response(JSON.stringify({ message: "Médico eliminado" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/doctors/:id/confirmaciones - Agregar confirmación
      if (
        path.match(/^\/api\/doctors\/[^/]+\/confirmaciones$/) &&
        method === "POST"
      ) {
        const id = path.split("/")[3];
        const body = await req.json();
        const { obraSocial, acepta } = body;

        if (!obraSocial || acepta === undefined) {
          return new Response(
            JSON.stringify({ error: "Faltan campos: obraSocial, acepta" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Verificar que el doctor existe
        const doctorCheck = await db.query(
          'SELECT id FROM "Doctor" WHERE id = $1',
          [id],
        );
        if (doctorCheck.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Médico no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const confId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        await db.query(
          `INSERT INTO "Confirmacion" (id, "doctorId", "obraSocial", acepta, "createdAt")
           VALUES ($1, $2, $3, $4, NOW())`,
          [confId, id, obraSocial, acepta],
        );

        // Recalcular obrasSociales basándose en últimas 5 confirmaciones por obra social
        const nuevasObrasSociales: string[] = [];
        for (const os of OBRAS_SOCIALES) {
          const ultimas5 = await db.query(
            `SELECT acepta FROM "Confirmacion"
             WHERE "doctorId" = $1 AND "obraSocial" = $2
             ORDER BY "createdAt" DESC
             LIMIT 5`,
            [id, os],
          );
          if (ultimas5.rows.length > 0) {
            const aceptan = ultimas5.rows.filter((r: any) => r.acepta).length;
            const total = ultimas5.rows.length;
            if (aceptan > total / 2) {
              nuevasObrasSociales.push(os);
            }
          }
        }

        const updatedDoctor = await db.query(
          `UPDATE "Doctor" SET "obrasSociales" = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING *`,
          [nuevasObrasSociales, id],
        );

        return new Response(JSON.stringify(updatedDoctor.rows[0]), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/doctors/:id/disponibilidad - Disponibilidades vigentes
      if (
        path.match(/^\/api\/doctors\/[^/]+\/disponibilidad$/) &&
        method === "GET"
      ) {
        const id = path.split("/")[3];
        const result = await db.query(
          `SELECT * FROM "TurnoDisponibilidad"
           WHERE "doctorId" = $1 AND "expiresAt" > NOW()
           ORDER BY "createdAt" DESC
           LIMIT 5`,
          [id],
        );
        return new Response(JSON.stringify(result.rows), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/doctors/:id/disponibilidad - Reportar disponibilidad
      if (
        path.match(/^\/api\/doctors\/[^/]+\/disponibilidad$/) &&
        method === "POST"
      ) {
        const id = path.split("/")[3];
        const body = await req.json();
        const { dias, horario, tipoTurno, obraSocial, nota } = body;

        if (!dias?.length || !horario || !tipoTurno) {
          return new Response(
            JSON.stringify({ error: "Faltan campos requeridos" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const newId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días

        const result = await db.query(
          `INSERT INTO "TurnoDisponibilidad" (id, "doctorId", dias, horario, "tipoTurno", "obraSocial", nota, "expiresAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            newId,
            id,
            dias,
            horario,
            tipoTurno,
            obraSocial || "Todas",
            nota || null,
            expiresAt,
          ],
        );

        return new Response(JSON.stringify(result.rows[0]), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── FIN DOCTORS ──────────────────────────────────────────────────────

      // ─── FARMACIAS ────────────────────────────────────────────────────────

      // GET /api/farmacias - Lista todas las farmacias
      if (path === "/api/farmacias" && method === "GET") {
        const result = await db.query(
          'SELECT * FROM "Farmacia" WHERE activo = true ORDER BY nombre',
        );
        return new Response(JSON.stringify(result.rows), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/farmacias/turno - Farmacia(s) de turno hoy (scraping regionnet, caché 1h)
      if (path === "/api/farmacias/turno" && method === "GET") {
        const now = Date.now();
        if (turnoCache && now - turnoCache.timestamp < 3600_000) {
          return new Response(JSON.stringify(turnoCache.data), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        try {
          const today = new Date();
          const dd = String(today.getDate()).padStart(2, "0");
          const mm = String(today.getMonth() + 1).padStart(2, "0");
          const yyyy = today.getFullYear();
          const dateStr = `${dd}/${mm}/${yyyy}`;
          const startStr = `${yyyy}-${mm}-${dd}`;

          // End = mañana
          const tomorrow = new Date(today.getTime() + 86_400_000);
          const edd = String(tomorrow.getDate()).padStart(2, "0");
          const emm = String(tomorrow.getMonth() + 1).padStart(2, "0");
          const eyyyy = tomorrow.getFullYear();
          const endStr = `${eyyyy}-${emm}-${edd}`;

          // WordPress Event Organiser AJAX endpoint — no nonce required for public events
          const ajaxUrl = `https://regionnet.com.ar/wp-admin/admin-ajax.php?action=eventorganiser-fullcal&event_category=reconquista&start=${startStr}&end=${endStr}`;
          const events: any[] = await fetch(ajaxUrl, {
            headers: {
              "User-Agent": "warning-app/1.0",
              Referer: "https://regionnet.com.ar/servicios/farmacias/",
              "X-Requested-With": "XMLHttpRequest",
            },
          }).then((r) => r.json());

          // Eventos activos ahora: categoría reconquista + clase eo-event-running
          const nombresDeturno = events
            .filter(
              (e: any) =>
                Array.isArray(e.className) &&
                e.className.includes("eo-event-running") &&
                e.className.some((c: string) => c.includes("reconquista")),
            )
            .map((e: any) => (e.title as string).trim().toUpperCase());

          // Cruzar con farmacias en BD
          const farmaciasResult = await db.query(
            'SELECT * FROM "Farmacia" WHERE activo = true',
          );
          const todas = farmaciasResult.rows;

          const deturno =
            nombresDeturno.length > 0
              ? todas.filter((f) =>
                  nombresDeturno.some(
                    (n) =>
                      f.nombre.toUpperCase().includes(n) ||
                      n.includes(f.nombre.toUpperCase()),
                  ),
                )
              : [];

          const data = {
            fecha: dateStr,
            farmacias: deturno,
            raw: nombresDeturno,
          };
          turnoCache = { timestamp: now, data };

          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({
              fecha: "",
              farmacias: [],
              raw: [],
              error: "No se pudo obtener el turno",
            }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
      }

      // PUT /api/farmacias/:id - Actualizar farmacia (coords, dirección, etc.)
      const farmaciaUpdateMatch = path.match(/^\/api\/farmacias\/([^/]+)$/);
      if (farmaciaUpdateMatch && method === "PUT") {
        const id = farmaciaUpdateMatch[1];
        const body = (await req.json()) as {
          lat?: number;
          lng?: number;
          direccion?: string;
          nombre?: string;
          telefono?: string;
        };
        const fields: string[] = [];
        const values: any[] = [];
        let idx = 1;
        if (body.lat !== undefined) {
          fields.push(`lat = $${idx++}`);
          values.push(body.lat);
        }
        if (body.lng !== undefined) {
          fields.push(`lng = $${idx++}`);
          values.push(body.lng);
        }
        if (body.direccion !== undefined) {
          fields.push(`direccion = $${idx++}`);
          values.push(body.direccion);
        }
        if (body.nombre !== undefined) {
          fields.push(`nombre = $${idx++}`);
          values.push(body.nombre);
        }
        if (body.telefono !== undefined) {
          fields.push(`telefono = $${idx++}`);
          values.push(body.telefono);
        }
        if (!fields.length) {
          return new Response(
            JSON.stringify({ error: "Sin campos a actualizar" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        values.push(id);
        const result = await db.query(
          `UPDATE "Farmacia" SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
          values,
        );
        if (!result.rows.length) {
          return new Response(
            JSON.stringify({ error: "Farmacia no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify(result.rows[0]), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── FIN FARMACIAS ────────────────────────────────────────────────────

      // ─── VOZ ──────────────────────────────────────────────────────────────

      // Calles conocidas de Reconquista para corrección fuzzy post-transcripción
      const CALLES_RECONQUISTA = [
        "Habegger",
        "Iriondo",
        "Pellegrini",
        "Rivadavia",
        "Avellaneda",
        "Belgrano",
        "San Martín",
        "Mitre",
        "Roca",
        "Colón",
        "Sarmiento",
        "Tucumán",
        "Córdoba",
        "Mendoza",
        "Entre Ríos",
        "Corrientes",
        "La Rioja",
        "San Juan",
        "Moreno",
        "Iturraspe",
        "Ituzaingó",
        "Almafuerte",
        "Chacabuco",
        "Freyre",
        "Ludueña",
        "Bolívar",
        "Alvear",
        "Independencia",
        "Amenabar",
        "Patricio Diez",
        "Bulevar Lovato",
        "Bulevar Constituyentes",
        "25 de Mayo",
        "9 de Julio",
        "Ruta Nacional 11",
        "Fuerza Aérea",
        "Ledesma",
        "Cernadas",
        "Obligado",
        "Calle 41",
        "Calle 43",
        "Calle 44",
        "Calle 45",
        "Calle 46",
        "Calle 47",
        "Calle 48",
        "Calle 50",
        "Calle 52",
        "Calle 54",
        "Calle 56",
        "Calle 58",
        "Calle 60",
        "Calle 62",
      ];

      // Levenshtein distance
      const levenshtein = (a: string, b: string): number => {
        const m = a.length,
          n = b.length;
        const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [
          i,
          ...Array(n).fill(0),
        ]);
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++)
          for (let j = 1; j <= n; j++)
            dp[i][j] =
              a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        return dp[m][n];
      };

      // Palabras clave de problemas para corrección fonética
      const PROBLEM_CORRECTIONS: Record<string, string> = {
        vache: "bache",
        bache: "bache",
        pache: "bache",
        mache: "bache",
        vacha: "bache",
        baches: "baches",
        vaches: "baches",
        alumbrao: "alumbrado",
        alumbramiento: "alumbrado",
        basura: "basura",
        vasura: "basura",
        pastizal: "pastizal",
        pasto: "pastizal",
        yuyos: "pastizal",
        semaforo: "semáforo",
        señaforo: "semáforo",
        graffiti: "graffiti",
        grafiti: "graffiti",
        pintada: "graffiti",
        escombro: "escombro",
        cascote: "escombro",
      };

      // Corregir palabras del transcript — calles conocidas + problemas comunes
      const correctStreetNames = (text: string): string => {
        const words = text.split(/\b/);
        return words
          .map((word) => {
            if (word.length < 4) return word;
            const wordLower = word
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "");

            // Corrección de problemas comunes primero
            if (PROBLEM_CORRECTIONS[wordLower])
              return PROBLEM_CORRECTIONS[wordLower];

            // Corrección de calles por Levenshtein
            let bestMatch = "";
            let bestDist = Infinity;
            for (const calle of CALLES_RECONQUISTA) {
              if (calle.includes(" ")) continue;
              const calleLower = calle
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "");
              if (Math.abs(wordLower.length - calleLower.length) > 4) continue;
              const dist = levenshtein(wordLower, calleLower);
              const threshold = Math.max(
                2,
                Math.floor(calleLower.length * 0.3),
              );
              if (dist < bestDist && dist <= threshold) {
                bestDist = dist;
                bestMatch = calle;
              }
            }
            return bestMatch || word;
          })
          .join("");
      };

      // POST /api/voice/simple - Reporte por voz sin IA (Web Speech API)
      if (path === "/api/voice/simple" && method === "POST") {
        const body = await req.json();
        const { description, lat, lng } = body;
        if (!description || !lat || !lng) {
          return new Response(
            JSON.stringify({ error: "Faltan campos: description, lat, lng" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();
        const result = await db.query(
          `INSERT INTO "Report" (id, lat, lng, category, description, barrio, direccion, photo, photos, "isUrgent", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            id,
            lat,
            lng,
            "voz",
            description.slice(0, 500),
            "Sin especificar",
            "Sin especificar",
            null,
            [],
            false,
            now,
            now,
          ],
        );
        const newReport = result.rows[0];
        try {
          const subscriptions = await db.query(
            'SELECT endpoint, p256dh, auth FROM "PushSubscription"',
          );
          for (const sub of subscriptions.rows) {
            await webPush
              .sendNotification(
                {
                  endpoint: sub.endpoint,
                  keys: { p256dh: sub.p256dh, auth: sub.auth },
                },
                JSON.stringify({
                  title: "Nuevo reporte por voz",
                  body: description.slice(0, 80),
                  url: "/",
                }),
              )
              .catch(() => {});
          }
        } catch {}
        return new Response(JSON.stringify({ report: newReport }), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/voice/report - Crear reporte desde voz
      if (path === "/api/voice/report" && method === "POST") {
        const contentType = req.headers.get("content-type") || "";
        let transcript: string;
        let lat: number;
        let lng: number;

        if (contentType.includes("multipart/form-data")) {
          const formData = await req.formData();
          const audioFile = formData.get("audio") as File;
          lat = parseFloat(formData.get("lat") as string);
          lng = parseFloat(formData.get("lng") as string);

          if (!audioFile || !lat || !lng) {
            return new Response(
              JSON.stringify({ error: "Faltan campos: audio, lat, lng" }),
              {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }

          // Paso 1: Groq Whisper — transcripción
          const whisperForm = new FormData();
          whisperForm.append(
            "file",
            new Blob([await audioFile.arrayBuffer()], { type: "audio/webm" }),
            "audio.webm",
          );
          whisperForm.append("model", "whisper-large-v3");
          whisperForm.append("language", "es");
          whisperForm.append(
            "prompt",
            "Reporte ciudadano en Reconquista, Santa Fe, Argentina. Calles: Habegger, Iturraspe, Ituzaingó, Almafuerte, Ludueña, Amenabar, Bulevar Lovato, Patricio Diez, Ruta Nacional 11, Avellaneda, Pellegrini, Rivadavia, Iriondo.",
          );

          const whisperRes = await fetch(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
              body: whisperForm,
            },
          );

          if (!whisperRes.ok) {
            const err = await whisperRes.text();
            console.error("Whisper error:", err);
            return new Response(
              JSON.stringify({
                error: "Error al transcribir el audio. Intentá de nuevo.",
              }),
              {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }

          const whisperData = await whisperRes.json();
          const rawTranscript = whisperData.text?.trim() || "";
          const correctedTranscript = correctStreetNames(rawTranscript);
          console.log("Whisper raw:", rawTranscript);
          console.log("Whisper corrected:", correctedTranscript);

          // Paso 2: Groq LLaMA 70B — extraer JSON estructurado
          const nlpPrompt = `Sos un asistente para reportes ciudadanos de Reconquista, Santa Fe, Argentina.
Analizá este texto y devolvé SOLO un JSON válido, sin texto adicional ni markdown.

Calles de Reconquista: Habegger, Iriondo, Pellegrini, Rivadavia, Avellaneda, Belgrano, San Martín, Mitre, Roca, Colón, Sarmiento, Tucumán, Córdoba, Mendoza, Entre Ríos, Corrientes, La Rioja, San Juan, Moreno, Iturraspe, Ituzaingó, Almafuerte, Chacabuco, Freyre, Ludueña, Bolívar, Alvear, Independencia, 25 de Mayo, 9 de Julio, Bulevar Lovato, Ruta Nacional 11, Patricio Diez, Amenabar, Calle 41, Calle 43, Calle 44, Calle 45, Calle 46, Calle 47, Calle 48, Calle 50, Calle 52, Calle 54, Calle 56, Calle 58, Calle 60, Calle 62.

Categorías: basura, alumbrado, baches, pastizales, robo, personas_sospechosas, fugas_agua, drenaje, banquetas, semaforos, limpieza, graffiti, escombros, arboles, vandalismo, vehiculos_abandonados, iluminacion, animales_callejeros, plagas, senalizacion, estacionamiento, transporte.

Campos del JSON:
- "categoria": la categoría más apropiada de la lista
- "descripcion": descripción breve del problema (max 100 chars)
- "barrio": barrio mencionado o "Sin especificar" (NUNCA es nombre de calle)
- "direccion": calle + número o "Calle1 y Calle2". Si dice "ruta 11" → "Ruta Nacional 11". Si no hay dirección → "Sin especificar"
- "enviar_servicios": true si menciona avisar al municipio/servicios públicos, false si no

Texto a analizar: "${correctedTranscript}"

JSON:`;

          const llmRes = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "user", content: nlpPrompt }],
                temperature: 0.1,
                max_tokens: 200,
              }),
            },
          );

          if (!llmRes.ok) {
            const err = await llmRes.text();
            console.error("LLM error:", err);
            return new Response(
              JSON.stringify({
                error: "No se pudo interpretar el audio. Intentá de nuevo.",
              }),
              {
                status: 500,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }

          const llmData = await llmRes.json();
          const rawText = llmData.choices?.[0]?.message?.content?.trim() || "";
          console.log("LLM response:", rawText);

          let extracted: any;
          try {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("No JSON");
            extracted = JSON.parse(jsonMatch[0]);
          } catch {
            return new Response(
              JSON.stringify({
                error: "No se pudo interpretar el audio. Intentá de nuevo.",
              }),
              {
                status: 422,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }

          const CATEGORIAS = [
            "basura",
            "alumbrado",
            "baches",
            "pastizales",
            "robo",
            "personas_sospechosas",
            "fugas_agua",
            "drenaje",
            "banquetas",
            "semaforos",
            "limpieza",
            "graffiti",
            "escombros",
            "arboles",
            "vandalismo",
            "vehiculos_abandonados",
            "iluminacion",
            "animales_callejeros",
            "plagas",
            "senalizacion",
            "estacionamiento",
            "transporte",
          ];
          transcript = extracted.descripcion || "";
          const categoria = CATEGORIAS.includes(extracted.categoria)
            ? extracted.categoria
            : "basura";
          const descripcion = (extracted.descripcion || "").slice(0, 500);
          const barrio = extracted.barrio || "Sin especificar";
          const direccion = extracted.direccion || "Sin especificar";

          // Geocodificar dirección extraída
          let reportLat = lat;
          let reportLng = lng;
          if (direccion !== "Sin especificar") {
            try {
              const bbox = "-59.85,-29.30,-59.45,-28.95";
              const sepRegex = /\s+(?:y|e|-|\/|esq\.?|esquina|entre|casi)\s+/i;
              const parts = direccion
                .split(sepRegex)
                .map((s: string) => s.trim())
                .filter(Boolean);
              const isIntersection = parts.length >= 2;
              const normalize = (s: string) =>
                s
                  .replace(/[áàä]/gi, "a")
                  .replace(/[éèë]/gi, "e")
                  .replace(/[íìï]/gi, "i")
                  .replace(/[óòö]/gi, "o")
                  .replace(/[úùü]/gi, "u");

              // Extraer palabra clave para búsqueda en Overpass (último token significativo)
              const SKIP_WORDS = new Set([
                "calle",
                "avenida",
                "av",
                "bulevar",
                "blvd",
                "ruta",
                "nacional",
                "de",
                "del",
                "la",
                "los",
                "las",
                "el",
              ]);
              const overpassKeyword = (s: string): string => {
                // Aliases conocidos
                const aliases: Record<string, string> = {
                  yrigoyen: "irigoyen",
                  "hipolito irigoyen": "irigoyen",
                  "hipolito yrigoyen": "irigoyen",
                  "ruta 11": "irigoyen",
                  "ruta nacional 11": "irigoyen",
                  "san martin": "martin",
                  "25 de mayo": "mayo",
                  "9 de julio": "julio",
                  "bulevar lovato": "lovato",
                  "patricio diez": "diez",
                };
                const norm = normalize(s.toLowerCase());
                if (aliases[norm]) return aliases[norm];
                // Último token no trivial
                const tokens = norm
                  .split(/\s+/)
                  .filter((t) => t.length > 2 && !SKIP_WORDS.has(t));
                return tokens[tokens.length - 1] || norm;
              };

              const doGeocode = async (q: string) => {
                const encoded = encodeURIComponent(
                  `${q}, Reconquista, Santa Fe, Argentina`,
                );
                const res = await fetch(
                  `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=ar&viewbox=${bbox}&bounded=1`,
                  { headers: { "User-Agent": "warning-app/1.0" } },
                );
                const data = await res.json();
                return data.length > 0
                  ? {
                      lat: parseFloat(data[0].lat),
                      lng: parseFloat(data[0].lon),
                    }
                  : null;
              };
              const findIntersection = async (s1: string, s2: string) => {
                const k1 = overpassKeyword(s1);
                const k2 = overpassKeyword(s2);
                console.log(`Overpass intersection: "${k1}" ∩ "${k2}"`);
                const query = `[out:json][timeout:15];way["highway"]["name"~"${k1}",i](-29.30,-59.85,-28.95,-59.45)->.a;way["highway"]["name"~"${k2}",i](-29.30,-59.85,-28.95,-59.45)->.b;node(w.a)(w.b);out 1;`;
                const res = await fetch(
                  "https://overpass-api.de/api/interpreter",
                  {
                    method: "POST",
                    body: `data=${encodeURIComponent(query)}`,
                    headers: {
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                  },
                );
                const data = await res.json();
                return data.elements?.length > 0
                  ? { lat: data.elements[0].lat, lng: data.elements[0].lon }
                  : null;
              };
              let found = null;
              if (isIntersection) {
                found = await findIntersection(parts[0], parts[1]);
                if (!found) found = await doGeocode(parts[0]);
              } else {
                found = await doGeocode(direccion);
                if (!found) found = await doGeocode(parts[0]);
              }
              if (found) {
                reportLat = found.lat;
                reportLng = found.lng;
              }
            } catch {}
          }

          const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const now = new Date();
          const result = await db.query(
            `INSERT INTO "Report" (id, lat, lng, category, description, barrio, direccion, photo, photos, "isUrgent", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [
              id,
              reportLat,
              reportLng,
              categoria,
              descripcion,
              barrio,
              direccion,
              null,
              [],
              false,
              now,
              now,
            ],
          );
          const newReport = result.rows[0];
          try {
            const subscriptions = await db.query(
              'SELECT endpoint, p256dh, auth FROM "PushSubscription"',
            );
            for (const sub of subscriptions.rows) {
              await webPush
                .sendNotification(
                  {
                    endpoint: sub.endpoint,
                    keys: { p256dh: sub.p256dh, auth: sub.auth },
                  },
                  JSON.stringify({
                    title: `Reporte por voz: ${categoria}`,
                    body: descripcion,
                    url: "/",
                  }),
                )
                .catch(() => {});
            }
          } catch {}
          return new Response(
            JSON.stringify({ report: newReport, extracted }),
            {
              status: 201,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        } else {
          // Fallback JSON
          const body = await req.json();
          transcript = body.transcript;
          lat = body.lat;
          lng = body.lng;
        }

        if (!transcript || !lat || !lng) {
          return new Response(
            JSON.stringify({ error: "Faltan campos requeridos" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Fallback path (JSON): usar Groq NLP
        const CATEGORIAS = [
          "basura",
          "alumbrado",
          "baches",
          "pastizales",
          "robo",
          "personas_sospechosas",
          "fugas_agua",
          "drenaje",
          "banquetas",
          "semaforos",
          "limpieza",
          "graffiti",
          "escombros",
          "arboles",
          "vandalismo",
          "vehiculos_abandonados",
          "iluminacion",
          "animales_callejeros",
          "plagas",
          "senalizacion",
          "estacionamiento",
          "transporte",
        ];
        const prompt = `Extraé los campos del siguiente mensaje de voz en Reconquista, Santa Fe, Argentina y devolvé ÚNICAMENTE un JSON. Campos: categoria (una de: ${CATEGORIAS.join(",")}), descripcion, barrio (o "Sin especificar"), direccion (calle+número o intersección), enviar_servicios (true/false). Mensaje: "${transcript.replace(/"/g, "'")}"`;
        const groqRes = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              model: "llama-3.1-8b-instant",
              messages: [{ role: "user", content: prompt }],
              temperature: 0.1,
              max_tokens: 200,
            }),
          },
        );
        if (!groqRes.ok) {
          return new Response(
            JSON.stringify({ error: "Error al procesar el mensaje de voz" }),
            {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const groqData = await groqRes.json();
        let extracted: any;
        try {
          const raw = groqData.choices[0].message.content.trim();
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found");
          extracted = JSON.parse(jsonMatch[0]);
        } catch {
          return new Response(
            JSON.stringify({
              error: "No se pudo interpretar el mensaje. Intentá de nuevo.",
              transcript,
            }),
            {
              status: 422,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Validar categoría
        const categoria = CATEGORIAS.includes(extracted.categoria)
          ? extracted.categoria
          : "basura";
        const descripcion = (extracted.descripcion || transcript).slice(0, 500);
        const barrio = extracted.barrio || "Sin especificar";
        const direccion = extracted.direccion || "Sin especificar";

        // Geocodificar la dirección extraída para ubicar el pin correctamente
        let reportLat = lat;
        let reportLng = lng;
        if (direccion !== "Sin especificar") {
          try {
            const sepRegex = /\s+(?:y|e|-|\/|esq\.?|esquina|entre|casi)\s+/i;
            const parts = direccion
              .split(sepRegex)
              .map((s: string) => s.trim())
              .filter(Boolean);
            const isIntersection = parts.length >= 2;

            // Normalizar nombre de calle para búsqueda (quitar tildes, lowercase parcial)
            const normalize = (s: string) =>
              s
                .replace(/[áàä]/gi, "a")
                .replace(/[éèë]/gi, "e")
                .replace(/[íìï]/gi, "i")
                .replace(/[óòö]/gi, "o")
                .replace(/[úùü]/gi, "u");

            // Overpass API: busca el nodo exacto donde dos calles se cruzan (bbox de Reconquista)
            const findIntersection = async (
              street1: string,
              street2: string,
            ) => {
              const query = `[out:json][timeout:15];
way["highway"]["name"~"${normalize(street1)}",i](-29.30,-59.85,-28.95,-59.45)->.a;
way["highway"]["name"~"${normalize(street2)}",i](-29.30,-59.85,-28.95,-59.45)->.b;
node(w.a)(w.b);
out 1;`;
              const res = await fetch(
                "https://overpass-api.de/api/interpreter",
                {
                  method: "POST",
                  body: `data=${encodeURIComponent(query)}`,
                  headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                },
              );
              const data = await res.json();
              if (data.elements?.length > 0) {
                return { lat: data.elements[0].lat, lng: data.elements[0].lon };
              }
              return null;
            };

            // Nominatim para calle + número
            const geocodeAddress = async (q: string) => {
              const bbox = "-59.85,-29.30,-59.45,-28.95";
              const encoded = encodeURIComponent(
                `${q}, Reconquista, Santa Fe, Argentina`,
              );
              const res = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=ar&viewbox=${bbox}&bounded=1`,
                { headers: { "User-Agent": "warning-app/1.0" } },
              );
              const data = await res.json();
              return data.length > 0
                ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
                : null;
            };

            let found = null;

            if (isIntersection) {
              // 1. Overpass: intersección exacta
              found = await findIntersection(parts[0], parts[1]);
              // 2. Fallback Nominatim con solo la primera calle
              if (!found) {
                found = await geocodeAddress(parts[0]);
              }
            } else {
              // Calle + número: Nominatim
              found = await geocodeAddress(direccion);
              if (!found) found = await geocodeAddress(parts[0]);
            }

            if (found) {
              reportLat = found.lat;
              reportLng = found.lng;
            }
          } catch {
            // Si falla el geocoding, usamos las coords del usuario
          }
        }

        // Crear el reporte directamente
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();

        const result = await db.query(
          `INSERT INTO "Report" (id, lat, lng, category, description, barrio, direccion, photo, photos, "isUrgent", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            id,
            reportLat,
            reportLng,
            categoria,
            descripcion,
            barrio,
            direccion,
            null,
            [],
            false,
            now,
            now,
          ],
        );

        const newReport = result.rows[0];

        // Notificaciones push
        try {
          const subscriptions = await db.query(
            'SELECT endpoint, p256dh, auth FROM "PushSubscription"',
          );
          for (const sub of subscriptions.rows) {
            await webPush
              .sendNotification(
                {
                  endpoint: sub.endpoint,
                  keys: { p256dh: sub.p256dh, auth: sub.auth },
                },
                JSON.stringify({
                  title: `Reporte por voz: ${categoria}`,
                  body: descripcion,
                  url: "/",
                }),
                PUSH_OPTIONS,
              )
              .catch(() => {});
          }
        } catch {}

        return new Response(JSON.stringify({ report: newReport, extracted }), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── FIN VOZ ──────────────────────────────────────────────────────────

      // ─── SUPERMARKETS & OFERTAS ───────────────────────────────────────────

      // GET /api/supermarkets - Lista todos los supermercados
      if (path === "/api/supermarkets" && method === "GET") {
        const result = await db.query(`
          SELECT s.*, COUNT(o.id)::int AS "offerCount"
          FROM "Supermarket" s
          LEFT JOIN "Offer" o ON o."supermarketId" = s.id
            AND (o."validUntil" IS NULL OR o."validUntil" >= CURRENT_DATE)
          GROUP BY s.id
          ORDER BY s.name
        `);
        return new Response(JSON.stringify(result.rows), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/supermarkets - Crear supermercado
      if (path === "/api/supermarkets" && method === "POST") {
        const body = await req.json();
        const { name, address, lat, lng, logo } = body;

        if (!name) {
          return new Response(
            JSON.stringify({ error: "El campo name es requerido" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const result = await db.query(
          `INSERT INTO "Supermarket" (id, name, address, lat, lng, logo)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [id, name, address || "", lat ?? -29.15, lng ?? -59.65, logo || null],
        );

        return new Response(JSON.stringify(result.rows[0]), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/supermarkets/:id/offers - Ofertas vigentes de un supermercado
      if (
        path.match(/^\/api\/supermarkets\/[^/]+\/offers$/) &&
        method === "GET"
      ) {
        const supermarketId = path.split("/")[3];
        const result = await db.query(
          `SELECT * FROM "Offer"
           WHERE "supermarketId" = $1 AND ("validUntil" IS NULL OR "validUntil" >= CURRENT_DATE)
           ORDER BY "createdAt" DESC`,
          [supermarketId],
        );
        return new Response(JSON.stringify(result.rows), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/offers - Crear oferta
      if (path === "/api/offers" && method === "POST") {
        const contentType = req.headers.get("content-type") || "";
        let supermarketId: string;
        let description: string;
        let price: string | null;
        let validUntil: string | null;
        let photoPath: string | null = null;

        if (contentType.includes("multipart/form-data")) {
          const formData = await req.formData();
          supermarketId = formData.get("supermarketId") as string;
          description = formData.get("description") as string;
          price = (formData.get("price") as string) || null;
          validUntil = (formData.get("validUntil") as string) || null;

          const photoFile = formData.get("photo") as File | null;
          if (photoFile && photoFile.size > 0) {
            const ext = photoFile.name.split(".").pop() || "jpg";
            const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${ext}`;
            const filePath = join(uploadsDir, filename);
            await Bun.write(filePath, photoFile);
            photoPath = `/uploads/${filename}`;
          }
        } else {
          const body = await req.json();
          supermarketId = body.supermarketId;
          description = body.description;
          price = body.price || null;
          validUntil = body.validUntil || null;
        }

        if (!supermarketId || !description) {
          return new Response(
            JSON.stringify({
              error: "supermarketId y description son requeridos",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const result = await db.query(
          `INSERT INTO "Offer" (id, "supermarketId", description, price, photo, "validUntil")
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            id,
            supermarketId,
            description,
            price,
            photoPath,
            validUntil || null,
          ],
        );

        return new Response(JSON.stringify(result.rows[0]), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/offers/:id - Actualizar oferta
      if (path.match(/^\/api\/offers\/[^/]+$/) && method === "PUT") {
        const id = path.split("/")[3];
        const contentType = req.headers.get("content-type") || "";
        let description: string,
          price: string | null,
          validUntil: string | null,
          photoPath: string | null | undefined;

        if (contentType.includes("multipart/form-data")) {
          const formData = await req.formData();
          description = formData.get("description") as string;
          price = (formData.get("price") as string) || null;
          validUntil = (formData.get("validUntil") as string) || null;
          const photoFile = formData.get("photo") as File | null;
          if (photoFile && photoFile.size > 0) {
            const uploadsDir = process.env.UPLOADS_DIR || "./uploads";
            const ext = photoFile.name.split(".").pop() || "jpg";
            const filename = `offer_${crypto.randomUUID()}.${ext}`;
            await Bun.write(
              `${uploadsDir}/${filename}`,
              await photoFile.arrayBuffer(),
            );
            photoPath = `/uploads/${filename}`;
          } else {
            photoPath = undefined; // no cambiar
          }
        } else {
          const body = await req.json();
          description = body.description;
          price = body.price || null;
          validUntil = body.validUntil || null;
          photoPath = undefined;
        }

        const updates: string[] = [];
        const values: (string | null)[] = [];
        let i = 1;
        if (description) {
          updates.push(`description = $${i++}`);
          values.push(description);
        }
        if (price !== undefined) {
          updates.push(`price = $${i++}`);
          values.push(price);
        }
        if (validUntil !== undefined) {
          updates.push(`"validUntil" = $${i++}`);
          values.push(validUntil);
        }
        if (photoPath !== undefined) {
          updates.push(`photo = $${i++}`);
          values.push(photoPath);
        }

        if (updates.length === 0) {
          return new Response(
            JSON.stringify({ error: "Nada que actualizar" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        values.push(id);
        const result = await db.query(
          `UPDATE "Offer" SET ${updates.join(", ")} WHERE id = $${i} RETURNING *`,
          values,
        );
        return new Response(JSON.stringify(result.rows[0]), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/offers/:id - Eliminar oferta
      if (path.match(/^\/api\/offers\/[^/]+$/) && method === "DELETE") {
        const id = path.split("/")[3];
        await db.query('DELETE FROM "Offer" WHERE id = $1', [id]);
        return new Response(JSON.stringify({ message: "Oferta eliminada" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/track - Registrar visita de sección
      if (path === "/api/track" && method === "POST") {
        const body = await req.json();
        const { sessionId, section } = body;
        if (!sessionId || !section) {
          return new Response(
            JSON.stringify({ error: "sessionId y section requeridos" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO "PageView" (id, "sessionId", section) VALUES ($1, $2, $3)`,
          [id, sessionId, section],
        );
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/analytics - Dashboard de estadísticas
      if (path === "/api/analytics" && method === "GET") {
        const [
          uniqueToday,
          uniqueWeek,
          uniqueMonth,
          uniqueTotal,
          topSections,
          dailyVisits,
          totalReports,
          reportsByCategory,
          topBarrios,
          professionalsTotal,
          professionalsActive,
          usersTotal,
          conversationsTotal,
          conversationsActive,
          reviewsTotal,
        ] = await Promise.all([
          db.query(
            `SELECT COUNT(DISTINCT "sessionId") AS count FROM "PageView" WHERE "createdAt" >= CURRENT_DATE`,
          ),
          db.query(
            `SELECT COUNT(DISTINCT "sessionId") AS count FROM "PageView" WHERE "createdAt" >= NOW() - INTERVAL '7 days'`,
          ),
          db.query(
            `SELECT COUNT(DISTINCT "sessionId") AS count FROM "PageView" WHERE "createdAt" >= NOW() - INTERVAL '30 days'`,
          ),
          db.query(
            `SELECT COUNT(DISTINCT "sessionId") AS count FROM "PageView"`,
          ),
          db.query(`
            SELECT section,
              COUNT(*) AS visits,
              COUNT(DISTINCT "sessionId") AS "uniqueVisitors"
            FROM "PageView"
            GROUP BY section
            ORDER BY visits DESC
          `),
          db.query(`
            SELECT DATE("createdAt") AS date,
              COUNT(*) AS visits,
              COUNT(DISTINCT "sessionId") AS "uniqueVisitors"
            FROM "PageView"
            WHERE "createdAt" >= NOW() - INTERVAL '30 days'
            GROUP BY DATE("createdAt")
            ORDER BY date ASC
          `),
          db.query(`SELECT COUNT(*) AS count FROM "Report"`),
          db.query(`
            SELECT category, COUNT(*) AS count
            FROM "Report"
            GROUP BY category
            ORDER BY count DESC
            LIMIT 8
          `),
          db.query(`
            SELECT barrio, COUNT(*) AS count
            FROM "Report"
            WHERE barrio != 'Sin especificar' AND barrio != ''
            GROUP BY barrio
            ORDER BY count DESC
            LIMIT 6
          `),
          db.query(`SELECT COUNT(*) AS count FROM "Professional"`),
          db.query(
            `SELECT COUNT(*) AS count FROM "Professional" WHERE activo = true`,
          ),
          db.query(`SELECT COUNT(*) AS count FROM "User"`),
          db.query(`SELECT COUNT(*) AS count FROM "Conversation"`),
          db.query(
            `SELECT COUNT(*) AS count FROM "Conversation" WHERE status != 'completed'`,
          ),
          db.query(`SELECT COUNT(*) AS count FROM "PublicReview"`),
        ]);

        return new Response(
          JSON.stringify({
            uniqueVisitors: {
              today: Number(uniqueToday.rows[0]?.count ?? 0),
              week: Number(uniqueWeek.rows[0]?.count ?? 0),
              month: Number(uniqueMonth.rows[0]?.count ?? 0),
              total: Number(uniqueTotal.rows[0]?.count ?? 0),
            },
            topSections: topSections.rows.map((r) => ({
              section: r.section,
              visits: Number(r.visits),
              uniqueVisitors: Number(r.uniqueVisitors),
            })),
            dailyVisits: dailyVisits.rows.map((r) => ({
              date: r.date,
              visits: Number(r.visits),
              uniqueVisitors: Number(r.uniqueVisitors),
            })),
            totalReports: Number(totalReports.rows[0]?.count ?? 0),
            reportsByCategory: reportsByCategory.rows.map((r) => ({
              category: r.category,
              count: Number(r.count),
            })),
            topBarrios: topBarrios.rows.map((r) => ({
              barrio: r.barrio,
              count: Number(r.count),
            })),
            professionals: {
              total: Number(professionalsTotal.rows[0]?.count ?? 0),
              active: Number(professionalsActive.rows[0]?.count ?? 0),
            },
            users: Number(usersTotal.rows[0]?.count ?? 0),
            conversations: {
              total: Number(conversationsTotal.rows[0]?.count ?? 0),
              active: Number(conversationsActive.rows[0]?.count ?? 0),
            },
            reviews: Number(reviewsTotal.rows[0]?.count ?? 0),
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // POST /api/ai/generate-description — genera descripcion de perfil con IA
      if (path === "/api/ai/generate-description" && method === "POST") {
        // Opcional: verificar token si está disponible, pero permitir sin autenticación
        const clerkUserId = await verifyClerkToken(req).catch(() => null);

        const { oficios, rubro, nombre, barrio, anios, zona } =
          (await req.json()) as {
            oficios?: string[];
            rubro?: string;
            nombre: string;
            barrio?: string;
            anios?: string;
            zona?: string;
          };

        const esProfesional = oficios?.length;
        const esComercio = !!rubro;

        if ((!esProfesional && !esComercio) || !nombre) {
          return new Response(JSON.stringify({ error: "Faltan datos" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const prompt = esProfesional
          ? `Escribi una descripción profesional en primera persona para ${nombre}, un trabajador de oficio en Reconquista, Santa Fe.

Datos:
- Oficios: ${oficios!.join(", ")}
${barrio ? `- Barrio: ${barrio}` : ""}
${anios ? `- Años de experiencia: ${anios}` : ""}
${zona ? `- Zonas donde trabaja: ${zona}` : ""}

La descripción debe:
- Estar en primera persona ("Soy...", "Me dedico a...")
- Tener entre 60 y 150 palabras
- Sonar natural y humana, no corporativa
- Mencionar los oficios y la zona de trabajo
- Transmitir confianza y profesionalismo
- Devolvé SOLO la descripción, sin título, sin comillas, sin aclaraciones`
          : `Escribi una descripción atractiva para el comercio "${nombre}" en Reconquista, Santa Fe.

Datos:
- Rubro: ${rubro}
${barrio ? `- Barrio: ${barrio}` : ""}
${zona ? `- Zona de entrega o atención: ${zona}` : ""}

La descripción debe:
- Estar en primera persona ("Somos...", "Ofrecemos...", "Nos dedicamos a...")
- Tener entre 60 y 150 palabras
- Sonar cálida y cercana, orientada al cliente local
- Mencionar el rubro y el barrio/zona
- Invitar a los clientes a contactarse
- Devolvé SOLO la descripción, sin título, sin comillas, sin aclaraciones`;

        const groqRes = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              model: "llama-3.1-8b-instant",
              max_tokens: 400,
              messages: [{ role: "user", content: prompt }],
            }),
          },
        );

        const groqData = (await groqRes.json()) as {
          choices: { message: { content: string } }[];
        };
        const text = groqData.choices?.[0]?.message?.content?.trim() ?? "";
        return new Response(JSON.stringify({ descripcion: text }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/ai/generate-outreach — genera mensaje de WhatsApp para captar comercios (admin only)
      if (path === "/api/ai/generate-outreach" && method === "POST") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });

        const { nombre, rubro, contacto } = (await req.json()) as {
          nombre: string;
          rubro?: string;
          contacto?: string;
        };
        if (!nombre?.trim())
          return new Response(
            JSON.stringify({ error: "Falta el nombre del comercio" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );

        // La IA solo genera la línea personalizada del rubro (1 oración).
        // El resto del mensaje es un template fijo para garantizar calidad y consistencia.
        let lineaPersonalizada = "";
        if (rubro) {
          const promptRubro = `En una sola oración corta y casual (español rioplatense), explicá cómo el rubro "${rubro}" puede beneficiarse de tener un perfil digital gratuito con catálogo, fotos y botón de WhatsApp en una app local. Empezá con "Es una herramienta para que puedan". Devolvé SOLO esa oración, sin comillas.`;
          const groqRes = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
              },
              body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                max_tokens: 80,
                temperature: 0.7,
                messages: [{ role: "user", content: promptRubro }],
              }),
            },
          );
          const groqData = (await groqRes.json()) as {
            choices: { message: { content: string } }[];
          };
          lineaPersonalizada =
            groqData.choices?.[0]?.message?.content?.trim() ?? "";
        }

        const saludo = contacto ? `Hola ${contacto}!` : "Hola!";
        const lineaRubro =
          lineaPersonalizada ||
          `Es una herramienta para que los vecinos de Reconquista que buscan ${rubro ? `un ${rubro.toLowerCase()}` : "un comercio local"} te encuentren a vos: perfil con fotos, catálogo y WhatsApp directo.`;

        const mensaje = `${saludo} Soy el creador de reportesreconquista.com, la app gratuita de Reconquista.

${lineaRubro} 100% gratis.

En las próximas semanas vamos a tener el apoyo de empresas como Elías Yapur y otras para darle visibilidad a la plataforma. Los comercios que se registren ahora van a quedar como Comercios Fundadores, con un emblema especial y posicionados primeros en el listado, antes de que eso pase.

¿Te viene bien que esta semana pase por el local a mostrártela en persona?

https://reportesreconquista.com`;

        return new Response(JSON.stringify({ mensaje }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ═══════════════════════════════════════════════════════════════════
      // COMERCIOS
      // ═══════════════════════════════════════════════════════════════════

      // POST /api/comercios — crear perfil de comercio (requiere auth)
      if (path === "/api/comercios" && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(
            JSON.stringify({
              error: "Demasiadas solicitudes. Intentá en un momento.",
            }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          );
        }
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const existing = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (existing)
          return new Response(
            JSON.stringify({ error: "Ya tenés un perfil de comercio creado" }),
            {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const formData = await req.formData();
        const nombre = sanitizeText(formData.get("nombre") as string, 100);
        const rubro = sanitizeText(formData.get("rubro") as string, 100);
        const barrio = sanitizeText(formData.get("barrio") as string, 100);
        const whatsapp = sanitizeText(formData.get("whatsapp") as string, 30);
        const telefono =
          sanitizeText(formData.get("telefono") as string, 30) || undefined;
        const direccion =
          sanitizeText(formData.get("direccion") as string, 200) || undefined;
        const horario =
          sanitizeText(formData.get("horario") as string, 200) || undefined;
        const descripcion =
          sanitizeText(formData.get("descripcion") as string, 500) || undefined;
        if (!nombre || !rubro || !barrio || !whatsapp) {
          return new Response(
            JSON.stringify({
              error:
                "Faltan campos obligatorios: nombre, rubro, barrio, whatsapp",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const slugBase =
          `${nombre}-${rubro}-${Math.random().toString(36).slice(2, 7)}`
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        // foto principal
        let fotoUrl: string | undefined;
        const mainPhoto = formData.get("photo") as File | null;
        if (mainPhoto && mainPhoto.size > 0) {
          const ext = mainPhoto.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `comercio_${crypto.randomUUID()}.${ext}`;
          await Bun.write(
            join(uploadsDir, filename),
            await mainPhoto.arrayBuffer(),
          );
          fotoUrl = "/uploads/" + filename;
        }
        // galería
        const fotos: string[] = [];
        for (let i = 0; i < 10; i++) {
          const f = formData.get(`photo${i}`) as File | null;
          if (!f || f.size === 0) break;
          const ext = f.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `comercio_${crypto.randomUUID()}.${ext}`;
          await Bun.write(join(uploadsDir, filename), await f.arrayBuffer());
          fotos.push("/uploads/" + filename);
        }
        const totalComercies = await prisma.comercio.count();
        const isFounder = totalComercies < 20;
        const comercio = await prisma.comercio.create({
          data: {
            clerkUserId,
            nombre,
            rubro,
            slug: slugBase,
            descripcion,
            direccion,
            barrio,
            whatsapp,
            telefono,
            horario,
            foto: fotoUrl,
            fotos,
            isFounder,
          },
        });
        return new Response(JSON.stringify(comercio), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/comercios — listar comercios activos (público)
      if (path === "/api/comercios" && method === "GET") {
        const barrio = url.searchParams.get("barrio") ?? undefined;
        const rubro = url.searchParams.get("rubro") ?? undefined;
        const comercios = await prisma.comercio.findMany({
          where: {
            activo: true,
            ...(barrio
              ? { barrio: { contains: barrio, mode: "insensitive" } }
              : {}),
            ...(rubro
              ? { rubro: { contains: rubro, mode: "insensitive" } }
              : {}),
          },
          select: {
            id: true,
            nombre: true,
            rubro: true,
            slug: true,
            barrio: true,
            foto: true,
            logo: true,
            descripcion: true,
            activo: true,
            isPremium: true,
            isFounder: true,
            createdAt: true,
            recommendations: true,
          },
        });
        comercios.sort((a: any, b: any) => {
          const score = (c: any) => {
            const founderBonus = c.isFounder ? 1.0 : c.isPremium ? 0.6 : 0;
            const hasMedia = (c.logo || c.foto) ? 1 : 0;
            return Math.min((c.recommendations || 0) / 20, 1) * 60 + founderBonus * 30 + hasMedia * 10;
          };
          return score(b) - score(a);
        });
        return new Response(JSON.stringify(comercios), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/comercios/me — obtener mi comercio (requiere auth)
      if (path === "/api/comercios/me" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
          select: {
            id: true,
            nombre: true,
            rubro: true,
            slug: true,
            descripcion: true,
            direccion: true,
            barrio: true,
            whatsapp: true,
            telefono: true,
            horario: true,
            foto: true,
            fotos: true,
            logo: true,
            activo: true,
            isPremium: true,
            isFounder: true,
            createdAt: true,
            updatedAt: true,
            offers: { orderBy: { createdAt: "desc" } },
            productos: { orderBy: { createdAt: "desc" } },
          },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        return new Response(JSON.stringify(comercio), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/comercios/me — actualizar mi comercio (requiere auth)
      if (path === "/api/comercios/me" && method === "PUT") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercioExistente = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercioExistente)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const formData = await req.formData();
        const updateData: Record<string, unknown> = {};
        const nombre = formData.get("nombre") as string | null;
        const rubro = formData.get("rubro") as string | null;
        const barrio = formData.get("barrio") as string | null;
        const whatsapp = formData.get("whatsapp") as string | null;
        const telefono = formData.get("telefono") as string | null;
        const direccion = formData.get("direccion") as string | null;
        const horario = formData.get("horario") as string | null;
        const descripcion = formData.get("descripcion") as string | null;
        if (nombre) updateData.nombre = sanitizeText(nombre, 100);
        if (rubro) updateData.rubro = sanitizeText(rubro, 100);
        if (barrio) updateData.barrio = sanitizeText(barrio, 100);
        if (whatsapp) updateData.whatsapp = sanitizeText(whatsapp, 30);
        if (telefono !== null)
          updateData.telefono = sanitizeText(telefono, 30) || null;
        if (direccion !== null)
          updateData.direccion = sanitizeText(direccion, 200) || null;
        if (horario !== null)
          updateData.horario = sanitizeText(horario, 200) || null;
        if (descripcion !== null)
          updateData.descripcion = sanitizeText(descripcion, 500) || null;
        // foto principal
        const mainPhoto = formData.get("photo") as File | null;
        if (mainPhoto && mainPhoto.size > 0) {
          const ext = mainPhoto.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `comercio_${crypto.randomUUID()}.${ext}`;
          await Bun.write(
            join(uploadsDir, filename),
            await mainPhoto.arrayBuffer(),
          );
          updateData.foto = "/uploads/" + filename;
        }
        // galería — agrega a las existentes
        const nuevasFotos: string[] = [];
        for (let i = 0; i < 10; i++) {
          const f = formData.get(`photo${i}`) as File | null;
          if (!f || f.size === 0) break;
          const ext = f.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `comercio_${crypto.randomUUID()}.${ext}`;
          await Bun.write(join(uploadsDir, filename), await f.arrayBuffer());
          nuevasFotos.push("/uploads/" + filename);
        }
        if (nuevasFotos.length > 0) {
          updateData.fotos = [...comercioExistente.fotos, ...nuevasFotos];
        }
        const comercio = await prisma.comercio.update({
          where: { clerkUserId },
          data: updateData,
        });
        return new Response(JSON.stringify(comercio), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/comercios/me/offers — crear oferta (requiere auth)
      if (path === "/api/comercios/me/offers" && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(
            JSON.stringify({
              error: "Demasiadas solicitudes. Intentá en un momento.",
            }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          );
        }
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const formData = await req.formData();
        const titulo = sanitizeText(formData.get("titulo") as string, 150);
        if (!titulo)
          return new Response(
            JSON.stringify({ error: "El título es obligatorio" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const descripcion =
          sanitizeText(formData.get("descripcion") as string, 500) || undefined;
        const terminos =
          sanitizeText(formData.get("terminos") as string, 1000) || undefined;
        const precio =
          sanitizeText(formData.get("precio") as string, 50) || undefined;
        const validaHastaRaw = formData.get("validaHasta") as string | null;
        const validaHasta = validaHastaRaw
          ? new Date(validaHastaRaw)
          : undefined;
        let fotoUrl: string | undefined;
        const photoFile = formData.get("photo") as File | null;
        if (photoFile && photoFile.size > 0) {
          const ext = photoFile.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `comercio_${crypto.randomUUID()}.${ext}`;
          await Bun.write(
            join(uploadsDir, filename),
            await photoFile.arrayBuffer(),
          );
          fotoUrl = "/uploads/" + filename;
        }
        const offer = await prisma.comercioOffer.create({
          data: {
            comercioId: comercio.id,
            titulo,
            descripcion,
            terminos,
            precio,
            foto: fotoUrl,
            validaHasta,
          },
        });
        return new Response(JSON.stringify(offer), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/comercios/me/offers/:offerId — eliminar oferta (requiere auth)
      if (
        path.match(/^\/api\/comercios\/me\/offers\/[^/]+$/) &&
        method === "DELETE"
      ) {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const offerId = path.split("/api/comercios/me/offers/")[1];
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const offer = await prisma.comercioOffer.findUnique({
          where: { id: offerId },
        });
        if (!offer || offer.comercioId !== comercio.id)
          return new Response(
            JSON.stringify({ error: "Oferta no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        await prisma.comercioOffer.delete({ where: { id: offerId } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PATCH /api/comercios/me/offers/:offerId — editar o toggle oferta (requiere auth)
      if (
        path.match(/^\/api\/comercios\/me\/offers\/[^/]+$/) &&
        method === "PATCH"
      ) {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const offerId = path.split("/api/comercios/me/offers/")[1];
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const offer = await prisma.comercioOffer.findUnique({
          where: { id: offerId },
        });
        if (!offer || offer.comercioId !== comercio.id)
          return new Response(
            JSON.stringify({ error: "Oferta no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const body = await req.json();
          const updated = await prisma.comercioOffer.update({
            where: { id: offerId },
            data: {
              activa:
                typeof body.activa === "boolean" ? body.activa : undefined,
            },
          });
          return new Response(JSON.stringify(updated), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const formData = await req.formData();
        const titulo = sanitizeText(formData.get("titulo") as string, 150);
        if (!titulo)
          return new Response(
            JSON.stringify({ error: "El título es obligatorio" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const descripcion =
          sanitizeText(formData.get("descripcion") as string, 500) || null;
        const terminos =
          sanitizeText(formData.get("terminos") as string, 1000) || null;
        const precio =
          sanitizeText(formData.get("precio") as string, 50) || null;
        const validaHastaRaw = formData.get("validaHasta") as string | null;
        const validaHasta = validaHastaRaw ? new Date(validaHastaRaw) : null;
        let fotoUrl: string | null | undefined;
        const photoFile = formData.get("photo") as File | null;
        const clearPhoto = formData.get("clearPhoto") as string | null;
        if (photoFile && photoFile.size > 0) {
          const ext = photoFile.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `comercio_${crypto.randomUUID()}.${ext}`;
          await Bun.write(
            join(uploadsDir, filename),
            await photoFile.arrayBuffer(),
          );
          fotoUrl = "/uploads/" + filename;
        } else if (clearPhoto === "1") {
          fotoUrl = null;
        }
        const updated = await prisma.comercioOffer.update({
          where: { id: offerId },
          data: {
            titulo,
            descripcion,
            terminos,
            precio,
            validaHasta,
            ...(fotoUrl !== undefined ? { foto: fotoUrl } : {}),
          },
        });
        return new Response(JSON.stringify(updated), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/comercios/me/productos — crear producto (requiere auth)
      if (path === "/api/comercios/me/productos" && method === "POST") {
        if (!checkStrictRateLimit(req))
          return new Response(
            JSON.stringify({ error: "Demasiadas solicitudes." }),
            {
              status: 429,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const formData = await req.formData();
        const nombre = sanitizeText(formData.get("nombre") as string, 150);
        if (!nombre)
          return new Response(
            JSON.stringify({ error: "El nombre es obligatorio" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const descripcion =
          sanitizeText(formData.get("descripcion") as string, 500) || null;
        const precio =
          sanitizeText(formData.get("precio") as string, 50) || null;
        const tipoRaw = formData.get("tipo") as string | null;
        const tipo = tipoRaw === "servicio" ? "servicio" : "producto";
        let foto: string | null = null;
        const photoFile = formData.get("photo") as File | null;
        if (photoFile && photoFile.size > 0) {
          const ext = photoFile.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `producto_${crypto.randomUUID()}.${ext}`;
          await Bun.write(
            join(uploadsDir, filename),
            await photoFile.arrayBuffer(),
          );
          foto = "/uploads/" + filename;
        }
        if (!comercio.isPremium) {
          const count = await prisma.producto.count({
            where: { comercioId: comercio.id },
          });
          if (count >= 10)
            return new Response(
              JSON.stringify({
                error: "LIMIT_REACHED",
                message:
                  "Alcanzaste el límite de 10 items en el plan gratuito.",
              }),
              {
                status: 403,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
        }
        const producto = await prisma.producto.create({
          data: {
            comercioId: comercio.id,
            nombre,
            tipo,
            descripcion,
            precio,
            foto,
          },
        });
        return new Response(JSON.stringify(producto), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PATCH /api/comercios/me/productos/:id — editar o toggle producto (requiere auth)
      if (
        path.match(/^\/api\/comercios\/me\/productos\/[^/]+$/) &&
        method === "PATCH"
      ) {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const productoId = path.split("/api/comercios/me/productos/")[1];
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const producto = await prisma.producto.findUnique({
          where: { id: productoId },
        });
        if (!producto || producto.comercioId !== comercio.id)
          return new Response(
            JSON.stringify({ error: "Producto no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const body = await req.json();
          const updated = await prisma.producto.update({
            where: { id: productoId },
            data: {
              activo:
                typeof body.activo === "boolean" ? body.activo : undefined,
            },
          });
          return new Response(JSON.stringify(updated), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const formData = await req.formData();
        const nombre = sanitizeText(formData.get("nombre") as string, 150);
        if (!nombre)
          return new Response(
            JSON.stringify({ error: "El nombre es obligatorio" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const descripcion =
          sanitizeText(formData.get("descripcion") as string, 500) || null;
        const precio =
          sanitizeText(formData.get("precio") as string, 50) || null;
        const tipoRaw = formData.get("tipo") as string | null;
        const tipo = tipoRaw === "servicio" ? "servicio" : "producto";
        let fotoUrl: string | null | undefined;
        const photoFile = formData.get("photo") as File | null;
        const clearPhoto = formData.get("clearPhoto") as string | null;
        if (photoFile && photoFile.size > 0) {
          const ext = photoFile.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `producto_${crypto.randomUUID()}.${ext}`;
          await Bun.write(
            join(uploadsDir, filename),
            await photoFile.arrayBuffer(),
          );
          fotoUrl = "/uploads/" + filename;
        } else if (clearPhoto === "1") {
          fotoUrl = null;
        }
        const updated = await prisma.producto.update({
          where: { id: productoId },
          data: {
            nombre,
            tipo,
            descripcion,
            precio,
            ...(fotoUrl !== undefined ? { foto: fotoUrl } : {}),
          },
        });
        return new Response(JSON.stringify(updated), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/comercios/me/productos/:id — eliminar producto (requiere auth)
      if (
        path.match(/^\/api\/comercios\/me\/productos\/[^/]+$/) &&
        method === "DELETE"
      ) {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const productoId = path.split("/api/comercios/me/productos/")[1];
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const producto = await prisma.producto.findUnique({
          where: { id: productoId },
        });
        if (!producto || producto.comercioId !== comercio.id)
          return new Response(
            JSON.stringify({ error: "Producto no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        await prisma.producto.delete({ where: { id: productoId } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/comercios/me/fotos — eliminar foto de galería (requiere auth)
      if (path === "/api/comercios/me/fotos" && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const body = await req.json();
        const { url: fotoUrl } = body;
        if (!fotoUrl)
          return new Response(JSON.stringify({ error: "Falta el campo url" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const fotosActualizadas = comercio.fotos.filter((f) => f !== fotoUrl);
        await prisma.comercio.update({
          where: { clerkUserId },
          data: { fotos: fotosActualizadas },
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/comercios/:slug/offers/:offerId — detalle de oferta (público)
      if (
        path.match(/^\/api\/comercios\/[^/]+\/offers\/[^/]+$/) &&
        method === "GET"
      ) {
        const parts = path.split("/");
        const slug = parts[3];
        const offerId = parts[5];
        const comercio = await prisma.comercio.findUnique({
          where: { slug },
          select: {
            id: true,
            nombre: true,
            slug: true,
            logo: true,
            whatsapp: true,
            rubro: true,
          },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "Comercio no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const offer = await prisma.comercioOffer.findUnique({
          where: { id: offerId },
        });
        if (!offer || offer.comercioId !== comercio.id || !offer.activa)
          return new Response(
            JSON.stringify({ error: "Oferta no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        return new Response(JSON.stringify({ ...offer, comercio }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/comercios/:slug/offers — listar ofertas activas de un comercio (público)
      if (path.match(/^\/api\/comercios\/[^/]+\/offers$/) && method === "GET") {
        const slug = path.split("/api/comercios/")[1].replace("/offers", "");
        const comercio = await prisma.comercio.findUnique({ where: { slug } });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "Comercio no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const offers = await prisma.comercioOffer.findMany({
          where: { comercioId: comercio.id, activa: true },
          select: {
            id: true,
            titulo: true,
            descripcion: true,
            precio: true,
            foto: true,
            validaHasta: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(offers), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }


      // POST /api/comercios/:slug/recommend — recomendar comercio (anónimo)
      if (
        path.match(/^\/api\/comercios\/[^/]+\/recommend$/) &&
        method === POST
      ) {
        const slug = path.split(/api/comercios/)[1].replace(/recommend, );
        const comercio = await prisma.comercio.findUnique({
          where: { slug },
          select: { id: true, recommendations: true },
        });
        if (!comercio)
          return new Response(JSON.stringify({ error: No encontrado }), {
            status: 404, headers: { ...corsHeaders, Content-Type: application/json },
          });
        const ip = req.headers.get(x-forwarded-for)?.split(,)[0]?.trim() || unknown;
        const ipBytes = new TextEncoder().encode(ip + comercio.id);
        const hashBuf = await crypto.subtle.digest(SHA-256, ipBytes);
        const ipHash = Array.from(new Uint8Array(hashBuf)).map((b: number) => b.toString(16).padStart(2, 0)).join();
        try {
          await prisma.recommendation.create({
            data: { targetType: comercio, targetId: comercio.id, ipHash },
          });
          const updated = await prisma.comercio.update({
            where: { id: comercio.id },
            data: { recommendations: { increment: 1 } },
            select: { recommendations: true },
          });
          return new Response(JSON.stringify({ ok: true, count: updated.recommendations }), {
            headers: { ...corsHeaders, Content-Type: application/json },
          });
        } catch (e: any) {
          if (e?.code === P2002)
            return new Response(JSON.stringify({ ok: false, already: true, count: comercio.recommendations }), {
              headers: { ...corsHeaders, Content-Type: application/json },
            });
          throw e;
        }
      }

      // GET /api/comercios/:slug — perfil público de un comercio
      if (path.match(/^\/api\/comercios\/[^/]+$/) && method === "GET") {
        const slug = path.split("/api/comercios/")[1];
        const comercio = await prisma.comercio.findUnique({
          where: { slug },
          select: {
            id: true,
            nombre: true,
            rubro: true,
            slug: true,
            barrio: true,
            descripcion: true,
            direccion: true,
            horario: true,
            whatsapp: true,
            telefono: true,
            foto: true,
            logo: true,
            fotos: true,
            activo: true,
            isPremium: true,
            isFounder: true,
            recommendations: true,
            createdAt: true,
            offers: {
              where: { activa: true },
              select: {
                id: true,
                titulo: true,
                descripcion: true,
                precio: true,
                foto: true,
                validaHasta: true,
                createdAt: true,
              },
              orderBy: { createdAt: "desc" },
            },
            productos: {
              where: { activo: true },
              select: {
                id: true,
                nombre: true,
                tipo: true,
                descripcion: true,
                precio: true,
                foto: true,
                createdAt: true,
              },
              orderBy: { createdAt: "desc" },
            },
          },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "Comercio no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        return new Response(JSON.stringify(comercio), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── EMPLEADOS ────────────────────────────────────────────────────────────

      // POST /api/empleados — crear perfil CV (requiere auth)
      if (path === "/api/empleados" && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(
            JSON.stringify({
              error: "Demasiadas solicitudes. Intentá en un momento.",
            }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          );
        }
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const existing = await prisma.empleado.findUnique({
          where: { clerkUserId },
        });
        if (existing)
          return new Response(
            JSON.stringify({ error: "Ya tenés un perfil de empleado creado" }),
            {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const formData = await req.formData();
        const nombre = sanitizeText(formData.get("nombre") as string, 100);
        const apellido = sanitizeText(formData.get("apellido") as string, 100);
        const descripcion =
          sanitizeText(formData.get("descripcion") as string, 500) || undefined;
        const barrio =
          sanitizeText(formData.get("barrio") as string, 100) || undefined;
        const whatsapp =
          sanitizeText(formData.get("whatsapp") as string, 30) || undefined;
        const habilidadesRaw = formData.get("habilidades") as string | null;
        const habilidades = habilidadesRaw
          ? habilidadesRaw
              .split(",")
              .map((h) => h.trim())
              .filter(Boolean)
          : [];
        if (!nombre || !apellido || habilidades.length === 0) {
          return new Response(
            JSON.stringify({
              error:
                "Faltan campos obligatorios: nombre, apellido, habilidades",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const slugBase =
          `${nombre}-${apellido}-${Math.random().toString(36).slice(2, 7)}`
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        let fotoUrl: string | undefined;
        const photoFile = formData.get("photo") as File | null;
        if (photoFile && photoFile.size > 0) {
          const ext = photoFile.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `empleado_${crypto.randomUUID()}.${ext}`;
          await Bun.write(
            join(uploadsDir, filename),
            await photoFile.arrayBuffer(),
          );
          fotoUrl = "/uploads/" + filename;
        }
        const empleado = await prisma.empleado.create({
          data: {
            clerkUserId,
            nombre,
            apellido,
            slug: slugBase,
            habilidades,
            descripcion,
            barrio,
            whatsapp,
            foto: fotoUrl,
          },
        });
        return new Response(JSON.stringify(empleado), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/empleados — listar empleados activos (público)
      if (path === "/api/empleados" && method === "GET") {
        const barrio = url.searchParams.get("barrio") ?? undefined;
        const habilidad = url.searchParams.get("habilidad") ?? undefined;
        const empleados = await prisma.empleado.findMany({
          where: {
            activo: true,
            ...(barrio
              ? { barrio: { contains: barrio, mode: "insensitive" } }
              : {}),
            ...(habilidad ? { habilidades: { has: habilidad } } : {}),
          },
          select: {
            id: true,
            nombre: true,
            apellido: true,
            slug: true,
            habilidades: true,
            barrio: true,
            foto: true,
            descripcion: true,
            disponible: true,
            activo: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(empleados), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/empleados/me — perfil propio (requiere auth)
      if (path === "/api/empleados/me" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const empleado = await prisma.empleado.findUnique({
          where: { clerkUserId },
          select: {
            id: true,
            nombre: true,
            apellido: true,
            slug: true,
            habilidades: true,
            descripcion: true,
            barrio: true,
            whatsapp: true,
            foto: true,
            disponible: true,
            activo: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        if (!empleado)
          return new Response(
            JSON.stringify({ error: "No tenés un perfil de empleado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        return new Response(JSON.stringify(empleado), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/empleados/me — actualizar perfil propio (requiere auth)
      if (path === "/api/empleados/me" && method === "PUT") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const empleadoExistente = await prisma.empleado.findUnique({
          where: { clerkUserId },
        });
        if (!empleadoExistente)
          return new Response(
            JSON.stringify({ error: "No tenés un perfil de empleado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const formData = await req.formData();
        const updateData: Record<string, unknown> = {};
        const nombre = formData.get("nombre") as string | null;
        const apellido = formData.get("apellido") as string | null;
        const descripcion = formData.get("descripcion") as string | null;
        const barrio = formData.get("barrio") as string | null;
        const whatsapp = formData.get("whatsapp") as string | null;
        const habilidadesRaw = formData.get("habilidades") as string | null;
        const disponibleRaw = formData.get("disponible") as string | null;
        if (nombre) updateData.nombre = sanitizeText(nombre, 100);
        if (apellido) updateData.apellido = sanitizeText(apellido, 100);
        if (descripcion !== null)
          updateData.descripcion = sanitizeText(descripcion, 500) || null;
        if (barrio !== null)
          updateData.barrio = sanitizeText(barrio, 100) || null;
        if (whatsapp !== null)
          updateData.whatsapp = sanitizeText(whatsapp, 30) || null;
        if (habilidadesRaw !== null)
          updateData.habilidades = habilidadesRaw
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean);
        if (disponibleRaw !== null)
          updateData.disponible = disponibleRaw === "true";
        const mainPhoto = formData.get("photo") as File | null;
        if (mainPhoto && mainPhoto.size > 0) {
          const ext = mainPhoto.name.split(".").pop()?.toLowerCase() || "jpg";
          const filename = `empleado_${crypto.randomUUID()}.${ext}`;
          await Bun.write(
            join(uploadsDir, filename),
            await mainPhoto.arrayBuffer(),
          );
          updateData.foto = "/uploads/" + filename;
        }
        const empleado = await prisma.empleado.update({
          where: { clerkUserId },
          data: updateData,
        });
        return new Response(JSON.stringify(empleado), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/empleados/:slug — perfil público de un empleado
      if (path.match(/^\/api\/empleados\/[^/]+$/) && method === "GET") {
        const slug = path.split("/api/empleados/")[1];
        if (slug === "me") {
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const empleado = await prisma.empleado.findUnique({
          where: { slug },
          select: {
            id: true,
            nombre: true,
            apellido: true,
            slug: true,
            habilidades: true,
            descripcion: true,
            barrio: true,
            whatsapp: true,
            foto: true,
            disponible: true,
            activo: true,
            createdAt: true,
          },
        });
        if (!empleado || !empleado.activo)
          return new Response(
            JSON.stringify({ error: "Empleado no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        return new Response(JSON.stringify(empleado), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/empleados/:slug/conversaciones — iniciar chat con empleado
      if (
        path.match(/^\/api\/empleados\/[^/]+\/conversaciones$/) &&
        method === "POST"
      ) {
        const slug = path
          .split("/api/empleados/")[1]
          .replace("/conversaciones", "");
        const empleado = await prisma.empleado.findUnique({ where: { slug } });
        if (!empleado || !empleado.activo)
          return new Response(
            JSON.stringify({ error: "Empleado no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const body = await req.json();
        const clientToken = sanitizeText(body.clientToken as string, 100);
        const clientName =
          sanitizeText(body.clientName as string, 100) || undefined;
        const mensaje = sanitizeText(body.mensaje as string, 1000);
        if (!clientToken || !mensaje)
          return new Response(
            JSON.stringify({ error: "Faltan campos: clientToken, mensaje" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const convo = await prisma.empleadoConversation.create({
          data: {
            empleadoId: empleado.id,
            clientToken,
            clientName,
            updatedAt: new Date(),
            Message: { create: { senderType: "client", content: mensaje } },
          },
          include: { Message: true },
        });
        return new Response(JSON.stringify(convo), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/empleados/me/conversaciones — conversaciones del empleado (requiere auth)
      if (path === "/api/empleados/me/conversaciones" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const empleado = await prisma.empleado.findUnique({
          where: { clerkUserId },
        });
        if (!empleado)
          return new Response(
            JSON.stringify({ error: "No tenés un perfil de empleado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const convos = await prisma.empleadoConversation.findMany({
          where: { empleadoId: empleado.id },
          include: { Message: { orderBy: { createdAt: "desc" }, take: 1 } },
          orderBy: { updatedAt: "desc" },
        });
        return new Response(JSON.stringify(convos), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/empleados/conversaciones/:id — ver conversación (por token de cliente o auth de empleado)
      if (
        path.match(/^\/api\/empleados\/conversaciones\/[^/]+$/) &&
        method === "GET"
      ) {
        const convId = path.split("/api/empleados/conversaciones/")[1];
        const clientToken = url.searchParams.get("clientToken");
        const clerkUserId = clientToken
          ? null
          : await verifyClerkToken(req).catch(() => null);
        const convo = await prisma.empleadoConversation.findUnique({
          where: { id: convId },
          include: {
            Message: { orderBy: { createdAt: "asc" } },
            empleado: {
              select: {
                slug: true,
                nombre: true,
                apellido: true,
                foto: true,
                whatsapp: true,
                clerkUserId: true,
              },
            },
          },
        });
        if (!convo)
          return new Response(
            JSON.stringify({ error: "Conversación no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const isClient = clientToken && convo.clientToken === clientToken;
        const isEmpleado =
          clerkUserId && convo.empleado.clerkUserId === clerkUserId;
        if (!isClient && !isEmpleado)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        return new Response(JSON.stringify(convo), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/empleados/conversaciones/:id/mensajes — enviar mensaje en conversación
      if (
        path.match(/^\/api\/empleados\/conversaciones\/[^/]+\/mensajes$/) &&
        method === "POST"
      ) {
        const convId = path
          .split("/api/empleados/conversaciones/")[1]
          .replace("/mensajes", "");
        const body = await req.json();
        const clientToken = body.clientToken as string | undefined;
        const clerkUserId = clientToken
          ? null
          : await verifyClerkToken(req).catch(() => null);
        const convo = await prisma.empleadoConversation.findUnique({
          where: { id: convId },
          include: { empleado: { select: { clerkUserId: true } } },
        });
        if (!convo)
          return new Response(
            JSON.stringify({ error: "Conversación no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const isClient = clientToken && convo.clientToken === clientToken;
        const isEmpleado =
          clerkUserId && convo.empleado.clerkUserId === clerkUserId;
        if (!isClient && !isEmpleado)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const content = sanitizeText(body.content as string, 1000);
        if (!content)
          return new Response(
            JSON.stringify({ error: "Falta el contenido del mensaje" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const senderType = isEmpleado ? "professional" : "client";
        const msg = await prisma.empleadoMessage.create({
          data: { conversationId: convId, senderType, content },
        });
        await prisma.empleadoConversation.update({
          where: { id: convId },
          data: { updatedAt: new Date() },
        });

        const preview =
          content.length > 60 ? content.slice(0, 60) + "…" : content;

        // Push al empleado cuando el cliente manda un mensaje
        if (senderType === "client" && convo.empleado.clerkUserId) {
          try {
            const subs = await prisma.pushSubscription.findMany({
              where: { clerkUserId: convo.empleado.clerkUserId },
            });
            console.log(
              `[push/empleado-msg] sending to ${subs.length} subs for ${convo.empleado.clerkUserId}`,
            );
            await Promise.allSettled(
              subs.map(async (sub) => {
                try {
                  await webPush.sendNotification(
                    {
                      endpoint: sub.endpoint,
                      keys: { p256dh: sub.p256dh, auth: sub.auth },
                    },
                    JSON.stringify({
                      title: "Nuevo mensaje",
                      body: preview,
                      url: `/chat/empleado/${convId}`,
                      icon: "/icon-192x192.png",
                      tag: `empleado-${convId}`,
                    }),
                    PUSH_OPTIONS,
                  );
                } catch (err: any) {
                  console.error(
                    `[push/empleado-msg] ERROR ${err.statusCode}`,
                    err.body ?? err.message,
                  );
                  if (err.statusCode === 410 || err.statusCode === 404) {
                    await prisma.pushSubscription
                      .delete({ where: { endpoint: sub.endpoint } })
                      .catch(() => {});
                  }
                }
              }),
            );
          } catch (e) {
            console.error("[push/empleado-msg] unexpected:", e);
          }
        }

        // Push al cliente cuando el empleado responde
        if (senderType === "professional" && convo.clientToken) {
          try {
            const subs = await prisma.pushSubscription.findMany({
              where: {
                OR: [
                  { clientToken: convo.clientToken },
                  { clerkUserId: convo.clientToken },
                ],
              },
            });
            await Promise.allSettled(
              subs.map(async (sub) => {
                try {
                  await webPush.sendNotification(
                    {
                      endpoint: sub.endpoint,
                      keys: { p256dh: sub.p256dh, auth: sub.auth },
                    },
                    JSON.stringify({
                      title: "Te respondieron",
                      body: preview,
                      url: `/chat/empleado/${convId}`,
                      icon: "/icon-192x192.png",
                      tag: `empleado-${convId}`,
                    }),
                    PUSH_OPTIONS,
                  );
                } catch (err: any) {
                  if (err.statusCode === 410 || err.statusCode === 404) {
                    await prisma.pushSubscription
                      .delete({ where: { endpoint: sub.endpoint } })
                      .catch(() => {});
                  }
                }
              }),
            );
          } catch (e) {
            console.error("[push/empleado-client-reply] unexpected:", e);
          }
        }

        return new Response(JSON.stringify(msg), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── FIN EMPLEADOS ────────────────────────────────────────────────────────

      // ─── VACANTES ─────────────────────────────────────────────────────────────

      // POST /api/vacantes — crear vacante (requiere auth + tener comercio)
      if (path === "/api/vacantes" && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(
            JSON.stringify({
              error: "Demasiadas solicitudes. Intentá en un momento.",
            }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          );
        }
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({
              error:
                "Necesitás tener un perfil de comercio para publicar vacantes",
            }),
            {
              status: 403,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const body = await req.json();
        const titulo = sanitizeText(body.titulo as string, 150);
        const descripcion = sanitizeText(body.descripcion as string, 1000);
        if (!titulo || !descripcion)
          return new Response(
            JSON.stringify({ error: "Faltan campos: titulo, descripcion" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const habilidades = Array.isArray(body.habilidades)
          ? body.habilidades
              .map((h: string) => sanitizeText(h, 60))
              .filter(Boolean)
          : [];
        const barrio = sanitizeText(body.barrio as string, 100) || undefined;
        const horario = sanitizeText(body.horario as string, 150) || undefined;
        const salario = sanitizeText(body.salario as string, 80) || undefined;
        const modalidad =
          sanitizeText(body.modalidad as string, 60) || undefined;
        const vacante = await prisma.vacante.create({
          data: {
            comercioId: comercio.id,
            titulo,
            descripcion,
            habilidades,
            barrio,
            horario,
            salario,
            modalidad,
          },
          include: {
            comercio: {
              select: { nombre: true, slug: true, foto: true, rubro: true },
            },
          },
        });
        return new Response(JSON.stringify(vacante), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/vacantes — listar vacantes activas (público)
      if (path === "/api/vacantes" && method === "GET") {
        const barrio = url.searchParams.get("barrio") ?? undefined;
        const habilidad = url.searchParams.get("habilidad") ?? undefined;
        const vacantes = await prisma.vacante.findMany({
          where: {
            activa: true,
            ...(barrio
              ? { barrio: { contains: barrio, mode: "insensitive" } }
              : {}),
            ...(habilidad ? { habilidades: { has: habilidad } } : {}),
          },
          include: {
            comercio: {
              select: { nombre: true, slug: true, foto: true, rubro: true },
            },
          },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(vacantes), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/vacantes/mis — mis vacantes (requiere auth + comercio)
      if (path === "/api/vacantes/mis" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const vacantes = await prisma.vacante.findMany({
          where: { comercioId: comercio.id },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(vacantes), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/vacantes/:id — detalle de vacante (público)
      if (path.match(/^\/api\/vacantes\/[^/]+$/) && method === "GET") {
        const id = path.split("/api/vacantes/")[1];
        if (id === "mis") {
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const vacante = await prisma.vacante.findUnique({
          where: { id },
          include: {
            comercio: {
              select: {
                nombre: true,
                slug: true,
                foto: true,
                rubro: true,
                barrio: true,
                whatsapp: true,
              },
            },
          },
        });
        if (!vacante || !vacante.activa)
          return new Response(
            JSON.stringify({ error: "Vacante no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        return new Response(JSON.stringify(vacante), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/vacantes/:id — actualizar vacante (requiere auth + ser dueño)
      if (path.match(/^\/api\/vacantes\/[^/]+$/) && method === "PUT") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const id = path.split("/api/vacantes/")[1];
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const vacante = await prisma.vacante.findUnique({ where: { id } });
        if (!vacante || vacante.comercioId !== comercio.id)
          return new Response(
            JSON.stringify({ error: "Vacante no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const body = await req.json();
        const updateData: Record<string, unknown> = {};
        if (body.titulo)
          updateData.titulo = sanitizeText(body.titulo as string, 150);
        if (body.descripcion)
          updateData.descripcion = sanitizeText(
            body.descripcion as string,
            1000,
          );
        if (body.habilidades)
          updateData.habilidades = (body.habilidades as string[])
            .map((h) => sanitizeText(h, 60))
            .filter(Boolean);
        if (body.barrio !== undefined)
          updateData.barrio = sanitizeText(body.barrio as string, 100) || null;
        if (body.horario !== undefined)
          updateData.horario =
            sanitizeText(body.horario as string, 150) || null;
        if (body.salario !== undefined)
          updateData.salario = sanitizeText(body.salario as string, 80) || null;
        if (body.modalidad !== undefined)
          updateData.modalidad =
            sanitizeText(body.modalidad as string, 60) || null;
        if (body.activa !== undefined)
          updateData.activa = body.activa === true || body.activa === "true";
        const updated = await prisma.vacante.update({
          where: { id },
          data: updateData,
        });
        return new Response(JSON.stringify(updated), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/vacantes/:id — eliminar vacante (requiere auth + ser dueño)
      if (path.match(/^\/api\/vacantes\/[^/]+$/) && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const id = path.split("/api/vacantes/")[1];
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const vacante = await prisma.vacante.findUnique({ where: { id } });
        if (!vacante || vacante.comercioId !== comercio.id)
          return new Response(
            JSON.stringify({ error: "Vacante no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        await prisma.vacante.delete({ where: { id } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/vacantes/:id/conversaciones — postularse/contactar (público)
      if (
        path.match(/^\/api\/vacantes\/[^/]+\/conversaciones$/) &&
        method === "POST"
      ) {
        const id = path
          .split("/api/vacantes/")[1]
          .replace("/conversaciones", "");
        const vacante = await prisma.vacante.findUnique({ where: { id } });
        if (!vacante || !vacante.activa)
          return new Response(
            JSON.stringify({ error: "Vacante no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const body = await req.json();
        const clientToken = sanitizeText(body.clientToken as string, 100);
        const clientName =
          sanitizeText(body.clientName as string, 100) || undefined;
        const mensaje = sanitizeText(body.mensaje as string, 1000);
        if (!clientToken || !mensaje)
          return new Response(
            JSON.stringify({ error: "Faltan campos: clientToken, mensaje" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const convo = await prisma.vacanteConversation.create({
          data: {
            vacanteId: vacante.id,
            clientToken,
            clientName,
            updatedAt: new Date(),
            Message: { create: { senderType: "client", content: mensaje } },
          },
          include: { Message: true },
        });
        return new Response(JSON.stringify(convo), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/vacantes/mis/conversaciones — ver postulaciones recibidas (requiere auth + comercio)
      if (path === "/api/vacantes/mis/conversaciones" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
        });
        if (!comercio)
          return new Response(
            JSON.stringify({ error: "No tenés un comercio registrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const vacantes = await prisma.vacante.findMany({
          where: { comercioId: comercio.id },
          select: { id: true },
        });
        const vacanteIds = vacantes.map((v) => v.id);
        const convos = await prisma.vacanteConversation.findMany({
          where: { vacanteId: { in: vacanteIds } },
          include: {
            vacante: { select: { titulo: true } },
            Message: { orderBy: { createdAt: "desc" }, take: 1 },
          },
          orderBy: { updatedAt: "desc" },
        });
        return new Response(JSON.stringify(convos), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/vacantes/conversaciones/:id — ver conversación (por token o auth de comercio)
      if (
        path.match(/^\/api\/vacantes\/conversaciones\/[^/]+$/) &&
        method === "GET"
      ) {
        const convId = path.split("/api/vacantes/conversaciones/")[1];
        const clientToken = url.searchParams.get("clientToken");
        const clerkUserId = clientToken
          ? null
          : await verifyClerkToken(req).catch(() => null);
        const convo = await prisma.vacanteConversation.findUnique({
          where: { id: convId },
          include: {
            Message: { orderBy: { createdAt: "asc" } },
            vacante: {
              include: {
                comercio: {
                  select: {
                    clerkUserId: true,
                    nombre: true,
                    slug: true,
                    foto: true,
                    whatsapp: true,
                  },
                },
              },
            },
          },
        });
        if (!convo)
          return new Response(
            JSON.stringify({ error: "Conversación no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const isClient = clientToken && convo.clientToken === clientToken;
        const isComercio =
          clerkUserId && convo.vacante.comercio.clerkUserId === clerkUserId;
        if (!isClient && !isComercio)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        return new Response(JSON.stringify(convo), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/vacantes/conversaciones/:id/mensajes — enviar mensaje
      if (
        path.match(/^\/api\/vacantes\/conversaciones\/[^/]+\/mensajes$/) &&
        method === "POST"
      ) {
        const convId = path
          .split("/api/vacantes/conversaciones/")[1]
          .replace("/mensajes", "");
        const body = await req.json();
        const clientToken = body.clientToken as string | undefined;
        const clerkUserId = clientToken
          ? null
          : await verifyClerkToken(req).catch(() => null);
        const convo = await prisma.vacanteConversation.findUnique({
          where: { id: convId },
          include: {
            vacante: {
              include: { comercio: { select: { clerkUserId: true } } },
            },
          },
        });
        if (!convo)
          return new Response(
            JSON.stringify({ error: "Conversación no encontrada" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const isClient = clientToken && convo.clientToken === clientToken;
        const isComercio =
          clerkUserId && convo.vacante.comercio.clerkUserId === clerkUserId;
        if (!isClient && !isComercio)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const content = sanitizeText(body.content as string, 1000);
        if (!content)
          return new Response(
            JSON.stringify({ error: "Falta el contenido del mensaje" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const senderType = isComercio ? "professional" : "client";
        const msg = await prisma.vacanteMessage.create({
          data: { conversationId: convId, senderType, content },
        });
        await prisma.vacanteConversation.update({
          where: { id: convId },
          data: { updatedAt: new Date() },
        });

        const preview =
          content.length > 60 ? content.slice(0, 60) + "…" : content;

        // Push al comercio cuando el cliente manda un mensaje
        if (senderType === "client") {
          try {
            const comercioClerkId = convo.vacante.comercio.clerkUserId;
            if (comercioClerkId) {
              const subs = await prisma.pushSubscription.findMany({
                where: { clerkUserId: comercioClerkId },
              });
              await Promise.allSettled(
                subs.map(async (sub) => {
                  try {
                    await webPush.sendNotification(
                      {
                        endpoint: sub.endpoint,
                        keys: { p256dh: sub.p256dh, auth: sub.auth },
                      },
                      JSON.stringify({
                        title: "Nuevo mensaje en vacante",
                        body: preview,
                        url: `/chat/vacante/${convId}`,
                        icon: "/icon-192x192.png",
                        tag: `vacante-${convId}`,
                      }),
                      PUSH_OPTIONS,
                    );
                  } catch (err: any) {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                      await prisma.pushSubscription
                        .delete({ where: { endpoint: sub.endpoint } })
                        .catch(() => {});
                    }
                  }
                }),
              );
            }
          } catch (e) {
            console.error("[push/vacante-msg] unexpected:", e);
          }
        }

        // Push al cliente cuando el comercio responde
        if (senderType === "professional" && convo.clientToken) {
          try {
            const subs = await prisma.pushSubscription.findMany({
              where: {
                OR: [
                  { clientToken: convo.clientToken },
                  { clerkUserId: convo.clientToken },
                ],
              },
            });
            await Promise.allSettled(
              subs.map(async (sub) => {
                try {
                  await webPush.sendNotification(
                    {
                      endpoint: sub.endpoint,
                      keys: { p256dh: sub.p256dh, auth: sub.auth },
                    },
                    JSON.stringify({
                      title: "Te respondieron",
                      body: preview,
                      url: `/chat/vacante/${convId}`,
                      icon: "/icon-192x192.png",
                      tag: `vacante-${convId}`,
                    }),
                    PUSH_OPTIONS,
                  );
                } catch (err: any) {
                  if (err.statusCode === 410 || err.statusCode === 404) {
                    await prisma.pushSubscription
                      .delete({ where: { endpoint: sub.endpoint } })
                      .catch(() => {});
                  }
                }
              }),
            );
          } catch (e) {
            console.error("[push/vacante-client-reply] unexpected:", e);
          }
        }

        return new Response(JSON.stringify(msg), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── FIN VACANTES ─────────────────────────────────────────────────────────

      // GET /api/admin/professionals — listar todos los profesionales (requiere auth)
      if (path === "/api/admin/professionals" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const professionals = await prisma.professional.findMany({
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            nombre: true,
            apellido: true,
            slug: true,
            tipo: true,
            oficios: true,
            barrio: true,
            foto: true,
            activo: true,
            ratingAvg: true,
            ratingCount: true,
            createdAt: true,
          },
        });
        return new Response(JSON.stringify(professionals), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/admin/professionals/:id — eliminar profesional (requiere auth admin)
      if (
        path.match(/^\/api\/admin\/professionals\/[^/]+$/) &&
        method === "DELETE"
      ) {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const id = path.split("/")[4];
        await prisma.professional.delete({ where: { id } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }


      // PATCH /api/admin/professionals/:id/pin -- asignar/resetear PIN (requiere auth admin)
      if (
        path.match(/^\/api\/admin\/professionals\/[^\/]+\/pin$/) &&
        method === "PATCH"
      ) {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const id = path.split("/api/admin/professionals/")[1].replace("/pin", "");
        const { pin } = await req.json();
        if (!pin || !/^\d{4}$/.test(String(pin)))
          return new Response(JSON.stringify({ error: "PIN debe ser 4 digitos" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const pinHash = await Bun.password.hash(String(pin));
        await prisma.professional.update({ where: { id }, data: { pin: pinHash } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/admin/reports — listar todos los reportes (requiere auth admin)
      if (path === "/api/admin/reports" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const reports = await prisma.report.findMany({
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return new Response(JSON.stringify(reports), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/admin/reports/:id — eliminar reporte (requiere auth admin)
      if (path.match(/^\/api\/admin\/reports\/[^/]+$/) && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const id = path.split("/")[4];
        await prisma.report.delete({ where: { id } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/admin/reviews — listar todas las reseñas (requiere auth admin)
      if (path === "/api/admin/reviews" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const onlyReported = url.searchParams.get("reported") === "true";
        const reviews = await prisma.publicReview.findMany({
          where: onlyReported ? { reported: true } : undefined,
          orderBy: { createdAt: "desc" },
          take: 100,
          include: {
            professional: {
              select: { nombre: true, apellido: true, slug: true },
            },
          },
        });
        return new Response(JSON.stringify(reviews), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/admin/reviews/:id — eliminar reseña (requiere auth admin)
      if (path.match(/^\/api\/admin\/reviews\/[^/]+$/) && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const id = path.split("/")[4];
        await prisma.publicReview.delete({ where: { id } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/comercios/:slug/track — trackear evento (público)
      if (path.match(/^\/api\/comercios\/[^/]+\/track$/) && method === "POST") {
        if (!checkRateLimit(req)) {
          return new Response(
            JSON.stringify({ error: "Demasiadas solicitudes. Intentá en un momento." }),
            {
              status: 429,
              headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" },
            }
          );
        }
        const slug = path.split("/api/comercios/")[1].replace("/track", "");
        const { type } = await req.json();
        const allowedTypes = ["profile_view", "whatsapp_click", "product_view", "offer_view"];
        if (!allowedTypes.includes(type)) {
          return new Response(
            JSON.stringify({ error: "Tipo de evento inválido" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const comercio = await prisma.comercio.findUnique({ where: { slug }, select: { id: true } });
        if (!comercio) {
          return new Response(
            JSON.stringify({ error: "Comercio no encontrado" }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const today = new Date().toISOString().slice(0, 10);
        await prisma.comercioEventDay.upsert({
          where: { comercioId_type_date: { comercioId: comercio.id, type, date: today } },
          create: { comercioId: comercio.id, type, date: today, count: 1 },
          update: { count: { increment: 1 } },
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/comercios/me/analytics — analytics de mi comercio (requiere auth)
      if (path === "/api/comercios/me/analytics" && method === "GET") {
        if (!checkRateLimit(req)) {
          return new Response(
            JSON.stringify({ error: "Demasiadas solicitudes. Intentá en un momento." }),
            {
              status: 429,
              headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" },
            }
          );
        }
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercio = await prisma.comercio.findUnique({
          where: { clerkUserId },
          select: { id: true },
        });
        if (!comercio)
          return new Response(JSON.stringify({ error: "Comercio no encontrado" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const now = new Date();
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const events = await prisma.comercioEventDay.findMany({
          where: { comercioId: comercio.id, date: { gte: lastMonthStart } },
          orderBy: { date: "asc" },
        });
        const thisMonth: Record<string, number> = {};
        const lastMonth: Record<string, number> = {};
        const last30: Record<string, number> = {};
        const dailyLast30: Record<string, Record<string, number>> = {};
        for (const e of events) {
          if (e.date >= thisMonthStart) {
            thisMonth[e.type] = (thisMonth[e.type] ?? 0) + e.count;
          }
          if (e.date >= lastMonthStart && e.date <= lastMonthEnd) {
            lastMonth[e.type] = (lastMonth[e.type] ?? 0) + e.count;
          }
          if (e.date >= thirtyDaysAgo) {
            last30[e.type] = (last30[e.type] ?? 0) + e.count;
            if (!dailyLast30[e.date]) dailyLast30[e.date] = {};
            dailyLast30[e.date][e.type] = (dailyLast30[e.date][e.type] ?? 0) + e.count;
          }
        }
        return Response.json({ thisMonth, lastMonth, last30, dailyLast30 }, { headers: corsHeaders });
      }

      // PATCH /api/admin/comercios/:id — actualizar isPremium y/o isFounder (requiere auth admin)
      if (path.match(/^\/api\/admin\/comercios\/[^/]+$/) && method === "PATCH") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const id = path.split("/api/admin/comercios/")[1];
        const body = await req.json();
        const data: { isPremium?: boolean; isFounder?: boolean } = {};
        if (typeof body.isPremium === "boolean") data.isPremium = body.isPremium;
        if (typeof body.isFounder === "boolean") data.isFounder = body.isFounder;
        const updated = await prisma.comercio.update({ where: { id }, data });
        return new Response(JSON.stringify(updated), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/admin/comercios — listar todos los comercios (requiere auth admin)
      if (path === "/api/admin/comercios" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const comercios = await prisma.comercio.findMany({
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            nombre: true,
            rubro: true,
            slug: true,
            barrio: true,
            foto: true,
            logo: true,
            activo: true,
            isPremium: true,
            createdAt: true,
          },
        });
        return new Response(JSON.stringify(comercios), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PATCH /api/admin/comercios/:id/premium — toggle premium (requiere auth admin)
      if (
        path.match(/^\/api\/admin\/comercios\/[^/]+\/premium$/) &&
        method === "PATCH"
      ) {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const id = path.split("/")[4];
        const body = await req.json();
        const updated = await prisma.comercio.update({
          where: { id },
          data: { isPremium: !!body.isPremium },
        });
        return new Response(
          JSON.stringify({ id: updated.id, isPremium: updated.isPremium }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // DELETE /api/admin/comercios/:id — eliminar comercio (requiere auth admin)
      if (
        path.match(/^\/api\/admin\/comercios\/[^/]+$/) &&
        method === "DELETE"
      ) {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const admins = (process.env.ADMIN_CLERK_IDS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!admins.includes(clerkUserId))
          return new Response(JSON.stringify({ error: "Acceso denegado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const id = path.split("/")[4];
        await prisma.comercio.delete({ where: { id } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/supermarkets/:id - Eliminar supermercado y sus ofertas
      if (path.match(/^\/api\/supermarkets\/[^/]+$/) && method === "DELETE") {
        const id = path.split("/")[3];
        await db.query('DELETE FROM "Offer" WHERE "supermarketId" = $1', [id]);
        await db.query('DELETE FROM "Supermarket" WHERE id = $1', [id]);
        return new Response(
          JSON.stringify({ message: "Supermercado eliminado" }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // ─── FIN SUPERMARKETS & OFERTAS ───────────────────────────────────────

      // Ruta no encontrada
      // ═══════════════════════════════════════════════════════════════════
      // PROFESIONALES DE OFICIO
      // ═══════════════════════════════════════════════════════════════════

      // GET /api/professionals — listado con filtros
      if (path === "/api/professionals" && method === "GET") {
        const oficio = url.searchParams.get("oficio");
        const barrio = url.searchParams.get("barrio");
        const tipoParam = url.searchParams.get("tipo");
        const tipo =
          tipoParam === "profesion" || tipoParam === "oficio"
            ? tipoParam
            : null;
        const professionals = await prisma.professional.findMany({
          where: {
            activo: true,
            ...(oficio ? { oficios: { has: oficio } } : {}),
            ...(barrio ? { barrio } : {}),
            ...(tipo ? { tipo } : {}),
          },
          select: {
            id: true,
            nombre: true,
            apellido: true,
            slug: true,
            tipo: true,
            oficios: true,
            barrio: true,
            foto: true,
            disponible: true,
            ratingAvg: true,
            ratingCount: true,
            recommendations: true,
          },
        });
        const globalAvg = professionals.length > 0
          ? professionals.reduce((s: number, p: any) => s + p.ratingAvg, 0) / professionals.length
          : 4.0;
        const C = 5;
        professionals.sort((a: any, b: any) => {
          const score = (p: any) => {
            const bayesian = p.ratingCount > 0
              ? (C * globalAvg + p.ratingAvg * p.ratingCount) / (C + p.ratingCount)
              : globalAvg * 0.5;
            return (bayesian / 5) * 60 + Math.min((p.recommendations || 0) / 20, 1) * 30 + (p.foto ? 1 : 0) * 10;
          };
          return score(b) - score(a);
        });
        return new Response(JSON.stringify(professionals), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/professionals/me — perfil propio (requiere auth)
      if (path === "/api/professionals/me" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        const proCode = req.headers.get("X-Professional-Code");
        const professional = clerkUserId
          ? await prisma.professional.findUnique({ where: { clerkUserId } })
          : proCode
          ? await prisma.professional.findUnique({ where: { id: proCode } })
          : null;
        if (!professional)
          return new Response(JSON.stringify({ error: "Perfil no encontrado" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        return new Response(JSON.stringify(professional), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/professionals/:slug/reviews — opiniones públicas (solo no reportadas)
      if (
        path.match(/^\/api\/professionals\/[^/]+\/reviews$/) &&
        method === "GET"
      ) {
        const slug = path.split("/")[3];
        const pro = await prisma.professional.findUnique({ where: { slug } });
        if (!pro)
          return new Response(JSON.stringify({ error: "No encontrado" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const reviews = await prisma.publicReview.findMany({
          where: { professionalId: pro.id, reported: false },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(reviews), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/professionals/:slug/reviews — agregar opinión pública
      if (
        path.match(/^\/api\/professionals\/[^/]+\/reviews$/) &&
        method === "POST"
      ) {
        if (!checkStrictRateLimit(req)) {
          return new Response(
            JSON.stringify({
              error: "Demasiadas solicitudes. Intentá en un momento.",
            }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          );
        }
        const slug = path.split("/")[3];
        const pro = await prisma.professional.findUnique({ where: { slug } });
        if (!pro)
          return new Response(JSON.stringify({ error: "No encontrado" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const contentLength = parseInt(
          req.headers.get("content-length") || "0",
        );
        if (contentLength > 10 * 1024 * 1024) {
          return new Response(
            JSON.stringify({ error: "Payload demasiado grande" }),
            { status: 413, headers: corsHeaders },
          );
        }

        // Requerir autenticación
        let clerkUserId: string | null = null;
        try {
          clerkUserId = await verifyClerkToken(req);
        } catch {}
        if (!clerkUserId) {
          return new Response(
            JSON.stringify({
              error: "Tenés que iniciar sesión para dejar una opinión",
            }),
            {
              status: 401,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const body = await req.json();
        body.comment = sanitizeText(body.comment, 1000);
        body.reviewerName = sanitizeText(body.reviewerName, 60);
        const { score, comment, reviewerName, clientToken } = body;
        if (!score || !comment || comment.trim().length < 10) {
          return new Response(JSON.stringify({ error: "Datos inválidos" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Verificar que el usuario tuvo una conversación con este profesional
        // Cuando está logueado, clientToken === clerkUserId en el chat
        const tokenCandidates = [clerkUserId, clientToken].filter(Boolean);
        const conversation = await prisma.conversation.findFirst({
          where: {
            professionalId: pro.id,
            clientToken: { in: tokenCandidates as string[] },
          },
        });
        if (!conversation) {
          return new Response(
            JSON.stringify({
              error:
                "Primero tenés que contactar al profesional para poder dejar una opinión",
            }),
            {
              status: 403,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Una sola opinión por usuario por profesional
        const existing = await prisma.publicReview.findFirst({
          where: { professionalId: pro.id, clerkUserId },
        });
        if (existing) {
          return new Response(
            JSON.stringify({
              error: "Ya dejaste una opinión para este profesional",
            }),
            {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const review = await prisma.publicReview.create({
          data: {
            professionalId: pro.id,
            clerkUserId,
            reviewerName: reviewerName?.trim() || "Vecino anónimo",
            score: Math.min(5, Math.max(1, Number(score))),
            comment: comment.trim().slice(0, 1000),
          },
        });
        // Recalcular ratingAvg y ratingCount
        const agg = await prisma.publicReview.aggregate({
          where: { professionalId: pro.id, reported: false },
          _avg: { score: true },
          _count: { score: true },
        });
        await prisma.professional.update({
          where: { id: pro.id },
          data: {
            ratingAvg: Math.round((agg._avg.score ?? 0) * 10) / 10,
            ratingCount: agg._count.score,
          },
        });
        return new Response(JSON.stringify(review), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/professionals/:slug/reviews/:reviewId/report — reportar opinión abusiva
      if (
        path.match(/^\/api\/professionals\/[^/]+\/reviews\/[^/]+\/report$/) &&
        method === "POST"
      ) {
        let clerkUserId: string | null = null;
        try {
          clerkUserId = await verifyClerkToken(req);
        } catch {}
        if (!clerkUserId) {
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const parts = path.split("/");
        const reviewId = parts[5];
        const review = await prisma.publicReview.findUnique({
          where: { id: reviewId },
        });
        if (!review)
          return new Response(JSON.stringify({ error: "No encontrada" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        if (review.reported) {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        await prisma.publicReview.update({
          where: { id: reviewId },
          data: { reported: true, reportedAt: new Date() },
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/professionals/id/:id — perfil por ID
      if (path.match(/^\/api\/professionals\/id\/[^/]+$/) && method === "GET") {
        const id = path.split("/api/professionals/id/")[1];
        const pro = await prisma.professional.findUnique({ where: { id } });
        if (!pro)
          return new Response(JSON.stringify({ error: "No encontrado" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const { telefono, whatsapp, clerkUserId, ...publicData } = pro;
        return new Response(JSON.stringify(publicData), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }


      // POST /api/professionals/:slug/recommend — recomendar profesional (anónimo)
      if (
        path.match(/^\/api\/professionals\/[^/]+\/recommend$/) &&
        method === POST
      ) {
        const slug = path.split(/api/professionals/)[1].replace(/recommend, );
        const pro = await prisma.professional.findUnique({
          where: { slug },
          select: { id: true, recommendations: true },
        });
        if (!pro)
          return new Response(JSON.stringify({ error: No encontrado }), {
            status: 404, headers: { ...corsHeaders, Content-Type: application/json },
          });
        const ip = req.headers.get(x-forwarded-for)?.split(,)[0]?.trim() || unknown;
        const ipBytes = new TextEncoder().encode(ip + pro.id);
        const hashBuf = await crypto.subtle.digest(SHA-256, ipBytes);
        const ipHash = Array.from(new Uint8Array(hashBuf)).map((b: number) => b.toString(16).padStart(2, 0)).join();
        try {
          await prisma.recommendation.create({
            data: { targetType: professional, targetId: pro.id, ipHash },
          });
          const updated = await prisma.professional.update({
            where: { id: pro.id },
            data: { recommendations: { increment: 1 } },
            select: { recommendations: true },
          });
          return new Response(JSON.stringify({ ok: true, count: updated.recommendations }), {
            headers: { ...corsHeaders, Content-Type: application/json },
          });
        } catch (e: any) {
          if (e?.code === P2002)
            return new Response(JSON.stringify({ ok: false, already: true, count: pro.recommendations }), {
              headers: { ...corsHeaders, Content-Type: application/json },
            });
          throw e;
        }
      }

      // GET /api/professionals/:slug — perfil público
      if (path.startsWith("/api/professionals/") && method === "GET") {
        const slug = path.split("/api/professionals/")[1];
        const professional = await prisma.professional.findUnique({
          where: { slug },
          include: {
            Rating: {
              where: { scoreByClient: { not: null } },
              select: {
                scoreByClient: true,
                commentByClient: true,
                createdAt: true,
              },
              orderBy: { createdAt: "desc" },
              take: 10,
            },
          },
        });
        if (!professional)
          return new Response(JSON.stringify({ error: "No encontrado" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const { telefono, clerkUserId, ...publicData } = professional;
        return new Response(JSON.stringify(publicData), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/professionals/auth -- autenticar con WhatsApp + PIN
      if (path === "/api/professionals/auth" && method === "POST") {
        const body = await req.json();
        const { whatsapp, pin } = body;
        if (!whatsapp || !pin)
          return new Response(JSON.stringify({ error: "Datos incompletos" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const waClean = String(whatsapp).replace(/\D/g, "");
        const pro = await prisma.professional.findFirst({
          where: {
            OR: [
              { whatsapp: waClean },
              { whatsapp: "549" + waClean.slice(-10) },
            ],
          },
        });
        if (!pro || !pro.pin)
          return new Response(JSON.stringify({ error: "Numero o PIN incorrecto" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const valid = await Bun.password.verify(String(pin), pro.pin);
        if (!valid)
          return new Response(JSON.stringify({ error: "Numero o PIN incorrecto" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        return new Response(JSON.stringify({ id: pro.id, nombre: pro.nombre, slug: pro.slug }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

            // POST /api/professionals — crear perfil (auth opcional, registro anónimo permitido)
      if (path === "/api/professionals" && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(
            JSON.stringify({
              error: "Demasiadas solicitudes. Intentá en un momento.",
            }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          );
        }
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (clerkUserId) {
          const existing = await prisma.professional.findUnique({
            where: { clerkUserId },
          });
          if (existing)
            return new Response(
              JSON.stringify({ error: "Ya tenés un perfil creado" }),
              {
                status: 409,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
        }
        const contentLength = parseInt(
          req.headers.get("content-length") || "0",
        );
        if (contentLength > 10 * 1024 * 1024) {
          return new Response(
            JSON.stringify({ error: "Payload demasiado grande" }),
            { status: 413, headers: corsHeaders },
          );
        }
        const body = await req.json();
        body.nombre = sanitizeText(body.nombre, 60);
        body.apellido = sanitizeText(body.apellido, 60);
        body.descripcion = sanitizeText(body.descripcion, 500);
        const {
          nombre,
          apellido,
          tipo,
          oficios,
          descripcion,
          telefono,
          whatsapp,
          pin,
        } = body;
        const safeTipo =
          tipo === "profesion" || tipo === "oficio" ? tipo : null;
        if (!nombre || !apellido || !oficios?.length || !whatsapp) {
          return new Response(
            JSON.stringify({ error: "Faltan campos obligatorios" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const slug = generateSlug(nombre, apellido, oficios);
        const professional = await prisma.professional.create({
          data: {
            clerkUserId: clerkUserId || null,
            nombre,
            apellido,
            slug,
            tipo: safeTipo,
            pin: pin ? await Bun.password.hash(pin) : null,
            oficios,
            descripcion,
            telefono,
            whatsapp,
            updatedAt: new Date(),
          },
        });
        return new Response(JSON.stringify(professional), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/professionals/me — actualizar perfil propio (requiere auth)
      if (path === "/api/professionals/me" && method === "PUT") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        const proCodePut = req.headers.get("X-Professional-Code");
        const proToUpdate = clerkUserId
          ? await prisma.professional.findUnique({ where: { clerkUserId } })
          : proCodePut
          ? await prisma.professional.findUnique({ where: { id: proCodePut } })
          : null;
        if (!proToUpdate)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const body = await req.json();
        const {
          nombre,
          apellido,
          tipo,
          oficios,
          descripcion,
          barrio,
          telefono,
          whatsapp,
          disponible,
          fotos,
          foto,
        } = body;
        const safeTipo =
          tipo === "profesion" || tipo === "oficio" ? tipo : undefined;
        const professional = await prisma.professional.update({
          where: { id: proToUpdate.id },
          data: {
            nombre,
            apellido,
            ...(safeTipo ? { tipo: safeTipo } : {}),
            oficios,
            descripcion,
            barrio,
            telefono,
            whatsapp,
            disponible,
            fotos,
            foto,
          },
        });
        return new Response(JSON.stringify(professional), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/professionals/me/photo — subir foto de perfil profesional
      if (path === "/api/professionals/me/photo" && method === "POST") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        const proCodePhoto = req.headers.get("X-Professional-Code");
        const proForPhoto = clerkUserId
          ? await prisma.professional.findUnique({ where: { clerkUserId } })
          : proCodePhoto
          ? await prisma.professional.findUnique({ where: { id: proCodePhoto } })
          : null;
        if (!proForPhoto)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const formData = await req.formData();
        const photoFile = formData.get("photo") as File | null;
        if (!photoFile || photoFile.size === 0) {
          return new Response(
            JSON.stringify({ error: "No se recibió ninguna imagen" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const ext = photoFile.name.split(".").pop() || "jpg";
        const filename = `professional_${crypto.randomUUID()}.${ext}`;
        const filePath = join(uploadsDir, filename);
        await Bun.write(filePath, await photoFile.arrayBuffer());
        const fotoUrl = `/uploads/${filename}`;
        const professional = await prisma.professional.update({
          where: { id: proForPhoto.id },
          data: { foto: fotoUrl },
        });
        return new Response(JSON.stringify({ foto: professional.foto }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ═══════════════════════════════════════════════════════════════════

      // POST /api/professionals/me/fotos — agregar foto a galería (requiere auth)
      if (path === "/api/professionals/me/fotos" && method === "POST") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        const proFotosCode = req.headers.get("X-Professional-Code");
        if (!clerkUserId && !proFotosCode)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const formData = await req.formData();
        const photoFile = formData.get("photo") as File | null;
        if (!photoFile || photoFile.size === 0)
          return new Response(JSON.stringify({ error: "No se recibió imagen" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const ext = photoFile.name.split(".").pop()?.toLowerCase() || "jpg";
        const filename = "professional_gallery_" + crypto.randomUUID() + "." + ext;
        await Bun.write(join(uploadsDir, filename), await photoFile.arrayBuffer());
        const fotoUrl = "/uploads/" + filename;
        const pro = clerkUserId
          ? await prisma.professional.findUnique({ where: { clerkUserId } })
          : await prisma.professional.findUnique({ where: { id: proFotosCode! } });
        if (!pro)
          return new Response(JSON.stringify({ error: "Perfil no encontrado" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const updated = await prisma.professional.update({
          where: { id: pro.id },
          data: { fotos: [...pro.fotos, fotoUrl] },
        });
        return new Response(JSON.stringify({ fotos: updated.fotos }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/professionals/me/fotos — eliminar foto de galería (requiere auth)
      if (path === "/api/professionals/me/fotos" && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        const proDelCode = req.headers.get("X-Professional-Code");
        if (!clerkUserId && !proDelCode)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const { fotoUrl } = await req.json();
        const pro = clerkUserId
          ? await prisma.professional.findUnique({ where: { clerkUserId } })
          : await prisma.professional.findUnique({ where: { id: proDelCode! } });
        if (!pro)
          return new Response(JSON.stringify({ error: "Perfil no encontrado" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const fotos = pro.fotos.filter((f: string) => f !== fotoUrl);
        await prisma.professional.update({ where: { id: pro.id }, data: { fotos } });
        return new Response(JSON.stringify({ fotos }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }


      // FAVORITOS
      // ═══════════════════════════════════════════════════════════════════

      // GET /api/favorites — favoritos del usuario logueado
      if (path === "/api/favorites" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        let user = await prisma.user.findUnique({ where: { clerkUserId } });
        if (!user)
          return new Response(JSON.stringify([]), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const favs = await prisma.userFavorite.findMany({
          where: { userId: user.id },
          include: {
            Professional: {
              select: {
                nombre: true,
                apellido: true,
                oficios: true,
                foto: true,
                slug: true,
                ratingAvg: true,
                ratingCount: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(favs), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/favorites — agregar favorito
      if (path === "/api/favorites" && method === "POST") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const { professionalId } = await req.json();
        if (!professionalId)
          return new Response(
            JSON.stringify({ error: "Falta professionalId" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        let user = await prisma.user.findUnique({ where: { clerkUserId } });
        if (!user) {
          user = await prisma.user.create({
            data: { clerkUserId, updatedAt: new Date() },
          });
        }
        const fav = await prisma.userFavorite.upsert({
          where: { userId_professionalId: { userId: user.id, professionalId } },
          create: { userId: user.id, professionalId },
          update: {},
        });
        return new Response(JSON.stringify(fav), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/favorites/:professionalId — quitar favorito
      if (path.startsWith("/api/favorites/") && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const professionalId = path.split("/api/favorites/")[1];
        const user = await prisma.user.findUnique({ where: { clerkUserId } });
        if (!user)
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        await prisma.userFavorite.deleteMany({
          where: { userId: user.id, professionalId },
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ═══════════════════════════════════════════════════════════════════
      // CONVERSACIONES
      // ═══════════════════════════════════════════════════════════════════

      // POST /api/conversations — cliente inicia contacto
      if (path === "/api/conversations" && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(
            JSON.stringify({
              error: "Demasiadas solicitudes. Intentá en un momento.",
            }),
            {
              status: 429,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Retry-After": "60",
              },
            },
          );
        }
        const contentLength = parseInt(
          req.headers.get("content-length") || "0",
        );
        if (contentLength > 10 * 1024 * 1024) {
          return new Response(
            JSON.stringify({ error: "Payload demasiado grande" }),
            { status: 413, headers: corsHeaders },
          );
        }
        const body = await req.json();
        body.firstMessage = sanitizeText(body.firstMessage, 500);
        const { professionalId, clientToken, firstMessage, clientName } = body;
        if (!professionalId || !clientToken || !firstMessage) {
          return new Response(
            JSON.stringify({ error: "Faltan campos obligatorios" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const conversation = await prisma.conversation.create({
          data: {
            professionalId,
            clientToken,
            clientName: clientName ? sanitizeText(clientName, 80) : null,
            updatedAt: new Date(),
            Message: {
              create: { senderType: "client", content: firstMessage },
            },
          },
          include: { Message: true },
        });

        // Enviar push notification al profesional
        try {
          const professional = await prisma.professional.findUnique({
            where: { id: professionalId },
          });
          if (professional?.clerkUserId) {
            const subs = await prisma.pushSubscription.findMany({
              where: { clerkUserId: professional.clerkUserId },
            });
            console.log(
              `[push/nuevo-contacto] sending to ${subs.length} subs for ${professional.clerkUserId}`,
            );
            const preview =
              firstMessage.length > 60
                ? firstMessage.slice(0, 60) + "…"
                : firstMessage;
            const results = await Promise.allSettled(
              subs.map(async (sub) => {
                try {
                  await webPush.sendNotification(
                    {
                      endpoint: sub.endpoint,
                      keys: { p256dh: sub.p256dh, auth: sub.auth },
                    },
                    JSON.stringify({
                      title: "Nuevo contacto",
                      body: preview,
                      url: `/chat/${conversation.id}`,
                      icon: "/icon-192x192.png",
                    }),
                    PUSH_OPTIONS,
                  );
                  console.log(
                    `[push/nuevo-contacto] OK → ${sub.endpoint.slice(0, 60)}`,
                  );
                } catch (err: any) {
                  console.error(
                    `[push/nuevo-contacto] ERROR ${err.statusCode} → ${sub.endpoint.slice(0, 60)}`,
                    err.body ?? err.message,
                  );
                  if (err.statusCode === 410 || err.statusCode === 404) {
                    await prisma.pushSubscription
                      .delete({ where: { endpoint: sub.endpoint } })
                      .catch(() => {});
                  }
                }
              }),
            );
            console.log(
              `[push/nuevo-contacto] done: ${results.map((r) => r.status).join(", ")}`,
            );
          }
        } catch (e) {
          console.error("[push/nuevo-contacto] unexpected:", e);
        }

        // Enviar email al profesional via Resend
        if (resend) {
          try {
            const professional = await prisma.professional.findUnique({
              where: { id: professionalId },
            });
            if (professional?.clerkUserId) {
              const clerkUser = await clerk.users.getUser(
                professional.clerkUserId,
              );
              const email = clerkUser.emailAddresses[0]?.emailAddress;
              if (email) {
                await resend.emails.send({
                  from: "Reportes Reconquista <notificaciones@reportesreconquista.com>",
                  to: email,
                  subject: `Nuevo mensaje de un cliente`,
                  html: `
                    <div style="font-family: 'Montserrat', sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #f1f5f9; padding: 32px; border-radius: 16px;">
                      <img src="https://reportesreconquista.com/icon-192x192.png" width="48" height="48" style="border-radius: 12px; margin-bottom: 24px;" />
                      <h2 style="color: #ffffff; margin: 0 0 8px;">Tenes un nuevo mensaje</h2>
                      <p style="color: #94a3b8; margin: 0 0 24px;">Un vecino quiere contactarte a traves de Reportes Reconquista.</p>
                      <div style="background: #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 24px; border-left: 4px solid #6366f1;">
                        <p style="color: #e2e8f0; margin: 0; font-style: italic;">"${firstMessage.slice(0, 200)}${firstMessage.length > 200 ? "..." : ""}"</p>
                      </div>
                      <a href="https://reportesreconquista.com/chat/${conversation.id}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                        Ver mensaje y responder
                      </a>
                      <p style="color: #475569; font-size: 12px; margin-top: 32px;">Reportes Reconquista · Reconquista, Santa Fe</p>
                    </div>
                  `,
                });
              }
            }
          } catch (e) {
            console.error("[email] Error enviando notificacion:", e);
          }
        }

        return new Response(JSON.stringify(conversation), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/conversations/unread-count — mensajes no leídos para el profesional (requiere auth)
      if (path === "/api/conversations/unread-count" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ count: 0 }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const professional = await prisma.professional.findUnique({
          where: { clerkUserId },
        });
        if (!professional)
          return new Response(JSON.stringify({ count: 0 }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const count = await prisma.message.count({
          where: {
            read: false,
            senderType: "client",
            Conversation: { professionalId: professional.id },
          },
        });
        return new Response(JSON.stringify({ count }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/conversations/professional — conversaciones del profesional (requiere auth)
      if (path === "/api/conversations/professional" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (!clerkUserId)
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const professional = await prisma.professional.findUnique({
          where: { clerkUserId },
        });
        if (!professional)
          return new Response(
            JSON.stringify({ error: "Perfil no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const limit = Math.min(
          parseInt(url.searchParams.get("limit") || "20"),
          50,
        );
        const cursor = url.searchParams.get("cursor") || undefined;
        const conversations = await prisma.conversation.findMany({
          where: { professionalId: professional.id },
          include: {
            Professional: {
              select: {
                nombre: true,
                apellido: true,
                slug: true,
                foto: true,
                oficios: true,
              },
            },
            Message: { orderBy: { createdAt: "desc" }, take: 1 },
          },
          orderBy: { updatedAt: "desc" },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        const hasMore = conversations.length > limit;
        const items = hasMore ? conversations.slice(0, limit) : conversations;
        // Agregar conteo real de no leídos (mensajes del cliente no leídos por el profesional)
        const withUnread = await Promise.all(
          items.map(async (c) => ({
            ...c,
            _unreadCount: await prisma.message.count({
              where: {
                conversationId: c.id,
                senderType: "client",
                read: false,
              },
            }),
          })),
        );
        return new Response(
          JSON.stringify({
            items: withUnread,
            hasMore,
            nextCursor: hasMore ? items[items.length - 1].id : null,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // GET /api/conversations/client/:token — conversaciones del cliente anónimo
      if (path.startsWith("/api/conversations/client/") && method === "GET") {
        const clientToken = path.split("/api/conversations/client/")[1];
        const limit = Math.min(
          parseInt(url.searchParams.get("limit") || "20"),
          50,
        );
        const cursor = url.searchParams.get("cursor") || undefined;
        const conversations = await prisma.conversation.findMany({
          where: { clientToken },
          include: {
            Professional: {
              select: {
                nombre: true,
                apellido: true,
                slug: true,
                foto: true,
                oficios: true,
              },
            },
            Message: { orderBy: { createdAt: "desc" }, take: 1 },
          },
          orderBy: { updatedAt: "desc" },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        const hasMore = conversations.length > limit;
        const items = hasMore ? conversations.slice(0, limit) : conversations;
        // Agregar conteo real de no leídos (mensajes del profesional no leídos por el cliente)
        const withUnread = await Promise.all(
          items.map(async (c) => ({
            ...c,
            _unreadCount: await prisma.message.count({
              where: {
                conversationId: c.id,
                senderType: "professional",
                read: false,
              },
            }),
          })),
        );
        return new Response(
          JSON.stringify({
            items: withUnread,
            hasMore,
            nextCursor: hasMore ? items[items.length - 1].id : null,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // DELETE /api/conversations/:id — eliminar conversación (cliente por clientToken o profesional por Clerk)
      if (path.match(/^\/api\/conversations\/[^/]+$/) && method === "DELETE") {
        const conversationId = path.split("/api/conversations/")[1];
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
        });
        if (!conversation)
          return new Response(JSON.stringify({ error: "No encontrada" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });

        const clientToken = url.searchParams.get("clientToken");
        const clerkUserId = await verifyClerkToken(req).catch(() => null);

        // Cliente anónimo: clientToken UUID en query param
        const isAnonClient = !!(
          clientToken && conversation.clientToken === clientToken
        );
        // Cliente logueado: Clerk userId guardado como clientToken al crear la conv
        const isClerkClient = !!(
          clerkUserId && conversation.clientToken === clerkUserId
        );
        // Profesional dueño de la conversación
        const isProfessional = clerkUserId
          ? !!(await prisma.professional.findFirst({
              where: { clerkUserId, id: conversation.professionalId },
            }))
          : false;

        if (!isAnonClient && !isClerkClient && !isProfessional) {
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        await prisma.message.deleteMany({ where: { conversationId } });
        await prisma.conversation.delete({ where: { id: conversationId } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/conversations/:id — detalle con mensajes
      if (path.startsWith("/api/conversations/") && method === "GET") {
        const conversationId = path.split("/api/conversations/")[1];
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: {
            Professional: {
              select: {
                nombre: true,
                apellido: true,
                slug: true,
                foto: true,
                oficios: true,
                clerkUserId: true,
                whatsapp: true,
              },
            },
            Message: { orderBy: { createdAt: "asc" } },
          },
        });
        if (!conversation)
          return new Response(JSON.stringify({ error: "No encontrada" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });

        // Marcar mensajes del cliente como leídos si el que abre es el profesional
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        if (
          clerkUserId &&
          clerkUserId === conversation.Professional.clerkUserId
        ) {
          await prisma.message.updateMany({
            where: { conversationId, senderType: "client", read: false },
            data: { read: true },
          });
        }

        return new Response(JSON.stringify(conversation), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/conversations/:id/status — cambiar estado
      if (
        path.match(/^\/api\/conversations\/[^/]+\/status$/) &&
        method === "PUT"
      ) {
        const conversationId = path.split("/")[3];
        const body = await req.json();
        const { status, clientToken } = body;
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { Professional: true },
        });
        if (!conversation)
          return new Response(JSON.stringify({ error: "No encontrada" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        const isProfessional =
          clerkUserId && conversation.Professional.clerkUserId === clerkUserId;
        const isClient =
          clientToken && conversation.clientToken === clientToken;
        if (!isProfessional && !isClient) {
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const updated = await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            status,
            ...(status === "agreed" ? { agreedAt: new Date() } : {}),
            ...(status === "completed" ? { completedAt: new Date() } : {}),
          },
        });
        return new Response(JSON.stringify(updated), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ═══════════════════════════════════════════════════════════════════
      // CALIFICACIONES
      // ═══════════════════════════════════════════════════════════════════

      // POST /api/ratings — calificar (cliente o profesional)
      if (path === "/api/ratings" && method === "POST") {
        const body = await req.json();
        const {
          conversationId,
          clientToken,
          scoreByClient,
          commentByClient,
          scoreByPro,
          commentByPro,
        } = body;
        if (!conversationId)
          return new Response(
            JSON.stringify({ error: "Falta conversationId" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { Professional: true },
        });
        if (!conversation || conversation.status !== "completed") {
          return new Response(
            JSON.stringify({
              error: "La conversación debe estar completada para calificar",
            }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const clerkUserId = await verifyClerkToken(req).catch(() => null);
        const isProfessional =
          clerkUserId && conversation.Professional.clerkUserId === clerkUserId;
        const isClient =
          clientToken && conversation.clientToken === clientToken;
        if (!isProfessional && !isClient) {
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const existing = await prisma.rating.findUnique({
          where: { conversationId },
        });
        let rating;
        if (existing) {
          rating = await prisma.rating.update({
            where: { conversationId },
            data: {
              ...(isClient && scoreByClient != null
                ? { scoreByClient, commentByClient }
                : {}),
              ...(isProfessional && scoreByPro != null
                ? { scoreByPro, commentByPro }
                : {}),
            },
          });
        } else {
          rating = await prisma.rating.create({
            data: {
              conversationId,
              professionalId: conversation.professionalId,
              clientToken: conversation.clientToken,
              ...(isClient && scoreByClient != null
                ? { scoreByClient, commentByClient }
                : {}),
              ...(isProfessional && scoreByPro != null
                ? { scoreByPro, commentByPro }
                : {}),
            },
          });
        }
        await recalcProfessionalRating(conversation.professionalId);
        return new Response(JSON.stringify(rating), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ═══════════════════════════════════════════════════════════════════
      // CLASIFICADOS
      // ═══════════════════════════════════════════════════════════════════

      // GET /api/clasificados — listado con filtros
      if (path === "/api/clasificados" && method === "GET") {
        const barrio = url.searchParams.get("barrio");
        const categoria = url.searchParams.get("categoria");
        const clasificados = await prisma.clasificado.findMany({
          where: {
            activo: true,
            expiresAt: { gt: new Date() },
            ...(barrio ? { barrio } : {}),
            ...(categoria ? { categoria } : {}),
          },
          select: {
            id: true,
            titulo: true,
            descripcion: true,
            precio: true,
            categoria: true,
            barrio: true,
            fotos: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(clasificados), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/clasificados — crear aviso
      if (path === "/api/clasificados" && method === "POST") {
        const contentLength = parseInt(
          req.headers.get("content-length") || "0",
        );
        if (contentLength > 10 * 1024 * 1024) {
          return new Response(
            JSON.stringify({ error: "Payload demasiado grande" }),
            { status: 413, headers: corsHeaders },
          );
        }
        const body = await req.json();
        body.titulo = sanitizeText(body.titulo, 100);
        body.descripcion = sanitizeText(body.descripcion, 1000);
        const { titulo, descripcion, precio, categoria, barrio, clientToken } =
          body;
        if (!titulo || !descripcion || !categoria || !barrio || !clientToken) {
          return new Response(
            JSON.stringify({ error: "Faltan campos obligatorios" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        const clasificado = await prisma.clasificado.create({
          data: {
            titulo,
            descripcion,
            precio,
            categoria,
            barrio,
            clientToken,
            expiresAt,
          },
        });
        return new Response(JSON.stringify(clasificado), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/clasificados/:id — actualizar (solo el dueño por clientToken)
      if (path.startsWith("/api/clasificados/") && method === "PUT") {
        const id = path.split("/api/clasificados/")[1];
        const body = await req.json();
        const { clientToken, ...data } = body;
        const existing = await prisma.clasificado.findUnique({ where: { id } });
        if (!existing || existing.clientToken !== clientToken) {
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const updated = await prisma.clasificado.update({
          where: { id },
          data,
        });
        return new Response(JSON.stringify(updated), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // DELETE /api/clasificados/:id — borrar (solo el dueño por clientToken)
      if (path.startsWith("/api/clasificados/") && method === "DELETE") {
        const id = path.split("/api/clasificados/")[1];
        const clientToken = url.searchParams.get("clientToken");
        const existing = await prisma.clasificado.findUnique({ where: { id } });
        if (!existing || existing.clientToken !== clientToken) {
          return new Response(JSON.stringify({ error: "No autorizado" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        await prisma.clasificado.delete({ where: { id } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Ruta no encontrada" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (error: any) {
      console.error("Error:", error);
      return new Response(
        JSON.stringify({
          error: error.message || "Error interno del servidor",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  },

  websocket: {
    async open(ws) {
      const { conversationId } = ws.data as {
        conversationId: string;
        senderType: string;
        token: string;
      };
      ws.subscribe(`conversation:${conversationId}`);

      // Marcar mensajes del otro lado como leídos al abrir
      const { senderType } = ws.data as { senderType: string };
      const otherSender = senderType === "client" ? "professional" : "client";
      await prisma.message.updateMany({
        where: { conversationId, senderType: otherSender, read: false },
        data: { read: true },
      });

      // Notificar al otro lado que sus mensajes fueron leídos
      server.publish(
        `conversation:${conversationId}`,
        JSON.stringify({ type: "read", senderType: otherSender }),
      );
    },

    async message(ws, raw) {
      const { conversationId, senderType } = ws.data as {
        conversationId: string;
        senderType: string;
      };

      let parsed: { content?: string; type?: string };
      try {
        parsed = JSON.parse(raw as string);
      } catch {
        ws.send(JSON.stringify({ error: "Mensaje inválido" }));
        return;
      }

      // Typing event — broadcast sin guardar
      if (parsed.type === "typing") {
        server.publish(
          `conversation:${conversationId}`,
          JSON.stringify({ type: "typing", senderType }),
        );
        return;
      }

      // Mark read event — marca mensajes del otro lado como leídos
      if (parsed.type === "mark_read") {
        const otherSender = senderType === "client" ? "professional" : "client";
        await prisma.message.updateMany({
          where: { conversationId, senderType: otherSender, read: false },
          data: { read: true },
        });
        server.publish(
          `conversation:${conversationId}`,
          JSON.stringify({ type: "read", senderType: otherSender }),
        );
        return;
      }

      const { content } = parsed;
      if (!content?.trim()) return;

      const message = await prisma.message.create({
        data: { conversationId, senderType, content: content.trim() },
      });

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });

      // Broadcast a todos los conectados en la conversación (incluido el emisor)
      server.publish(
        `conversation:${conversationId}`,
        JSON.stringify({ type: "message", data: message }),
      );

      // Push notification
      {
        const conv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { professionalId: true, clientToken: true },
        });

        // Push al profesional cuando el cliente manda un mensaje
        if (senderType === "client" && conv) {
          try {
            const pro = await prisma.professional.findUnique({
              where: { id: conv.professionalId },
              select: { clerkUserId: true },
            });
            if (pro?.clerkUserId) {
              const subs = await prisma.pushSubscription.findMany({
                where: { clerkUserId: pro.clerkUserId },
              });
              console.log(
                `[push] sending to ${subs.length} subscriptions for ${pro.clerkUserId}`,
              );
              const preview =
                content.trim().length > 60
                  ? content.trim().slice(0, 60) + "…"
                  : content.trim();
              const results = await Promise.allSettled(
                subs.map((sub) =>
                  webPush
                    .sendNotification(
                      {
                        endpoint: sub.endpoint,
                        keys: { p256dh: sub.p256dh, auth: sub.auth },
                      },
                      JSON.stringify({
                        title: "Nuevo mensaje",
                        body: preview,
                        url: `/chat/${conversationId}`,
                        icon: "/icon-192x192.png",
                        tag: `chat-${conversationId}`,
                      }),
                      PUSH_OPTIONS,
                    )
                    .catch(async (err: any) => {
                      console.error(
                        "[push] sendNotification error:",
                        err.statusCode,
                        err.body ?? err.message,
                      );
                      if (err.statusCode === 410 || err.statusCode === 404) {
                        await prisma.pushSubscription
                          .delete({ where: { endpoint: sub.endpoint } })
                          .catch(() => {});
                      }
                    }),
                ),
              );
              console.log(
                "[push] results:",
                results.map((r) => r.status),
              );
            }
          } catch (e) {
            console.error("[push] unexpected error:", e);
          }
        }

        // Push al cliente (anónimo o logueado) cuando el profesional responde
        if (senderType === "professional" && conv?.clientToken) {
          try {
            const subs = await prisma.pushSubscription.findMany({
              where: {
                OR: [
                  { clientToken: conv.clientToken },
                  { clerkUserId: conv.clientToken },
                ],
              },
            });
            if (subs.length > 0) {
              const preview =
                content.trim().length > 60
                  ? content.trim().slice(0, 60) + "…"
                  : content.trim();
              await Promise.allSettled(
                subs.map(async (sub) => {
                  try {
                    await webPush.sendNotification(
                      {
                        endpoint: sub.endpoint,
                        keys: { p256dh: sub.p256dh, auth: sub.auth },
                      },
                      JSON.stringify({
                        title: "Te respondieron",
                        body: preview,
                        url: `/chat/${conversationId}`,
                        icon: "/icon-192x192.png",
                        tag: `chat-${conversationId}`,
                      }),
                      PUSH_OPTIONS,
                    );
                  } catch (err: any) {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                      await prisma.pushSubscription
                        .delete({ where: { endpoint: sub.endpoint } })
                        .catch(() => {});
                    }
                  }
                }),
              );
            }
          } catch (e) {
            console.error("[push/client-reply] unexpected error:", e);
          }
        }
      }
    },

    close(ws) {
      const { conversationId } = ws.data as { conversationId: string };
      ws.unsubscribe(`conversation:${conversationId}`);
    },
  },
});

console.log(`🚀 Servidor API corriendo en http://localhost:${server.port}`);
