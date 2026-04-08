import { db } from "./lib/db";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import webPush from "web-push";
import { OBRAS_SOCIALES } from "./lib/constants";

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

      // POST /api/voice/report - Crear reporte desde voz
      if (path === "/api/voice/report" && method === "POST") {
        const contentType = req.headers.get("content-type") || "";
        let transcript: string;
        let lat: number;
        let lng: number;

        if (contentType.includes("multipart/form-data")) {
          // Audio desde MediaRecorder → transcribir con Groq Whisper
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

          // Enviar a Groq Whisper para transcripción
          const whisperForm = new FormData();
          whisperForm.append("file", audioFile, "audio.webm");
          whisperForm.append("model", "whisper-large-v3");
          whisperForm.append("language", "es");
          whisperForm.append("response_format", "text");

          const whisperRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
            body: whisperForm,
          });

          if (!whisperRes.ok) {
            const err = await whisperRes.text();
            console.error("Whisper error:", err);
            return new Response(JSON.stringify({ error: "Error al transcribir el audio" }), {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }

          transcript = (await whisperRes.text()).trim();
          console.log("Whisper transcript:", transcript);
        } else {
          // Fallback JSON (compatibilidad)
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

        const CATEGORIAS = [
          "basura", "alumbrado", "baches", "pastizales", "robo",
          "personas_sospechosas", "fugas_agua", "drenaje", "banquetas",
          "semaforos", "limpieza", "graffiti", "escombros", "arboles",
          "vandalismo", "vehiculos_abandonados", "iluminacion",
          "animales_callejeros", "plagas", "senalizacion",
          "estacionamiento", "transporte",
        ];

        const prompt = `Sos un extractor de datos para una app de reportes ciudadanos de Reconquista, Santa Fe, Argentina.
Extraé los campos del mensaje de voz y devolvé ÚNICAMENTE un JSON válido, sin texto adicional, sin markdown, sin explicaciones.

DEFINICIONES IMPORTANTES:
- "barrio": SOLO es el nombre de un barrio residencial (ej: "Centro", "Barrio Norte", "Barrio San Martín", "Barrio Pucará"). NUNCA es un nombre de calle ni un número. Si no se menciona un barrio, usá "Sin especificar".
- "direccion": es la CALLE completa con número o intersección (ej: "Iriondo 1200", "San Martín y Roca", "Ruta 11 esquina Rivadavia"). Siempre incluí el nombre de la calle. "al 800" significa número 800, escribilo como "NombreCalle 800".
- "descripcion": describe el problema en pocas palabras, tal como lo dijo el usuario.
- "categoria": el tipo de problema más cercano de la lista.
- "enviar_servicios": true si el usuario menciona avisar/mandar/enviar a servicios públicos, municipalidad, municipio, intendencia o similar. false en cualquier otro caso.

REGLAS ESPECIALES:
- "esquina", "y", "entre", "casi", "e" entre dos calles = intersección → va en "direccion"
- "al 500", "altura 500", "número 500" = número de calle → va junto al nombre de calle en "direccion"
- "ruta 11", "RN11", "ruta nacional 11" = escribila como "Ruta Nacional 11"
- Si mencionan un choque, accidente o situación de tráfico → categoria: "transporte"
- Si no hay barrio mencionado → barrio: "Sin especificar"

EJEMPLOS:
Mensaje: "hay un bache en calle Iriondo al 1200"
JSON: {"categoria":"baches","descripcion":"bache en calle Iriondo","barrio":"Sin especificar","direccion":"Iriondo 1200","enviar_servicios":false}

Mensaje: "hay un bache en Pellegrini al 500, avisá a servicios públicos"
JSON: {"categoria":"baches","descripcion":"bache en Pellegrini","barrio":"Sin especificar","direccion":"Pellegrini 500","enviar_servicios":true}

Mensaje: "basura sin recolectar en Mitre 300, mandá a la municipalidad"
JSON: {"categoria":"basura","descripcion":"basura sin recolectar","barrio":"Sin especificar","direccion":"Mitre 300","enviar_servicios":true}

Mensaje: "falta el alumbrado en Belgrano y Salta, avisar al municipio"
JSON: {"categoria":"alumbrado","descripcion":"falta alumbrado público","barrio":"Sin especificar","direccion":"Belgrano y Salta","enviar_servicios":true}

Mensaje: "choque en calle San Martín y Roca, andar con cuidado"
JSON: {"categoria":"transporte","descripcion":"accidente de tránsito, circular con precaución","barrio":"Sin especificar","direccion":"San Martín y Roca"}

Mensaje: "semáforo roto en ruta 11 en la esquina de Rivadavia"
JSON: {"categoria":"semaforos","descripcion":"semáforo roto","barrio":"Sin especificar","direccion":"Ruta Nacional 11 y Rivadavia","enviar_servicios":false}

Mensaje: "falta la luz en Belgrano 500, barrio centro"
JSON: {"categoria":"alumbrado","descripcion":"falta alumbrado público","barrio":"Centro","direccion":"Belgrano 500"}

Mensaje: "basura sin recolectar en San Martín y Rivadavia, barrio norte"
JSON: {"categoria":"basura","descripcion":"basura sin recolectar","barrio":"Barrio Norte","direccion":"San Martín y Rivadavia"}

Mensaje: "pastizales altísimos en Pellegrini al 800, barrio norte"
JSON: {"categoria":"pastizales","descripcion":"pastizales muy altos","barrio":"Barrio Norte","direccion":"Pellegrini 800"}

Mensaje: "se cayó un árbol en la vereda de Belgrano entre Salta y Córdoba"
JSON: {"categoria":"arboles","descripcion":"árbol caído en la vereda","barrio":"Sin especificar","direccion":"Belgrano entre Salta y Córdoba"}

Mensaje: "hay una pérdida de agua en Mitre casi Iriondo"
JSON: {"categoria":"fugas_agua","descripcion":"pérdida de agua en la vía pública","barrio":"Sin especificar","direccion":"Mitre casi Iriondo"}

Mensaje: "escombros tirados en la vereda de Roca al 400 barrio sur"
JSON: {"categoria":"escombros","descripcion":"escombros en la vereda","barrio":"Barrio Sur","direccion":"Roca 400"}

Mensaje: "no funciona el alumbrado en toda la cuadra de Salta entre Mitre y Pellegrini, barrio centro"
JSON: {"categoria":"alumbrado","descripcion":"alumbrado sin funcionar en toda la cuadra","barrio":"Centro","direccion":"Salta entre Mitre y Pellegrini"}

Mensaje: "hay un pozo enorme en la esquina de Iriondo y Tucumán"
JSON: {"categoria":"baches","descripcion":"pozo grande en la esquina","barrio":"Sin especificar","direccion":"Iriondo y Tucumán"}

Mensaje: "perros sueltos en Avellaneda al 300"
JSON: {"categoria":"animales_callejeros","descripcion":"perros sueltos en la vía pública","barrio":"Sin especificar","direccion":"Avellaneda 300"}

Categorías válidas: ${CATEGORIAS.join(", ")}

Mensaje de voz: "${transcript.replace(/"/g, "'")}"

Devolvé solo el JSON:`;

        // Llamar a Groq
        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            max_tokens: 200,
          }),
        });

        if (!groqRes.ok) {
          const errBody = await groqRes.text();
          console.error("Groq error:", errBody);
          return new Response(JSON.stringify({ error: "Error al procesar el mensaje de voz" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
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
