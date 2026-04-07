// Uso: bun run api/scripts/fix-geocoding.ts
// Re-geocodifica médicos cuyas coordenadas están fuera de Reconquista o son sospechosas

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
} catch (e) {}

// Bounding box de Reconquista (±0.15 grados ≈ ~15km)
const CENTER = { lat: -29.15, lng: -59.65 };
const BBOX = {
  minLat: CENTER.lat - 0.15,
  maxLat: CENTER.lat + 0.15,
  minLng: CENTER.lng - 0.20,
  maxLng: CENTER.lng + 0.20,
};

function isInsideBbox(lat: number, lng: number): boolean {
  return lat >= BBOX.minLat && lat <= BBOX.maxLat &&
         lng >= BBOX.minLng && lng <= BBOX.maxLng;
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function geocode(direccion: string): Promise<{ lat: number; lng: number } | null> {
  if (!direccion?.trim()) return null;

  try {
    // Nominatim con viewbox y bounded para forzar Reconquista
    const query = encodeURIComponent(`${direccion}, Reconquista, Santa Fe, Argentina`);
    const viewbox = `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`;
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&countrycodes=ar&viewbox=${viewbox}&bounded=1`;

    const res = await fetch(url, {
      headers: { "User-Agent": "warning-app-geocode-fix/1.0" },
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (data.length === 0) return null;

    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);

    // Validar que esté dentro del bbox
    if (!isInsideBbox(lat, lng)) return null;

    return { lat, lng };
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== Fix Geocoding — Médicos fuera de Reconquista ===\n");

  // Traer todos los médicos
  const result = await db.query('SELECT id, nombre, direccion, lat, lng FROM "Doctor" ORDER BY nombre');
  const doctors = result.rows;

  console.log(`Total médicos: ${doctors.length}`);

  let outsideBbox = 0;
  let fixed = 0;
  let couldNotFix = 0;

  for (const doc of doctors) {
    const lat = parseFloat(doc.lat);
    const lng = parseFloat(doc.lng);
    const dist = distanceKm(CENTER.lat, CENTER.lng, lat, lng);

    if (isInsideBbox(lat, lng)) continue; // OK, dentro de Reconquista

    outsideBbox++;
    console.log(`\n⚠️  ${doc.nombre}`);
    console.log(`   Coords actuales: ${lat.toFixed(4)}, ${lng.toFixed(4)} (${dist.toFixed(1)}km del centro)`);
    console.log(`   Dirección: ${doc.direccion || "(sin dirección)"}`);

    if (!doc.direccion?.trim()) {
      // Sin dirección — mover al centro con pequeño random
      const newLat = CENTER.lat + (Math.random() - 0.5) * 0.02;
      const newLng = CENTER.lng + (Math.random() - 0.5) * 0.02;
      await db.query('UPDATE "Doctor" SET lat = $1, lng = $2 WHERE id = $3', [newLat, newLng, doc.id]);
      console.log(`   → Sin dirección, movido al centro aprox.`);
      couldNotFix++;
      continue;
    }

    await sleep(1100); // Nominatim: max 1 req/seg
    const coords = await geocode(doc.direccion);

    if (coords) {
      await db.query('UPDATE "Doctor" SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, doc.id]);
      console.log(`   ✓ Corregido → ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
      fixed++;
    } else {
      // No se pudo geocodificar — mover al centro con random
      const newLat = CENTER.lat + (Math.random() - 0.5) * 0.02;
      const newLng = CENTER.lng + (Math.random() - 0.5) * 0.02;
      await db.query('UPDATE "Doctor" SET lat = $1, lng = $2 WHERE id = $3', [newLat, newLng, doc.id]);
      console.log(`   ✗ No geocodificado, movido al centro aprox.`);
      couldNotFix++;
    }
  }

  console.log("\n=== Resumen ===");
  console.log(`Fuera de Reconquista: ${outsideBbox}`);
  console.log(`✓ Corregidos con geocoding: ${fixed}`);
  console.log(`~ Movidos al centro (sin fix exacto): ${couldNotFix}`);

  await db.end();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
