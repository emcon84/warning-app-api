// Uso: bun run api/scripts/import-doctors-google.ts
// Requiere: GOOGLE_PLACES_API_KEY en api/.env

import { db } from "../lib/db";
import { ESPECIALIDADES, RECONQUISTA_CENTER } from "../lib/constants";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// Cargar .env
try {
  const envPath = join(import.meta.dir, "../.env");
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
  }
} catch (e) {
  console.error("Error cargando .env:", e);
}

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const PLACES_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json";
const DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json";

// Radio ~15km en grados (aprox)
const MAX_DISTANCE_KM = 15;

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPlaceDetails(placeId: string): Promise<{ phone?: string } | null> {
  try {
    const url = `${DETAILS_URL}?place_id=${placeId}&fields=formatted_phone_number&key=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "OK" && data.result) {
      return { phone: data.result.formatted_phone_number };
    }
    return null;
  } catch {
    return null;
  }
}

async function importEspecialidad(especialidad: string): Promise<{ imported: number; skipped: number; errors: number }> {
  const stats = { imported: 0, skipped: 0, errors: 0 };

  try {
    const query = encodeURIComponent(`${especialidad} Reconquista Santa Fe Argentina`);
    const url = `${PLACES_URL}?query=${query}&key=${API_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error(`  [${especialidad}] Error Places API: ${data.status}`);
      stats.errors++;
      return stats;
    }

    const results = data.results || [];
    console.log(`  [${especialidad}] ${results.length} resultados`);

    for (const place of results) {
      try {
        const lat: number = place.geometry?.location?.lat;
        const lng: number = place.geometry?.location?.lng;

        if (!lat || !lng) {
          stats.skipped++;
          continue;
        }

        // Verificar que esté dentro del radio
        const dist = distanceKm(RECONQUISTA_CENTER.lat, RECONQUISTA_CENTER.lng, lat, lng);
        if (dist > MAX_DISTANCE_KM) {
          console.log(`    Saltando ${place.name} (${dist.toFixed(1)}km fuera de rango)`);
          stats.skipped++;
          continue;
        }

        const nombre: string = place.name;
        const direccion: string = place.formatted_address || "";

        // Check si ya existe (por nombre similar)
        const existing = await db.query(
          'SELECT id FROM "Doctor" WHERE LOWER(nombre) = LOWER($1)',
          [nombre]
        );

        if (existing.rows.length > 0) {
          console.log(`    Ya existe: ${nombre}`);
          stats.skipped++;
          continue;
        }

        // Obtener detalles (teléfono)
        let telefono: string | null = null;
        if (place.place_id) {
          const details = await getPlaceDetails(place.place_id);
          telefono = details?.phone || null;
          await sleep(100); // evitar rate limit
        }

        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();

        await db.query(
          `INSERT INTO "Doctor" (id, nombre, especialidad, direccion, barrio, ciudad, telefono, whatsapp, lat, lng, "obrasSociales", activo, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, '', 'Reconquista', $5, NULL, $6, $7, '{}', true, $8, $9)`,
          [id, nombre, especialidad, direccion, telefono, lat, lng, now, now]
        );

        console.log(`    ✓ Importado: ${nombre}`);
        stats.imported++;
      } catch (err) {
        console.error(`    Error procesando ${place.name}:`, err);
        stats.errors++;
      }
    }
  } catch (err) {
    console.error(`  Error en especialidad ${especialidad}:`, err);
    stats.errors++;
  }

  return stats;
}

async function main() {
  if (!API_KEY) {
    console.error("ERROR: GOOGLE_PLACES_API_KEY no está configurada en api/.env");
    process.exit(1);
  }

  console.log("=== Importación de Médicos desde Google Places ===");
  console.log(`Centro: Reconquista (${RECONQUISTA_CENTER.lat}, ${RECONQUISTA_CENTER.lng})`);
  console.log(`Radio: ${MAX_DISTANCE_KM}km\n`);

  let totalImported = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const especialidad of ESPECIALIDADES) {
    console.log(`Buscando: ${especialidad}...`);
    const stats = await importEspecialidad(especialidad);
    totalImported += stats.imported;
    totalSkipped += stats.skipped;
    totalErrors += stats.errors;
    await sleep(200); // respetar rate limit entre especialidades
  }

  console.log("\n=== Resumen ===");
  console.log(`✓ Importados: ${totalImported}`);
  console.log(`⟳ Ya existían / fuera de rango: ${totalSkipped}`);
  console.log(`✗ Errores: ${totalErrors}`);

  await db.end();
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
