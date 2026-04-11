import { db } from "./lib/db";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import webPush from "web-push";
import { OBRAS_SOCIALES } from "./lib/constants";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { PrismaClient } from "@prisma/client";
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const prisma = new PrismaClient();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

// ── Rate limiting ─────────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 60; // requests por ventana
const RATE_WINDOW = 60_000; // 1 minuto en ms

const strictRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const STRICT_RATE_LIMIT = 10; // requests por ventana para escrituras críticas

function getRateLimitKey(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
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
  return input
    .trim()
    .slice(0, maxLength)
    // Remover caracteres de control excepto newlines y tabs
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Remover secuencias que parecen SQL injection
    .replace(/(['";])\s*(--|\/\*|DROP|DELETE|INSERT|UPDATE|SELECT|UNION|ALTER|CREATE|EXEC|EXECUTE)\s/gi, "");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function verifyClerkToken(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    const token = authHeader.slice(7);
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
      authorizedParties: [
        "http://localhost:3000",
        "https://reportesreconquista.com",
      ],
    });
    return payload.sub;
  } catch (e) {
    console.error("[verifyClerkToken] error:", e);
    return null;
  }
}

function generateSlug(nombre: string, apellido: string, oficios: string[]): string {
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
await db.query(`CREATE INDEX IF NOT EXISTS "PageView_sessionId_idx" ON "PageView" ("sessionId")`);
await db.query(`CREATE INDEX IF NOT EXISTS "PageView_createdAt_idx" ON "PageView" ("createdAt")`);

// Configuración CORS
const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

    // Rutas excluidas del rate limit (WebSocket y assets estáticos)
    if (path !== "/ws" && !path.startsWith("/uploads/")) {
      if (!checkRateLimit(req)) {
        return new Response(
          JSON.stringify({ error: "Demasiadas solicitudes. Intentá en un momento." }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" },
          },
        );
      }
    }

    // Health check
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // WebSocket upgrade — /ws?conversationId=xxx&token=yyy&senderType=client|professional
    if (path === "/ws") {
      const conversationId = url.searchParams.get("conversationId");
      const token = url.searchParams.get("token");
      const senderType = url.searchParams.get("senderType") as "client" | "professional" | null;

      if (!conversationId || !token || !senderType) {
        return new Response(JSON.stringify({ error: "Faltan parámetros" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { Professional: true },
      });

      if (!conversation) {
        return new Response(JSON.stringify({ error: "Conversación no encontrada" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Validar que el token pertenece a esta conversación
      let isClient = false;
      let isProfessional = false;

      // Para ambos tipos: intentar verificar como JWT de Clerk primero
      try {
        const fakeReq = new Request("http://x", { headers: { Authorization: `Bearer ${token}` } });
        const clerkUserId = await verifyClerkToken(fakeReq);
        if (clerkUserId) {
          if (senderType === "professional") {
            isProfessional = clerkUserId === conversation.Professional.clerkUserId;
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
        return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const upgraded = server.upgrade(req, {
        data: { conversationId, senderType, token },
      });

      if (upgraded) return undefined as any;
      return new Response(JSON.stringify({ error: "WebSocket upgrade fallido" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
          return new Response(JSON.stringify({ error: "Demasiadas solicitudes. Intentá en un momento." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" } });
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
            await Bun.write(filePath, photo);
            photoPaths.push(`/uploads/${filename}`);
          }
        } else {
          // Manejar JSON (sin imagen o con base64 - retrocompatibilidad)
          const contentLength = parseInt(req.headers.get("content-length") || "0");
          if (contentLength > 10 * 1024 * 1024) {
            return new Response(JSON.stringify({ error: "Payload demasiado grande" }), { status: 413, headers: corsHeaders });
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
        const { endpoint, keys } = body;

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
        const clerkUserId = await verifyClerkToken(req);

        await db.query(
          `INSERT INTO "PushSubscription" (id, endpoint, p256dh, auth, "clerkUserId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (endpoint) DO UPDATE SET
           p256dh = $2, auth = $3, "clerkUserId" = $4, "updatedAt" = NOW()`,
          [endpoint, keys.p256dh, keys.auth, clerkUserId],
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

        let query = 'SELECT * FROM "Doctor" WHERE activo = true';
        const params: any[] = [];
        let paramCount = 1;

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

        query += ' ORDER BY nombre ASC';

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
              [doctor.id]
            );
            return { ...doctor, confirmaciones: confResult.rows };
          })
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
          [id]
        );

        if (doctorResult.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Médico no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        const confResult = await db.query(
          `SELECT * FROM "Confirmacion"
           WHERE "doctorId" = $1
           ORDER BY "createdAt" DESC`,
          [id]
        );

        const doctor = { ...doctorResult.rows[0], confirmaciones: confResult.rows };

        return new Response(JSON.stringify(doctor), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/doctors - Crear doctor
      if (path === "/api/doctors" && method === "POST") {
        const body = await req.json();
        const { nombre, especialidad, direccion, barrio, ciudad, telefono, whatsapp, lat, lng, obrasSociales } = body;

        if (!nombre || !especialidad || !direccion || lat === undefined || lng === undefined) {
          return new Response(
            JSON.stringify({ error: "Faltan campos requeridos: nombre, especialidad, direccion, lat, lng" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
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
          ]
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

        if (body.nombre !== undefined) { updates.push(`nombre = $${paramCount++}`); params.push(body.nombre); }
        if (body.especialidad !== undefined) { updates.push(`especialidad = $${paramCount++}`); params.push(body.especialidad); }
        if (body.direccion !== undefined) { updates.push(`direccion = $${paramCount++}`); params.push(body.direccion); }
        if (body.barrio !== undefined) { updates.push(`barrio = $${paramCount++}`); params.push(body.barrio); }
        if (body.ciudad !== undefined) { updates.push(`ciudad = $${paramCount++}`); params.push(body.ciudad); }
        if (body.telefono !== undefined) { updates.push(`telefono = $${paramCount++}`); params.push(body.telefono); }
        if (body.whatsapp !== undefined) { updates.push(`whatsapp = $${paramCount++}`); params.push(body.whatsapp); }
        if (body.lat !== undefined) { updates.push(`lat = $${paramCount++}`); params.push(body.lat); }
        if (body.lng !== undefined) { updates.push(`lng = $${paramCount++}`); params.push(body.lng); }
        if (body.obrasSociales !== undefined) { updates.push(`"obrasSociales" = $${paramCount++}`); params.push(body.obrasSociales); }
        if (body.activo !== undefined) { updates.push(`activo = $${paramCount++}`); params.push(body.activo); }

        updates.push(`"updatedAt" = $${paramCount++}`);
        params.push(new Date());
        params.push(id);

        const result = await db.query(
          `UPDATE "Doctor" SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
          params
        );

        if (result.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Médico no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
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
          [id]
        );

        if (result.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Médico no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        return new Response(JSON.stringify({ message: "Médico eliminado" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/doctors/:id/confirmaciones - Agregar confirmación
      if (path.match(/^\/api\/doctors\/[^/]+\/confirmaciones$/) && method === "POST") {
        const id = path.split("/")[3];
        const body = await req.json();
        const { obraSocial, acepta } = body;

        if (!obraSocial || acepta === undefined) {
          return new Response(
            JSON.stringify({ error: "Faltan campos: obraSocial, acepta" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        // Verificar que el doctor existe
        const doctorCheck = await db.query('SELECT id FROM "Doctor" WHERE id = $1', [id]);
        if (doctorCheck.rows.length === 0) {
          return new Response(
            JSON.stringify({ error: "Médico no encontrado" }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        const confId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        await db.query(
          `INSERT INTO "Confirmacion" (id, "doctorId", "obraSocial", acepta, "createdAt")
           VALUES ($1, $2, $3, $4, NOW())`,
          [confId, id, obraSocial, acepta]
        );

        // Recalcular obrasSociales basándose en últimas 5 confirmaciones por obra social
        const nuevasObrasSociales: string[] = [];
        for (const os of OBRAS_SOCIALES) {
          const ultimas5 = await db.query(
            `SELECT acepta FROM "Confirmacion"
             WHERE "doctorId" = $1 AND "obraSocial" = $2
             ORDER BY "createdAt" DESC
             LIMIT 5`,
            [id, os]
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
          [nuevasObrasSociales, id]
        );

        return new Response(JSON.stringify(updatedDoctor.rows[0]), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/doctors/:id/disponibilidad - Disponibilidades vigentes
      if (path.match(/^\/api\/doctors\/[^/]+\/disponibilidad$/) && method === "GET") {
        const id = path.split("/")[3];
        const result = await db.query(
          `SELECT * FROM "TurnoDisponibilidad"
           WHERE "doctorId" = $1 AND "expiresAt" > NOW()
           ORDER BY "createdAt" DESC
           LIMIT 5`,
          [id]
        );
        return new Response(JSON.stringify(result.rows), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/doctors/:id/disponibilidad - Reportar disponibilidad
      if (path.match(/^\/api\/doctors\/[^/]+\/disponibilidad$/) && method === "POST") {
        const id = path.split("/")[3];
        const body = await req.json();
        const { dias, horario, tipoTurno, obraSocial, nota } = body;

        if (!dias?.length || !horario || !tipoTurno) {
          return new Response(JSON.stringify({ error: "Faltan campos requeridos" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const newId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días

        const result = await db.query(
          `INSERT INTO "TurnoDisponibilidad" (id, "doctorId", dias, horario, "tipoTurno", "obraSocial", nota, "expiresAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [newId, id, dias, horario, tipoTurno, obraSocial || "Todas", nota || null, expiresAt]
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
        const result = await db.query('SELECT * FROM "Farmacia" WHERE activo = true ORDER BY nombre');
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
              "Referer": "https://regionnet.com.ar/servicios/farmacias/",
              "X-Requested-With": "XMLHttpRequest",
            },
          }).then(r => r.json());

          // Eventos activos ahora: categoría reconquista + clase eo-event-running
          const nombresDeturno = events
            .filter((e: any) =>
              Array.isArray(e.className) &&
              e.className.includes("eo-event-running") &&
              e.className.some((c: string) => c.includes("reconquista"))
            )
            .map((e: any) => (e.title as string).trim().toUpperCase());

          // Cruzar con farmacias en BD
          const farmaciasResult = await db.query('SELECT * FROM "Farmacia" WHERE activo = true');
          const todas = farmaciasResult.rows;

          const deturno = nombresDeturno.length > 0
            ? todas.filter(f =>
                nombresDeturno.some(n =>
                  f.nombre.toUpperCase().includes(n) || n.includes(f.nombre.toUpperCase())
                )
              )
            : [];

          const data = { fecha: dateStr, farmacias: deturno, raw: nombresDeturno };
          turnoCache = { timestamp: now, data };

          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ fecha: "", farmacias: [], raw: [], error: "No se pudo obtener el turno" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // PUT /api/farmacias/:id - Actualizar farmacia (coords, dirección, etc.)
      const farmaciaUpdateMatch = path.match(/^\/api\/farmacias\/([^/]+)$/);
      if (farmaciaUpdateMatch && method === "PUT") {
        const id = farmaciaUpdateMatch[1];
        const body = await req.json() as { lat?: number; lng?: number; direccion?: string; nombre?: string; telefono?: string };
        const fields: string[] = [];
        const values: any[] = [];
        let idx = 1;
        if (body.lat !== undefined)      { fields.push(`lat = $${idx++}`);       values.push(body.lat); }
        if (body.lng !== undefined)      { fields.push(`lng = $${idx++}`);       values.push(body.lng); }
        if (body.direccion !== undefined){ fields.push(`direccion = $${idx++}`); values.push(body.direccion); }
        if (body.nombre !== undefined)   { fields.push(`nombre = $${idx++}`);    values.push(body.nombre); }
        if (body.telefono !== undefined) { fields.push(`telefono = $${idx++}`);  values.push(body.telefono); }
        if (!fields.length) {
          return new Response(JSON.stringify({ error: "Sin campos a actualizar" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        values.push(id);
        const result = await db.query(
          `UPDATE "Farmacia" SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
          values
        );
        if (!result.rows.length) {
          return new Response(JSON.stringify({ error: "Farmacia no encontrada" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(result.rows[0]), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── FIN FARMACIAS ────────────────────────────────────────────────────

      // ─── VOZ ──────────────────────────────────────────────────────────────

      // Calles conocidas de Reconquista para corrección fuzzy post-transcripción
      const CALLES_RECONQUISTA = [
        "Habegger","Iriondo","Pellegrini","Rivadavia","Avellaneda","Belgrano",
        "San Martín","Mitre","Roca","Colón","Sarmiento","Tucumán","Córdoba",
        "Mendoza","Entre Ríos","Corrientes","La Rioja","San Juan","Moreno",
        "Iturraspe","Ituzaingó","Almafuerte","Chacabuco","Freyre","Ludueña",
        "Bolívar","Alvear","Independencia","Amenabar","Patricio Diez",
        "Bulevar Lovato","Bulevar Constituyentes","25 de Mayo","9 de Julio",
        "Ruta Nacional 11","Fuerza Aérea","Ledesma","Cernadas","Obligado",
        "Calle 41","Calle 43","Calle 44","Calle 45","Calle 46","Calle 47",
        "Calle 48","Calle 50","Calle 52","Calle 54","Calle 56","Calle 58",
        "Calle 60","Calle 62",
      ];

      // Levenshtein distance
      const levenshtein = (a: string, b: string): number => {
        const m = a.length, n = b.length;
        const dp: number[][] = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++)
          for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        return dp[m][n];
      };

      // Palabras clave de problemas para corrección fonética
      const PROBLEM_CORRECTIONS: Record<string, string> = {
        "vache": "bache", "bache": "bache", "pache": "bache", "mache": "bache",
        "vacha": "bache", "baches": "baches", "vaches": "baches",
        "alumbrao": "alumbrado", "alumbramiento": "alumbrado",
        "basura": "basura", "vasura": "basura",
        "pastizal": "pastizal", "pasto": "pastizal", "yuyos": "pastizal",
        "semaforo": "semáforo", "señaforo": "semáforo",
        "graffiti": "graffiti", "grafiti": "graffiti", "pintada": "graffiti",
        "escombro": "escombro", "cascote": "escombro",
      };

      // Corregir palabras del transcript — calles conocidas + problemas comunes
      const correctStreetNames = (text: string): string => {
        const words = text.split(/\b/);
        return words.map(word => {
          if (word.length < 4) return word;
          const wordLower = word.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

          // Corrección de problemas comunes primero
          if (PROBLEM_CORRECTIONS[wordLower]) return PROBLEM_CORRECTIONS[wordLower];

          // Corrección de calles por Levenshtein
          let bestMatch = "";
          let bestDist = Infinity;
          for (const calle of CALLES_RECONQUISTA) {
            if (calle.includes(" ")) continue;
            const calleLower = calle.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            if (Math.abs(wordLower.length - calleLower.length) > 4) continue;
            const dist = levenshtein(wordLower, calleLower);
            const threshold = Math.max(2, Math.floor(calleLower.length * 0.3));
            if (dist < bestDist && dist <= threshold) {
              bestDist = dist;
              bestMatch = calle;
            }
          }
          return bestMatch || word;
        }).join("");
      };

      // POST /api/voice/simple - Reporte por voz sin IA (Web Speech API)
      if (path === "/api/voice/simple" && method === "POST") {
        const body = await req.json();
        const { description, lat, lng } = body;
        if (!description || !lat || !lng) {
          return new Response(JSON.stringify({ error: "Faltan campos: description, lat, lng" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();
        const result = await db.query(
          `INSERT INTO "Report" (id, lat, lng, category, description, barrio, direccion, photo, photos, "isUrgent", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [id, lat, lng, "voz", description.slice(0, 500), "Sin especificar", "Sin especificar", null, [], false, now, now],
        );
        const newReport = result.rows[0];
        try {
          const subscriptions = await db.query('SELECT endpoint, p256dh, auth FROM "PushSubscription"');
          for (const sub of subscriptions.rows) {
            await webPush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ title: "Nuevo reporte por voz", body: description.slice(0, 80), url: "/" })).catch(() => {});
          }
        } catch {}
        return new Response(JSON.stringify({ report: newReport }), {
          status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
            return new Response(JSON.stringify({ error: "Faltan campos: audio, lat, lng" }), {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          // Paso 1: Groq Whisper — transcripción
          const whisperForm = new FormData();
          whisperForm.append("file", new Blob([await audioFile.arrayBuffer()], { type: "audio/webm" }), "audio.webm");
          whisperForm.append("model", "whisper-large-v3");
          whisperForm.append("language", "es");
          whisperForm.append("prompt", "Reporte ciudadano en Reconquista, Santa Fe, Argentina. Calles: Habegger, Iturraspe, Ituzaingó, Almafuerte, Ludueña, Amenabar, Bulevar Lovato, Patricio Diez, Ruta Nacional 11, Avellaneda, Pellegrini, Rivadavia, Iriondo.");

          const whisperRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
            body: whisperForm,
          });

          if (!whisperRes.ok) {
            const err = await whisperRes.text();
            console.error("Whisper error:", err);
            return new Response(JSON.stringify({ error: "Error al transcribir el audio. Intentá de nuevo." }), {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
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

          const llmRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "llama-3.3-70b-versatile",
              messages: [{ role: "user", content: nlpPrompt }],
              temperature: 0.1,
              max_tokens: 200,
            }),
          });

          if (!llmRes.ok) {
            const err = await llmRes.text();
            console.error("LLM error:", err);
            return new Response(JSON.stringify({ error: "No se pudo interpretar el audio. Intentá de nuevo." }), {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
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
            return new Response(JSON.stringify({ error: "No se pudo interpretar el audio. Intentá de nuevo." }), {
              status: 422,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          const CATEGORIAS = ["basura","alumbrado","baches","pastizales","robo","personas_sospechosas","fugas_agua","drenaje","banquetas","semaforos","limpieza","graffiti","escombros","arboles","vandalismo","vehiculos_abandonados","iluminacion","animales_callejeros","plagas","senalizacion","estacionamiento","transporte"];
          transcript = extracted.descripcion || "";
          const categoria = CATEGORIAS.includes(extracted.categoria) ? extracted.categoria : "basura";
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
              const parts = direccion.split(sepRegex).map((s: string) => s.trim()).filter(Boolean);
              const isIntersection = parts.length >= 2;
              const normalize = (s: string) => s
                .replace(/[áàä]/gi,"a").replace(/[éèë]/gi,"e").replace(/[íìï]/gi,"i")
                .replace(/[óòö]/gi,"o").replace(/[úùü]/gi,"u");

              // Extraer palabra clave para búsqueda en Overpass (último token significativo)
              const SKIP_WORDS = new Set(["calle","avenida","av","bulevar","blvd","ruta","nacional","de","del","la","los","las","el"]);
              const overpassKeyword = (s: string): string => {
                // Aliases conocidos
                const aliases: Record<string, string> = {
                  "yrigoyen": "irigoyen", "hipolito irigoyen": "irigoyen",
                  "hipolito yrigoyen": "irigoyen", "ruta 11": "irigoyen",
                  "ruta nacional 11": "irigoyen", "san martin": "martin",
                  "25 de mayo": "mayo", "9 de julio": "julio",
                  "bulevar lovato": "lovato", "patricio diez": "diez",
                };
                const norm = normalize(s.toLowerCase());
                if (aliases[norm]) return aliases[norm];
                // Último token no trivial
                const tokens = norm.split(/\s+/).filter(t => t.length > 2 && !SKIP_WORDS.has(t));
                return tokens[tokens.length - 1] || norm;
              };

              const doGeocode = async (q: string) => {
                const encoded = encodeURIComponent(`${q}, Reconquista, Santa Fe, Argentina`);
                const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=ar&viewbox=${bbox}&bounded=1`, { headers: { "User-Agent": "warning-app/1.0" } });
                const data = await res.json();
                return data.length > 0 ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
              };
              const findIntersection = async (s1: string, s2: string) => {
                const k1 = overpassKeyword(s1);
                const k2 = overpassKeyword(s2);
                console.log(`Overpass intersection: "${k1}" ∩ "${k2}"`);
                const query = `[out:json][timeout:15];way["highway"]["name"~"${k1}",i](-29.30,-59.85,-28.95,-59.45)->.a;way["highway"]["name"~"${k2}",i](-29.30,-59.85,-28.95,-59.45)->.b;node(w.a)(w.b);out 1;`;
                const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: `data=${encodeURIComponent(query)}`, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
                const data = await res.json();
                return data.elements?.length > 0 ? { lat: data.elements[0].lat, lng: data.elements[0].lon } : null;
              };
              let found = null;
              if (isIntersection) {
                found = await findIntersection(parts[0], parts[1]);
                if (!found) found = await doGeocode(parts[0]);
              } else {
                found = await doGeocode(direccion);
                if (!found) found = await doGeocode(parts[0]);
              }
              if (found) { reportLat = found.lat; reportLng = found.lng; }
            } catch {}
          }

          const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const now = new Date();
          const result = await db.query(
            `INSERT INTO "Report" (id, lat, lng, category, description, barrio, direccion, photo, photos, "isUrgent", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [id, reportLat, reportLng, categoria, descripcion, barrio, direccion, null, [], false, now, now],
          );
          const newReport = result.rows[0];
          try {
            const subscriptions = await db.query('SELECT endpoint, p256dh, auth FROM "PushSubscription"');
            for (const sub of subscriptions.rows) {
              await webPush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ title: `Reporte por voz: ${categoria}`, body: descripcion, url: "/" })).catch(() => {});
            }
          } catch {}
          return new Response(JSON.stringify({ report: newReport, extracted }), {
            status: 201,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });

        } else {
          // Fallback JSON
          const body = await req.json();
          transcript = body.transcript;
          lat = body.lat;
          lng = body.lng;
        }

        if (!transcript || !lat || !lng) {
          return new Response(JSON.stringify({ error: "Faltan campos requeridos" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Fallback path (JSON): usar Groq NLP
        const CATEGORIAS = ["basura","alumbrado","baches","pastizales","robo","personas_sospechosas","fugas_agua","drenaje","banquetas","semaforos","limpieza","graffiti","escombros","arboles","vandalismo","vehiculos_abandonados","iluminacion","animales_callejeros","plagas","senalizacion","estacionamiento","transporte"];
        const prompt = `Extraé los campos del siguiente mensaje de voz en Reconquista, Santa Fe, Argentina y devolvé ÚNICAMENTE un JSON. Campos: categoria (una de: ${CATEGORIAS.join(",")}), descripcion, barrio (o "Sin especificar"), direccion (calle+número o intersección), enviar_servicios (true/false). Mensaje: "${transcript.replace(/"/g, "'")}"`;
        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({ model: "llama-3.1-8b-instant", messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 200 }),
        });
        if (!groqRes.ok) {
          return new Response(JSON.stringify({ error: "Error al procesar el mensaje de voz" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const groqData = await groqRes.json();
        let extracted: any;
        try {
          const raw = groqData.choices[0].message.content.trim();
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found");
          extracted = JSON.parse(jsonMatch[0]);
        } catch {
          return new Response(JSON.stringify({ error: "No se pudo interpretar el mensaje. Intentá de nuevo.", transcript }), {
            status: 422,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Validar categoría
        const categoria = CATEGORIAS.includes(extracted.categoria) ? extracted.categoria : "basura";
        const descripcion = (extracted.descripcion || transcript).slice(0, 500);
        const barrio = extracted.barrio || "Sin especificar";
        const direccion = extracted.direccion || "Sin especificar";

        // Geocodificar la dirección extraída para ubicar el pin correctamente
        let reportLat = lat;
        let reportLng = lng;
        if (direccion !== "Sin especificar") {
          try {
            const sepRegex = /\s+(?:y|e|-|\/|esq\.?|esquina|entre|casi)\s+/i;
            const parts = direccion.split(sepRegex).map((s: string) => s.trim()).filter(Boolean);
            const isIntersection = parts.length >= 2;

            // Normalizar nombre de calle para búsqueda (quitar tildes, lowercase parcial)
            const normalize = (s: string) => s.replace(/[áàä]/gi,"a").replace(/[éèë]/gi,"e").replace(/[íìï]/gi,"i").replace(/[óòö]/gi,"o").replace(/[úùü]/gi,"u");

            // Overpass API: busca el nodo exacto donde dos calles se cruzan (bbox de Reconquista)
            const findIntersection = async (street1: string, street2: string) => {
              const query = `[out:json][timeout:15];
way["highway"]["name"~"${normalize(street1)}",i](-29.30,-59.85,-28.95,-59.45)->.a;
way["highway"]["name"~"${normalize(street2)}",i](-29.30,-59.85,-28.95,-59.45)->.b;
node(w.a)(w.b);
out 1;`;
              const res = await fetch("https://overpass-api.de/api/interpreter", {
                method: "POST",
                body: `data=${encodeURIComponent(query)}`,
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
              });
              const data = await res.json();
              if (data.elements?.length > 0) {
                return { lat: data.elements[0].lat, lng: data.elements[0].lon };
              }
              return null;
            };

            // Nominatim para calle + número
            const geocodeAddress = async (q: string) => {
              const bbox = "-59.85,-29.30,-59.45,-28.95";
              const encoded = encodeURIComponent(`${q}, Reconquista, Santa Fe, Argentina`);
              const res = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=ar&viewbox=${bbox}&bounded=1`,
                { headers: { "User-Agent": "warning-app/1.0" } }
              );
              const data = await res.json();
              return data.length > 0 ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
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
          [id, reportLat, reportLng, categoria, descripcion, barrio, direccion, null, [], false, now, now],
        );

        const newReport = result.rows[0];

        // Notificaciones push
        try {
          const subscriptions = await db.query('SELECT endpoint, p256dh, auth FROM "PushSubscription"');
          for (const sub of subscriptions.rows) {
            await webPush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              JSON.stringify({ title: `Reporte por voz: ${categoria}`, body: descripcion, url: "/" }),
            ).catch(() => {});
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
          return new Response(JSON.stringify({ error: "El campo name es requerido" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const result = await db.query(
          `INSERT INTO "Supermarket" (id, name, address, lat, lng, logo)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [id, name, address || "", lat ?? -29.15, lng ?? -59.65, logo || null]
        );

        return new Response(JSON.stringify(result.rows[0]), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/supermarkets/:id/offers - Ofertas vigentes de un supermercado
      if (path.match(/^\/api\/supermarkets\/[^/]+\/offers$/) && method === "GET") {
        const supermarketId = path.split("/")[3];
        const result = await db.query(
          `SELECT * FROM "Offer"
           WHERE "supermarketId" = $1 AND ("validUntil" IS NULL OR "validUntil" >= CURRENT_DATE)
           ORDER BY "createdAt" DESC`,
          [supermarketId]
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
          return new Response(JSON.stringify({ error: "supermarketId y description son requeridos" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const result = await db.query(
          `INSERT INTO "Offer" (id, "supermarketId", description, price, photo, "validUntil")
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [id, supermarketId, description, price, photoPath, validUntil || null]
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
        let description: string, price: string | null, validUntil: string | null, photoPath: string | null | undefined;

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
            await Bun.write(`${uploadsDir}/${filename}`, photoFile);
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
        if (description) { updates.push(`description = $${i++}`); values.push(description); }
        if (price !== undefined) { updates.push(`price = $${i++}`); values.push(price); }
        if (validUntil !== undefined) { updates.push(`"validUntil" = $${i++}`); values.push(validUntil); }
        if (photoPath !== undefined) { updates.push(`photo = $${i++}`); values.push(photoPath); }

        if (updates.length === 0) {
          return new Response(JSON.stringify({ error: "Nada que actualizar" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        values.push(id);
        const result = await db.query(
          `UPDATE "Offer" SET ${updates.join(", ")} WHERE id = $${i} RETURNING *`,
          values
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
          return new Response(JSON.stringify({ error: "sessionId y section requeridos" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO "PageView" (id, "sessionId", section) VALUES ($1, $2, $3)`,
          [id, sessionId, section]
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
          db.query(`SELECT COUNT(DISTINCT "sessionId") AS count FROM "PageView" WHERE "createdAt" >= CURRENT_DATE`),
          db.query(`SELECT COUNT(DISTINCT "sessionId") AS count FROM "PageView" WHERE "createdAt" >= NOW() - INTERVAL '7 days'`),
          db.query(`SELECT COUNT(DISTINCT "sessionId") AS count FROM "PageView" WHERE "createdAt" >= NOW() - INTERVAL '30 days'`),
          db.query(`SELECT COUNT(DISTINCT "sessionId") AS count FROM "PageView"`),
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
          db.query(`SELECT COUNT(*) AS count FROM "Professional" WHERE activo = true`),
          db.query(`SELECT COUNT(*) AS count FROM "User"`),
          db.query(`SELECT COUNT(*) AS count FROM "Conversation"`),
          db.query(`SELECT COUNT(*) AS count FROM "Conversation" WHERE status != 'completed'`),
          db.query(`SELECT COUNT(*) AS count FROM "PublicReview"`),
        ]);

        return new Response(JSON.stringify({
          uniqueVisitors: {
            today: Number(uniqueToday.rows[0]?.count ?? 0),
            week: Number(uniqueWeek.rows[0]?.count ?? 0),
            month: Number(uniqueMonth.rows[0]?.count ?? 0),
            total: Number(uniqueTotal.rows[0]?.count ?? 0),
          },
          topSections: topSections.rows.map(r => ({
            section: r.section,
            visits: Number(r.visits),
            uniqueVisitors: Number(r.uniqueVisitors),
          })),
          dailyVisits: dailyVisits.rows.map(r => ({
            date: r.date,
            visits: Number(r.visits),
            uniqueVisitors: Number(r.uniqueVisitors),
          })),
          totalReports: Number(totalReports.rows[0]?.count ?? 0),
          reportsByCategory: reportsByCategory.rows.map(r => ({ category: r.category, count: Number(r.count) })),
          topBarrios: topBarrios.rows.map(r => ({ barrio: r.barrio, count: Number(r.count) })),
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
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/admin/professionals — listar todos los profesionales (requiere auth)
      if (path === "/api/admin/professionals" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const admins = (process.env.ADMIN_CLERK_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!admins.includes(clerkUserId)) return new Response(JSON.stringify({ error: "Acceso denegado" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const professionals = await prisma.professional.findMany({
          orderBy: { createdAt: "desc" },
          select: { id: true, nombre: true, apellido: true, slug: true, oficios: true, barrio: true, activo: true, ratingAvg: true, ratingCount: true, createdAt: true },
        });
        return new Response(JSON.stringify(professionals), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // DELETE /api/admin/professionals/:id — eliminar profesional (requiere auth admin)
      if (path.match(/^\/api\/admin\/professionals\/[^/]+$/) && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const admins = (process.env.ADMIN_CLERK_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!admins.includes(clerkUserId)) return new Response(JSON.stringify({ error: "Acceso denegado" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const id = path.split("/")[4];
        await prisma.professional.delete({ where: { id } });
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // GET /api/admin/reports — listar todos los reportes (requiere auth admin)
      if (path === "/api/admin/reports" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const admins = (process.env.ADMIN_CLERK_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!admins.includes(clerkUserId)) return new Response(JSON.stringify({ error: "Acceso denegado" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const reports = await prisma.report.findMany({
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return new Response(JSON.stringify(reports), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // DELETE /api/admin/reports/:id — eliminar reporte (requiere auth admin)
      if (path.match(/^\/api\/admin\/reports\/[^/]+$/) && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const admins = (process.env.ADMIN_CLERK_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!admins.includes(clerkUserId)) return new Response(JSON.stringify({ error: "Acceso denegado" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const id = path.split("/")[4];
        await prisma.report.delete({ where: { id } });
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // GET /api/admin/reviews — listar todas las reseñas (requiere auth admin)
      if (path === "/api/admin/reviews" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const admins = (process.env.ADMIN_CLERK_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!admins.includes(clerkUserId)) return new Response(JSON.stringify({ error: "Acceso denegado" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const reviews = await prisma.publicReview.findMany({
          orderBy: { createdAt: "desc" },
          take: 100,
          include: { professional: { select: { nombre: true, apellido: true, slug: true } } },
        });
        return new Response(JSON.stringify(reviews), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // DELETE /api/admin/reviews/:id — eliminar reseña (requiere auth admin)
      if (path.match(/^\/api\/admin\/reviews\/[^/]+$/) && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const admins = (process.env.ADMIN_CLERK_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!admins.includes(clerkUserId)) return new Response(JSON.stringify({ error: "Acceso denegado" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const id = path.split("/")[4];
        await prisma.publicReview.delete({ where: { id } });
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // DELETE /api/supermarkets/:id - Eliminar supermercado y sus ofertas
      if (path.match(/^\/api\/supermarkets\/[^/]+$/) && method === "DELETE") {
        const id = path.split("/")[3];
        await db.query('DELETE FROM "Offer" WHERE "supermarketId" = $1', [id]);
        await db.query('DELETE FROM "Supermarket" WHERE id = $1', [id]);
        return new Response(JSON.stringify({ message: "Supermercado eliminado" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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
        const professionals = await prisma.professional.findMany({
          where: {
            activo: true,
            ...(oficio ? { oficios: { has: oficio } } : {}),
            ...(barrio ? { barrio } : {}),
          },
          select: {
            id: true, nombre: true, apellido: true, slug: true,
            oficios: true, barrio: true, foto: true,
            disponible: true, ratingAvg: true, ratingCount: true,
          },
          orderBy: { ratingAvg: "desc" },
        });
        return new Response(JSON.stringify(professionals), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/professionals/me — perfil propio (requiere auth)
      if (path === "/api/professionals/me" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const professional = await prisma.professional.findUnique({ where: { clerkUserId } });
        if (!professional) return new Response(JSON.stringify({ error: "Perfil no encontrado" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        return new Response(JSON.stringify(professional), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/professionals/:slug/reviews — opiniones públicas
      if (path.match(/^\/api\/professionals\/[^/]+\/reviews$/) && method === "GET") {
        const slug = path.split("/")[3];
        const pro = await prisma.professional.findUnique({ where: { slug } });
        if (!pro) return new Response(JSON.stringify({ error: "No encontrado" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const reviews = await prisma.publicReview.findMany({
          where: { professionalId: pro.id },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(reviews), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // POST /api/professionals/:slug/reviews — agregar opinión pública
      if (path.match(/^\/api\/professionals\/[^/]+\/reviews$/) && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(JSON.stringify({ error: "Demasiadas solicitudes. Intentá en un momento." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" } });
        }
        const slug = path.split("/")[3];
        const pro = await prisma.professional.findUnique({ where: { slug } });
        if (!pro) return new Response(JSON.stringify({ error: "No encontrado" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const contentLength = parseInt(req.headers.get("content-length") || "0");
        if (contentLength > 10 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: "Payload demasiado grande" }), { status: 413, headers: corsHeaders });
        }
        const body = await req.json();
        body.comment = sanitizeText(body.comment, 1000);
        body.reviewerName = sanitizeText(body.reviewerName, 60);
        const { score, comment, reviewerName } = body;
        if (!score || !comment || comment.trim().length < 10) {
          return new Response(JSON.stringify({ error: "Datos inválidos" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // Opcional: extraer clerkUserId si está logueado
        let clerkUserId: string | null = null;
        try { clerkUserId = await verifyClerkToken(req); } catch {}

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
          where: { professionalId: pro.id },
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
        return new Response(JSON.stringify(review), { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // GET /api/professionals/id/:id — perfil por ID
      if (path.match(/^\/api\/professionals\/id\/[^/]+$/) && method === "GET") {
        const id = path.split("/api/professionals/id/")[1];
        const pro = await prisma.professional.findUnique({ where: { id } });
        if (!pro) return new Response(JSON.stringify({ error: "No encontrado" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const { telefono, whatsapp, clerkUserId, ...publicData } = pro;
        return new Response(JSON.stringify(publicData), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // GET /api/professionals/:slug — perfil público
      if (path.startsWith("/api/professionals/") && method === "GET") {
        const slug = path.split("/api/professionals/")[1];
        const professional = await prisma.professional.findUnique({
          where: { slug },
          include: {
            Rating: {
              where: { scoreByClient: { not: null } },
              select: { scoreByClient: true, commentByClient: true, createdAt: true },
              orderBy: { createdAt: "desc" },
              take: 10,
            },
          },
        });
        if (!professional) return new Response(JSON.stringify({ error: "No encontrado" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const { telefono, whatsapp, clerkUserId, ...publicData } = professional;
        return new Response(JSON.stringify(publicData), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/professionals — crear perfil (requiere auth)
      if (path === "/api/professionals" && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(JSON.stringify({ error: "Demasiadas solicitudes. Intentá en un momento." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" } });
        }
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const existing = await prisma.professional.findUnique({ where: { clerkUserId } });
        if (existing) return new Response(JSON.stringify({ error: "Ya tenés un perfil creado" }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const contentLength = parseInt(req.headers.get("content-length") || "0");
        if (contentLength > 10 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: "Payload demasiado grande" }), { status: 413, headers: corsHeaders });
        }
        const body = await req.json();
        body.nombre = sanitizeText(body.nombre, 60);
        body.apellido = sanitizeText(body.apellido, 60);
        body.descripcion = sanitizeText(body.descripcion, 500);
        body.barrio = sanitizeText(body.barrio, 100);
        const { nombre, apellido, oficios, descripcion, barrio, telefono, whatsapp } = body;
        if (!nombre || !apellido || !oficios?.length || !barrio) {
          return new Response(JSON.stringify({ error: "Faltan campos obligatorios" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const slug = generateSlug(nombre, apellido, oficios);
        const professional = await prisma.professional.create({
          data: { clerkUserId, nombre, apellido, slug, oficios, descripcion, barrio, telefono, whatsapp, updatedAt: new Date() },
        });
        return new Response(JSON.stringify(professional), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // PUT /api/professionals/me — actualizar perfil propio (requiere auth)
      if (path === "/api/professionals/me" && method === "PUT") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const body = await req.json();
        const { nombre, apellido, oficios, descripcion, barrio, telefono, whatsapp, disponible, fotos, foto } = body;
        const professional = await prisma.professional.update({
          where: { clerkUserId },
          data: { nombre, apellido, oficios, descripcion, barrio, telefono, whatsapp, disponible, fotos, foto },
        });
        return new Response(JSON.stringify(professional), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/professionals/me/photo — subir foto de perfil profesional
      if (path === "/api/professionals/me/photo" && method === "POST") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const formData = await req.formData();
        const photoFile = formData.get("photo") as File | null;
        if (!photoFile || photoFile.size === 0) {
          return new Response(JSON.stringify({ error: "No se recibió ninguna imagen" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const ext = photoFile.name.split(".").pop() || "jpg";
        const filename = `professional_${crypto.randomUUID()}.${ext}`;
        const filePath = join(uploadsDir, filename);
        await Bun.write(filePath, photoFile);
        const fotoUrl = `/uploads/${filename}`;
        const professional = await prisma.professional.update({
          where: { clerkUserId },
          data: { foto: fotoUrl },
        });
        return new Response(JSON.stringify({ foto: professional.foto }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ═══════════════════════════════════════════════════════════════════
      // FAVORITOS
      // ═══════════════════════════════════════════════════════════════════

      // GET /api/favorites — favoritos del usuario logueado
      if (path === "/api/favorites" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        let user = await prisma.user.findUnique({ where: { clerkUserId } });
        if (!user) return new Response(JSON.stringify([]), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const favs = await prisma.userFavorite.findMany({
          where: { userId: user.id },
          include: { Professional: { select: { nombre: true, apellido: true, oficios: true, foto: true, slug: true, ratingAvg: true, ratingCount: true } } },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(favs), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // POST /api/favorites — agregar favorito
      if (path === "/api/favorites" && method === "POST") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const { professionalId } = await req.json();
        if (!professionalId) return new Response(JSON.stringify({ error: "Falta professionalId" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        let user = await prisma.user.findUnique({ where: { clerkUserId } });
        if (!user) {
          user = await prisma.user.create({ data: { clerkUserId, updatedAt: new Date() } });
        }
        const fav = await prisma.userFavorite.upsert({
          where: { userId_professionalId: { userId: user.id, professionalId } },
          create: { userId: user.id, professionalId },
          update: {},
        });
        return new Response(JSON.stringify(fav), { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // DELETE /api/favorites/:professionalId — quitar favorito
      if (path.startsWith("/api/favorites/") && method === "DELETE") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const professionalId = path.split("/api/favorites/")[1];
        const user = await prisma.user.findUnique({ where: { clerkUserId } });
        if (!user) return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        await prisma.userFavorite.deleteMany({ where: { userId: user.id, professionalId } });
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ═══════════════════════════════════════════════════════════════════
      // CONVERSACIONES
      // ═══════════════════════════════════════════════════════════════════

      // POST /api/conversations — cliente inicia contacto
      if (path === "/api/conversations" && method === "POST") {
        if (!checkStrictRateLimit(req)) {
          return new Response(JSON.stringify({ error: "Demasiadas solicitudes. Intentá en un momento." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" } });
        }
        const contentLength = parseInt(req.headers.get("content-length") || "0");
        if (contentLength > 10 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: "Payload demasiado grande" }), { status: 413, headers: corsHeaders });
        }
        const body = await req.json();
        body.firstMessage = sanitizeText(body.firstMessage, 500);
        const { professionalId, clientToken, firstMessage } = body;
        if (!professionalId || !clientToken || !firstMessage) {
          return new Response(JSON.stringify({ error: "Faltan campos obligatorios" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const conversation = await prisma.conversation.create({
          data: {
            professionalId,
            clientToken,
            updatedAt: new Date(),
            Message: { create: { senderType: "client", content: firstMessage } },
          },
          include: { Message: true },
        });

        // Enviar push notification al profesional
        try {
          const professional = await prisma.professional.findUnique({ where: { id: professionalId } });
          if (professional?.clerkUserId) {
            const subs = await prisma.pushSubscription.findMany({ where: { clerkUserId: professional.clerkUserId } });
            const preview = firstMessage.length > 60 ? firstMessage.slice(0, 60) + "…" : firstMessage;
            await Promise.allSettled(subs.map(sub =>
              webPush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                JSON.stringify({
                  title: "Nuevo contacto",
                  body: preview,
                  url: `/chat/${conversation.id}`,
                  icon: "/icon-192x192.png",
                })
              ).catch(async (err: any) => {
                if (err.statusCode === 410) await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } });
              })
            ));
          }
        } catch {}

        // Enviar email al profesional via Resend
        if (resend) {
          try {
            const professional = await prisma.professional.findUnique({ where: { id: professionalId } });
            if (professional?.clerkUserId) {
              const clerkUser = await clerk.users.getUser(professional.clerkUserId);
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
                        <p style="color: #e2e8f0; margin: 0; font-style: italic;">"${firstMessage.slice(0, 200)}${firstMessage.length > 200 ? '...' : ''}"</p>
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
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ count: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const professional = await prisma.professional.findUnique({ where: { clerkUserId } });
        if (!professional) return new Response(JSON.stringify({ count: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const count = await prisma.message.count({
          where: {
            read: false,
            senderType: "client",
            Conversation: { professionalId: professional.id },
          },
        });
        return new Response(JSON.stringify({ count }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // GET /api/conversations/professional — conversaciones del profesional (requiere auth)
      if (path === "/api/conversations/professional" && method === "GET") {
        const clerkUserId = await verifyClerkToken(req);
        if (!clerkUserId) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const professional = await prisma.professional.findUnique({ where: { clerkUserId } });
        if (!professional) return new Response(JSON.stringify({ error: "Perfil no encontrado" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const conversations = await prisma.conversation.findMany({
          where: { professionalId: professional.id },
          include: {
            Professional: { select: { nombre: true, apellido: true, slug: true, foto: true, oficios: true } },
            Message: { orderBy: { createdAt: "desc" }, take: 1 },
          },
          orderBy: { updatedAt: "desc" },
        });
        return new Response(JSON.stringify(conversations), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/conversations/client/:token — conversaciones del cliente anónimo
      if (path.startsWith("/api/conversations/client/") && method === "GET") {
        const clientToken = path.split("/api/conversations/client/")[1];
        const conversations = await prisma.conversation.findMany({
          where: { clientToken },
          include: {
            Professional: { select: { nombre: true, apellido: true, slug: true, foto: true, oficios: true } },
            Message: { orderBy: { createdAt: "desc" }, take: 1 },
          },
          orderBy: { updatedAt: "desc" },
        });
        return new Response(JSON.stringify(conversations), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // GET /api/conversations/:id — detalle con mensajes
      if (path.startsWith("/api/conversations/") && method === "GET") {
        const conversationId = path.split("/api/conversations/")[1];
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: {
            Professional: { select: { nombre: true, apellido: true, slug: true, foto: true, oficios: true, clerkUserId: true, whatsapp: true } },
            Message: { orderBy: { createdAt: "asc" } },
          },
        });
        if (!conversation) return new Response(JSON.stringify({ error: "No encontrada" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

        // Marcar mensajes del cliente como leídos si el que abre es el profesional
        const clerkUserId = await verifyClerkToken(req);
        if (clerkUserId && clerkUserId === conversation.Professional.clerkUserId) {
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
      if (path.match(/^\/api\/conversations\/[^/]+\/status$/) && method === "PUT") {
        const conversationId = path.split("/")[3];
        const body = await req.json();
        const { status, clientToken } = body;
        const clerkUserId = await verifyClerkToken(req);
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { professional: true },
        });
        if (!conversation) return new Response(JSON.stringify({ error: "No encontrada" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const isProfessional = clerkUserId && conversation.professional.clerkUserId === clerkUserId;
        const isClient = clientToken && conversation.clientToken === clientToken;
        if (!isProfessional && !isClient) {
          return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
        const { conversationId, clientToken, scoreByClient, commentByClient, scoreByPro, commentByPro } = body;
        if (!conversationId) return new Response(JSON.stringify({ error: "Falta conversationId" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { professional: true },
        });
        if (!conversation || conversation.status !== "completed") {
          return new Response(JSON.stringify({ error: "La conversación debe estar completada para calificar" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const clerkUserId = await verifyClerkToken(req);
        const isProfessional = clerkUserId && conversation.professional.clerkUserId === clerkUserId;
        const isClient = clientToken && conversation.clientToken === clientToken;
        if (!isProfessional && !isClient) {
          return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const existing = await prisma.rating.findUnique({ where: { conversationId } });
        let rating;
        if (existing) {
          rating = await prisma.rating.update({
            where: { conversationId },
            data: {
              ...(isClient && scoreByClient != null ? { scoreByClient, commentByClient } : {}),
              ...(isProfessional && scoreByPro != null ? { scoreByPro, commentByPro } : {}),
            },
          });
        } else {
          rating = await prisma.rating.create({
            data: {
              conversationId,
              professionalId: conversation.professionalId,
              clientToken: conversation.clientToken,
              ...(isClient && scoreByClient != null ? { scoreByClient, commentByClient } : {}),
              ...(isProfessional && scoreByPro != null ? { scoreByPro, commentByPro } : {}),
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
            id: true, titulo: true, descripcion: true, precio: true,
            categoria: true, barrio: true, fotos: true, createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        });
        return new Response(JSON.stringify(clasificados), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST /api/clasificados — crear aviso
      if (path === "/api/clasificados" && method === "POST") {
        const contentLength = parseInt(req.headers.get("content-length") || "0");
        if (contentLength > 10 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: "Payload demasiado grande" }), { status: 413, headers: corsHeaders });
        }
        const body = await req.json();
        body.titulo = sanitizeText(body.titulo, 100);
        body.descripcion = sanitizeText(body.descripcion, 1000);
        const { titulo, descripcion, precio, categoria, barrio, clientToken } = body;
        if (!titulo || !descripcion || !categoria || !barrio || !clientToken) {
          return new Response(JSON.stringify({ error: "Faltan campos obligatorios" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        const clasificado = await prisma.clasificado.create({
          data: { titulo, descripcion, precio, categoria, barrio, clientToken, expiresAt },
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
          return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const updated = await prisma.clasificado.update({ where: { id }, data });
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
          return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
      const { conversationId } = ws.data as { conversationId: string; senderType: string; token: string };
      ws.subscribe(`conversation:${conversationId}`);

      // Marcar mensajes del otro lado como leídos al abrir
      const { senderType } = ws.data as { senderType: string };
      const otherSender = senderType === "client" ? "professional" : "client";
      await prisma.message.updateMany({
        where: { conversationId, senderType: otherSender, read: false },
        data: { read: true },
      });
    },

    async message(ws, raw) {
      const { conversationId, senderType } = ws.data as { conversationId: string; senderType: string };

      let parsed: { content: string };
      try {
        parsed = JSON.parse(raw as string);
      } catch {
        ws.send(JSON.stringify({ error: "Mensaje inválido" }));
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
    },

    close(ws) {
      const { conversationId } = ws.data as { conversationId: string };
      ws.unsubscribe(`conversation:${conversationId}`);
    },
  },
});

console.log(`🚀 Servidor API corriendo en http://localhost:${server.port}`);
