// Uso: bun run api/scripts/seed-doctors-doctoralia.ts
// Scrappea médicos de Doctoralia para Reconquista y los inserta en la BD

import { db } from "../lib/db";
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
          process.env[key.trim()] = valueParts.join("=").replace(/^["']|["']$/g, "").trim();
        }
      }
    });
  }
} catch (e) {
  console.error("Error cargando .env:", e);
}

// Mapping especialidad → slug de Doctoralia
const ESPECIALIDADES_MAP: Record<string, string> = {
  "Clínico":              "medico-clinico",
  "Cardiología":          "cardiologo",
  "Pediatría":            "pediatra",
  "Ginecología":          "ginecologo",
  "Traumatología":        "traumatologo",
  "Oftalmología":         "oftalmologo",
  "Dermatología":         "dermatologo",
  "Neurología":           "neurologo",
  "Psiquiatría":          "psiquiatra",
  "Odontología":          "odontologo",
  "Kinesiología":         "kinesiologo",
  "Endocrinología":       "endocrinologo",
  "Gastroenterología":    "gastroenterologo",
  "Urología":             "urologo",
  "Otorrinolaringología": "otorrinolaringologo",
  "Psicología":           "psicologo",
  "Nutrición":            "nutricionista",
  "Reumatología":         "reumatologo",
};

const RECONQUISTA_CENTER = { lat: -29.15, lng: -59.65 };
const BASE_URL = "https://www.doctoraliar.com";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DoctorData {
  nombre: string;
  especialidad: string;
  direccion: string;
}

// Extrae médicos del JSON-LD de una página
async function fetchDoctorsFromPage(slug: string, page: number): Promise<DoctorData[]> {
  const url = page === 1
    ? `${BASE_URL}/${slug}/reconquista`
    : `${BASE_URL}/${slug}/reconquista?page=${page}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();

    // Extraer JSON-LD
    const jsonLdMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    const doctors: DoctorData[] = [];

    for (const match of jsonLdMatches) {
      try {
        const data = JSON.parse(match[1]);
        if (data["@type"] === "ItemList" && Array.isArray(data.itemListElement)) {
          for (const item of data.itemListElement) {
            const physician = item.item;
            if (!physician || physician["@type"] !== "Physician") continue;

            const nombre = physician.name?.trim();
            if (!nombre) continue;

            const especialidades = Array.isArray(physician.medicalSpecialty)
              ? physician.medicalSpecialty
              : [physician.medicalSpecialty];
            const especialidad = especialidades[0]?.trim() || "Clínico";

            const addr = physician.address;
            const direccion = addr?.streetAddress?.trim() || "";

            doctors.push({ nombre, especialidad, direccion });
          }
        }
      } catch {
        // JSON-LD inválido, ignorar
      }
    }

    return doctors;
  } catch (err) {
    console.error(`  Error fetching ${url}:`, err);
    return [];
  }
}

// Obtiene todas las páginas de una especialidad
async function fetchAllDoctorsForEspecialidad(
  especialidad: string,
  slug: string
): Promise<DoctorData[]> {
  const allDoctors: DoctorData[] = [];
  let page = 1;

  while (true) {
    const doctors = await fetchDoctorsFromPage(slug, page);
    if (doctors.length === 0) break;

    allDoctors.push(...doctors);
    console.log(`    Página ${page}: ${doctors.length} médicos`);

    // Si trajo menos de 20, es la última página
    if (doctors.length < 20) break;

    page++;
    await sleep(1500); // respetar rate limit de Doctoralia
  }

  return allDoctors;
}

// Geocodifica una dirección con Nominatim (OpenStreetMap)
async function geocode(direccion: string): Promise<{ lat: number; lng: number } | null> {
  if (!direccion) return null;

  try {
    const query = encodeURIComponent(`${direccion}, Reconquista, Santa Fe, Argentina`);
    const url = `${NOMINATIM_URL}?q=${query}&format=json&limit=1&countrycodes=ar`;

    const res = await fetch(url, {
      headers: { "User-Agent": "warning-app-seed/1.0 (research)" },
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (data.length === 0) return null;

    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
    };
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== Seed: Médicos de Doctoralia → Reconquista ===\n");

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalGeocoded = 0;

  for (const [especialidad, slug] of Object.entries(ESPECIALIDADES_MAP)) {
    console.log(`\n[${especialidad}] → /${slug}/reconquista`);

    const doctors = await fetchAllDoctorsForEspecialidad(especialidad, slug);
    console.log(`  Total encontrados: ${doctors.length}`);

    if (doctors.length === 0) {
      await sleep(1000);
      continue;
    }

    for (const doc of doctors) {
      // Check duplicado por nombre
      const existing = await db.query(
        'SELECT id FROM "Doctor" WHERE LOWER(nombre) = LOWER($1)',
        [doc.nombre]
      );

      if (existing.rows.length > 0) {
        totalSkipped++;
        continue;
      }

      // Geocodificar dirección (1 req/seg — requisito de Nominatim)
      let lat = RECONQUISTA_CENTER.lat + (Math.random() - 0.5) * 0.02;
      let lng = RECONQUISTA_CENTER.lng + (Math.random() - 0.5) * 0.02;

      if (doc.direccion) {
        await sleep(1100); // Nominatim: max 1 req/seg
        const coords = await geocode(doc.direccion);
        if (coords) {
          lat = coords.lat;
          lng = coords.lng;
          totalGeocoded++;
        }
      }

      const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date();

      await db.query(
        `INSERT INTO "Doctor" (id, nombre, especialidad, direccion, barrio, ciudad, telefono, whatsapp, lat, lng, "obrasSociales", activo, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, '', 'Reconquista', NULL, NULL, $5, $6, '{}', true, $7, $8)`,
        [id, doc.nombre, doc.especialidad, doc.direccion, lat, lng, now, now]
      );

      console.log(`    ✓ ${doc.nombre} (${doc.especialidad})`);
      totalInserted++;
    }

    await sleep(2000); // pausa entre especialidades
  }

  console.log("\n=== Resumen ===");
  console.log(`✓ Insertados:   ${totalInserted}`);
  console.log(`⟳ Ya existían:  ${totalSkipped}`);
  console.log(`📍 Geocodificados: ${totalGeocoded}`);
  console.log(`📍 Con coords aprox: ${totalInserted - totalGeocoded}`);

  await db.end();
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
