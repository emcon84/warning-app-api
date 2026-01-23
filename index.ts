import { db } from "./lib/db";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

// Tipos
type ReportCategory = "basura" | "alumbrado" | "baches" | "pastizales" | "robo";

interface CreateReportBody {
  lat: number;
  lng: number;
  category: ReportCategory;
  description: string;
  barrio: string;
  direccion: string;
  photo?: string;
  fecha?: string;
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
        let photoPath: string | null = null;

        // Manejar FormData (con imagen)
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

          const photo = formData.get("photo") as File | null;

          if (photo && photo.size > 0) {
            // Generar nombre único para la imagen
            const ext = photo.name.split(".").pop() || "jpg";
            const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${ext}`;
            const filePath = join(uploadsDir, filename);

            // Guardar archivo
            await Bun.write(filePath, photo);
            photoPath = `/uploads/${filename}`;
          }
        } else {
          // Manejar JSON (sin imagen o con base64 - retrocompatibilidad)
          body = await req.json();
          photoPath = body.photo || null;
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
          `INSERT INTO "Report" (id, lat, lng, category, description, barrio, direccion, photo, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            id,
            body.lat,
            body.lng,
            body.category,
            body.description,
            body.barrio,
            body.direccion,
            photoPath,
            createdAt,
            createdAt,
          ],
        );

        return new Response(JSON.stringify(result.rows[0]), {
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
