import { db } from "./lib/db";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import webPush from "web-push";

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
          body = await req.json();
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

        // Insertar o actualizar suscripción
        await db.query(
          `INSERT INTO "PushSubscription" (id, endpoint, p256dh, auth, "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
           ON CONFLICT (endpoint) DO UPDATE SET
           p256dh = $2, auth = $3, "updatedAt" = NOW()`,
          [endpoint, keys.p256dh, keys.auth],
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

      // Ruta no encontrada
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
});

console.log(`🚀 Servidor API corriendo en http://localhost:${server.port}`);
