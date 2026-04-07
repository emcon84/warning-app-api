/**
 * Re-geocodea farmacias que cayeron en el fallback (coordenadas cerca del centro).
 * Para intersecciones ("X y Y"), prueba múltiples formatos.
 * Uso: bun run api/scripts/fix-farmacia-coords.ts
 */
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
const FALLBACK_RADIUS = 0.015; // farmacias a menos de ~1.5km del centro son sospechosas si la dirección no es "centro"
const BBOX = { minLat: -29.30, maxLat: -28.95, minLng: -59.85, maxLng: -59.45 };

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function tryGeocode(query: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const q = encodeURIComponent(`${query}, Reconquista, Santa Fe, Argentina`);
    const viewbox = `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`;
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=ar&viewbox=${viewbox}&bounded=1`;
    const res = await fetch(url, { headers: { "User-Agent": "warning-app-fix/1.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (lat < BBOX.minLat || lat > BBOX.maxLat || lng < BBOX.minLng || lng > BBOX.maxLng) return null;
    return { lat, lng };
  } catch { return null; }
}

async function geocodeWithFallbacks(direccion: string): Promise<{ lat: number; lng: number; query: string } | null> {
  // Intento 1: tal cual
  let coords = await tryGeocode(direccion);
  if (coords) return { ...coords, query: direccion };
  await sleep(1200);

  // Si es intersección "X y Y", probar variantes
  const intersectionMatch = direccion.match(/^(.+?)\s+y\s+(.+)$/i);
  if (intersectionMatch) {
    const [, calle1, calle2] = intersectionMatch;

    // Intento 2: "calle1 & calle2"
    const q2 = `${calle1} & ${calle2}`;
    coords = await tryGeocode(q2);
    if (coords) return { ...coords, query: q2 };
    await sleep(1200);

    // Intento 3: solo la primera calle (para centrar en esa calle al menos)
    coords = await tryGeocode(calle1.trim());
    if (coords) return { ...coords, query: `${calle1} (parcial)` };
    await sleep(1200);
  }

  return null;
}

function isFallback(lat: number, lng: number): boolean {
  const dlat = Math.abs(lat - CENTER.lat);
  const dlng = Math.abs(lng - CENTER.lng);
  return dlat < FALLBACK_RADIUS && dlng < FALLBACK_RADIUS;
}

async function main() {
  console.log("=== Fix Farmacia Coords ===\n");

  const result = await db.query('SELECT * FROM "Farmacia" WHERE activo = true ORDER BY nombre');
  const farmacias = result.rows;

  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (const f of farmacias) {
    const needsFix = isFallback(f.lat, f.lng);

    if (!needsFix) {
      console.log(`✓ ${f.nombre} — OK (${Number(f.lat).toFixed(4)}, ${Number(f.lng).toFixed(4)})`);
      skipped++;
      continue;
    }

    console.log(`? ${f.nombre} — coordenadas fallback, re-geocodificando "${f.direccion}"...`);
    const coords = await geocodeWithFallbacks(f.direccion);

    if (coords) {
      await db.query(
        'UPDATE "Farmacia" SET lat = $1, lng = $2 WHERE id = $3',
        [coords.lat, coords.lng, f.id]
      );
      console.log(`  ✓ Actualizada → ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)} (query: "${coords.query}")`);
      updated++;
    } else {
      console.log(`  ✗ No se pudo geocodificar — queda en fallback`);
      failed++;
    }
  }

  console.log(`\n=== Resumen ===`);
  console.log(`✓ Actualizadas: ${updated}`);
  console.log(`✓ Ya correctas: ${skipped}`);
  console.log(`✗ Sin solución: ${failed}`);

  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
