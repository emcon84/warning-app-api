// Importa médicos desde OpenStreetMap (Overpass API) — 100% gratis, sin API key
// Uso: bun run api/scripts/import-doctors-osm.ts

import { db } from "../lib/db";
import { RECONQUISTA_CENTER } from "../lib/constants";

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

// Mapeo de tags OSM a especialidades del sistema
function detectarEspecialidad(tags: Record<string, string>): string {
  const specialty = (tags["healthcare:speciality"] || tags["speciality"] || "").toLowerCase();
  const name = (tags["name"] || "").toLowerCase();

  if (specialty.includes("cardio") || name.includes("cardio")) return "Cardiología";
  if (specialty.includes("pediatr") || name.includes("pediatr")) return "Pediatría";
  if (specialty.includes("gineco") || name.includes("gineco")) return "Ginecología";
  if (specialty.includes("traumato") || name.includes("traumato")) return "Traumatología";
  if (specialty.includes("oftalmo") || name.includes("oftalmo") || name.includes("oculist")) return "Oftalmología";
  if (specialty.includes("dermato") || name.includes("dermato")) return "Dermatología";
  if (specialty.includes("neurolo") || name.includes("neurolo")) return "Neurología";
  if (specialty.includes("psiquiat") || name.includes("psiquiat")) return "Psiquiatría";
  if (specialty.includes("odonto") || name.includes("odonto") || name.includes("dental") || name.includes("dentist")) return "Odontología";
  if (specialty.includes("kinesi") || name.includes("kinesi")) return "Kinesiología";
  if (specialty.includes("endocrino") || name.includes("endocrino")) return "Endocrinología";
  if (specialty.includes("gastro") || name.includes("gastro")) return "Gastroenterología";
  if (specialty.includes("urolo") || name.includes("urolo")) return "Urología";
  if (specialty.includes("psicolo") || name.includes("psicolo")) return "Psicología";
  if (specialty.includes("nutrici") || name.includes("nutrici")) return "Nutrición";
  if (specialty.includes("reumat") || name.includes("reumat")) return "Reumatología";
  if (tags["amenity"] === "hospital" || tags["amenity"] === "clinic") return "Clínico";

  return "Clínico";
}

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function fetchOsmDoctors(): Promise<OsmElement[]> {
  // Overpass QL: busca todos los elementos de salud en 15km alrededor de Reconquista
  const query = `
    [out:json][timeout:30];
    (
      node["amenity"="doctors"](around:15000,${RECONQUISTA_CENTER.lat},${RECONQUISTA_CENTER.lng});
      node["amenity"="clinic"](around:15000,${RECONQUISTA_CENTER.lat},${RECONQUISTA_CENTER.lng});
      node["amenity"="hospital"](around:15000,${RECONQUISTA_CENTER.lat},${RECONQUISTA_CENTER.lng});
      node["healthcare"](around:15000,${RECONQUISTA_CENTER.lat},${RECONQUISTA_CENTER.lng});
      way["amenity"="doctors"](around:15000,${RECONQUISTA_CENTER.lat},${RECONQUISTA_CENTER.lng});
      way["amenity"="clinic"](around:15000,${RECONQUISTA_CENTER.lat},${RECONQUISTA_CENTER.lng});
      way["healthcare"](around:15000,${RECONQUISTA_CENTER.lat},${RECONQUISTA_CENTER.lng});
    );
    out center tags;
  `;

  console.log("Consultando Overpass API (OpenStreetMap)...");
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) throw new Error(`Overpass API error: ${res.status}`);

  const data = await res.json();
  return data.elements || [];
}

async function main() {
  console.log("=== Importación de Médicos desde OpenStreetMap ===");
  console.log(`Centro: Reconquista (${RECONQUISTA_CENTER.lat}, ${RECONQUISTA_CENTER.lng})`);
  console.log(`Radio: ${MAX_DISTANCE_KM}km\n`);

  let elements: OsmElement[];
  try {
    elements = await fetchOsmDoctors();
  } catch (err) {
    console.error("Error consultando Overpass API:", err);
    process.exit(1);
  }

  console.log(`${elements.length} elementos encontrados en OSM\n`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const el of elements) {
    try {
      const tags = el.tags || {};
      const nombre = tags["name"] || tags["operator"] || null;

      if (!nombre) {
        skipped++;
        continue;
      }

      // Obtener lat/lng (nodes tienen lat/lon directo, ways tienen center)
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;

      if (!lat || !lon) {
        skipped++;
        continue;
      }

      // Verificar radio
      const dist = distanceKm(RECONQUISTA_CENTER.lat, RECONQUISTA_CENTER.lng, lat, lon);
      if (dist > MAX_DISTANCE_KM) {
        skipped++;
        continue;
      }

      // Verificar si ya existe
      const existing = await db.query(
        'SELECT id FROM "Doctor" WHERE LOWER(nombre) = LOWER($1)',
        [nombre]
      );
      if (existing.rows.length > 0) {
        console.log(`  Ya existe: ${nombre}`);
        skipped++;
        continue;
      }

      const especialidad = detectarEspecialidad(tags);
      const direccion = tags["addr:street"]
        ? `${tags["addr:street"]}${tags["addr:housenumber"] ? " " + tags["addr:housenumber"] : ""}`
        : "";
      const telefono = tags["phone"] || tags["contact:phone"] || null;
      const whatsapp = tags["contact:whatsapp"] || null;

      const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date();

      await db.query(
        `INSERT INTO "Doctor" (id, nombre, especialidad, direccion, barrio, ciudad, telefono, whatsapp, lat, lng, "obrasSociales", activo, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, '', 'Reconquista', $5, $6, $7, $8, '{}', true, $9, $10)`,
        [id, nombre, especialidad, direccion, telefono, whatsapp, lat, lon, now, now]
      );

      console.log(`  ✓ ${nombre} — ${especialidad}`);
      imported++;
    } catch (err) {
      console.error(`  Error procesando elemento ${el.id}:`, err);
      errors++;
    }
  }

  console.log("\n=== Resumen ===");
  console.log(`✓ Importados: ${imported}`);
  console.log(`⟳ Saltados (sin nombre, ya existían, fuera de rango): ${skipped}`);
  console.log(`✗ Errores: ${errors}`);

  if (imported === 0) {
    console.log("\n⚠ OpenStreetMap tiene pocos datos de médicos en Reconquista.");
    console.log("  Los usuarios pueden agregar médicos directamente desde el mapa.");
  }

  await db.end();
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
