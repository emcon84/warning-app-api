// Uso: bun run api/scripts/seed-farmacias.ts
import { db } from "../lib/db";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

try {
  const envPath = join(import.meta.dir, "../.env");
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    envContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0)
          process.env[key.trim()] = valueParts.join("=").replace(/^["']|["']$/g, "").trim();
      }
    });
  }
} catch {}

const CENTER = { lat: -29.15, lng: -59.65 };
const BBOX = { minLat: -29.30, maxLat: -28.95, minLng: -59.85, maxLng: -59.45 };

const FARMACIAS = [
  { nombre: "ABRAHAN",            direccion: "Bulevar Perón 1896",          telefono: "(3482) 427072" },
  { nombre: "AGUSTINI",           direccion: "Hipólito Yrigoyen 476",       telefono: "(3482) 424903" },
  { nombre: "ALAL",               direccion: "Iturraspe 676",               telefono: "(3482) 421242" },
  { nombre: "ANALÍA S. MASAT",    direccion: "Pietropaolo 2085",            telefono: "(3482) 424230" },
  { nombre: "ARAMBURÚ",           direccion: "Hipólito Yrigoyen 1302",      telefono: "(3482) 429867" },
  { nombre: "ARAYA",              direccion: "Calle 47 1405",               telefono: "(3482) 428999" },
  { nombre: "BALLARIO",           direccion: "Patricio Díez 217",           telefono: "(3482) 428196" },
  { nombre: "BANDEO",             direccion: "Habegger 1260",               telefono: "(3482) 420410" },
  { nombre: "BARRIO CHAPERO",     direccion: "9 de Julio 1920",             telefono: "(3482) 425928" },
  { nombre: "BOURNISSENT",        direccion: "Alvear 1352",                 telefono: "(3482) 421381" },
  { nombre: "BUNCHICH",           direccion: "Bulevar Lobato 1131",         telefono: "(3482) 427911" },
  { nombre: "CASTILLO",           direccion: "General Manuel Belgrano 1406",telefono: "(3482) 437220" },
  { nombre: "CÉSPEDES",           direccion: "Bartolomé Mitre y San Martín",telefono: "(3482) 429464" },
  { nombre: "CIAN",               direccion: "San Martín y Jorge Newbery",  telefono: "(3482) 420016" },
  { nombre: "CORTI",              direccion: "Jorge Newbery y Olessio",     telefono: "(3482) 422074" },
  { nombre: "CUCIT",              direccion: "Calle 47 1784",               telefono: "(3482) 421416" },
  { nombre: "DEAN",               direccion: "Alvear 1896",                 telefono: "(3482) 422959" },
  { nombre: "DEGIUSTI",           direccion: "Gobernador Freyre y San Lorenzo", telefono: "(3482) 429956" },
  { nombre: "DULAC",              direccion: "Patricio Díez y Olessio",     telefono: "(3482) 429271" },
  { nombre: "FACCHINI",           direccion: "Lisandro de la Torre 1020",   telefono: "(3482) 425523" },
  { nombre: "GALENO",             direccion: "Olessio e Iriondo",           telefono: "(3482) 420697" },
  { nombre: "GASSMANN",           direccion: "Calle 47 976",                telefono: "(3482) 421143" },
  { nombre: "GÓMEZ INGARAMO",     direccion: "9 de Julio y Rivadavia",      telefono: "(3482) 421000" },
  { nombre: "LILIANA ARAMBURÚ",   direccion: "9 de Julio y Pueyrredón",     telefono: "(3482) 421480" },
  { nombre: "MENÉNDEZ",           direccion: "San Martín y Moreno",         telefono: "(3482) 424166" },
  { nombre: "MOSCHÉN",            direccion: "Moreno 776",                  telefono: "(3482) 437181" },
  { nombre: "MUTUAL JERÁRQUICOS", direccion: "Patricio Díez 1015",         telefono: "(3482) 422734" },
  { nombre: "PADUAN",             direccion: "Alvear y 9 de Julio",         telefono: "(3482) 422201" },
  { nombre: "PEIRONE",            direccion: "Roca 2740",                   telefono: "(3482) 421296" },
  { nombre: "SAN MARTÍN",         direccion: "San Martín 1034",             telefono: "(3482) 420931" },
  { nombre: "SARTOR",             direccion: "9 de Julio 1033",             telefono: "(3482) 421235" },
  { nombre: "SELLARÉS",           direccion: "Iriondo y General Manuel Obligado", telefono: "(3482) 421341" },
  { nombre: "SOLODKOW",           direccion: "General Manuel Belgrano 680", telefono: "(3482) 429484" },
  { nombre: "TISEYRA",            direccion: "Lucas Funes 977",             telefono: "(3482) 421896" },
  { nombre: "VERDERONE",          direccion: "Jorge Newbery y Calle 42",    telefono: "(3482) 437356" },
  { nombre: "VIANO",              direccion: "Ludueña 1077",                telefono: "(3482) 428846" },
  { nombre: "VICENTÍN",           direccion: "Hipólito Yrigoyen 1057",      telefono: "(3482) 420385" },
  { nombre: "VIZCAY",             direccion: "25 de Mayo 1088",             telefono: "(3482) 421405" },
];

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function geocode(direccion: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const query = encodeURIComponent(`${direccion}, Reconquista, Santa Fe, Argentina`);
    const viewbox = `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`;
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&countrycodes=ar&viewbox=${viewbox}&bounded=1`;
    const res = await fetch(url, { headers: { "User-Agent": "warning-app-seed/1.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (lat < BBOX.minLat || lat > BBOX.maxLat || lng < BBOX.minLng || lng > BBOX.maxLng) return null;
    return { lat, lng };
  } catch { return null; }
}

async function main() {
  console.log("=== Seed Farmacias Reconquista ===\n");

  // Limpiar existentes
  await db.query('DELETE FROM "Farmacia"');

  let geocoded = 0;
  let fallback = 0;

  for (const f of FARMACIAS) {
    await sleep(1100);
    const coords = await geocode(f.direccion);
    let lat: number, lng: number;

    if (coords) {
      lat = coords.lat; lng = coords.lng;
      geocoded++;
      console.log(`✓ ${f.nombre} → ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    } else {
      lat = CENTER.lat + (Math.random() - 0.5) * 0.02;
      lng = CENTER.lng + (Math.random() - 0.5) * 0.02;
      fallback++;
      console.log(`~ ${f.nombre} → centro aprox (no geocodificado)`);
    }

    await db.query(
      'INSERT INTO "Farmacia" (id, nombre, direccion, telefono, lat, lng, activo, "createdAt") VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true, NOW())',
      [f.nombre, f.direccion, f.telefono, lat, lng]
    );
  }

  console.log(`\n=== Resumen ===`);
  console.log(`✓ Geocodificadas: ${geocoded}`);
  console.log(`~ Fallback centro: ${fallback}`);
  console.log(`Total: ${FARMACIAS.length}`);

  await db.end();
}

main().catch(err => { console.error(err); process.exit(1); });
