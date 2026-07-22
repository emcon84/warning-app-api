/**
 * Extrae la dirección desde googleMapsUrl y geocodea con Nominatim.
 * Uso: bun run scripts/fix-geocoding-google.ts
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

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const BBOX = { minLat: -29.30, maxLat: -28.95, minLng: -59.85, maxLng: -59.45 };

function extractAddress(url: string): string | null {
  const match = url.match(/\/dir\/\/(.+?)\/data=/);
  if (!match) return null;

  let address = decodeURIComponent(match[1].replace(/\+/g, " "));

  // Remove pharmacy name: keep everything after the first comma
  const commaIdx = address.indexOf(", ");
  if (commaIdx > 0) {
    address = address.substring(commaIdx + 2);
  }

  return address.trim();
}

async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const q = encodeURIComponent(`${address}, Santa Fe, Argentina`);
    const viewbox = `${BBOX.minLng},${BBOX.minLat},${BBOX.maxLng},${BBOX.maxLat}`;
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=ar&viewbox=${viewbox}&bounded=1`;
    const res = await fetch(url, { headers: { "User-Agent": "WarningApp/1.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (lat < BBOX.minLat || lat > BBOX.maxLat || lng < BBOX.minLng || lng > BBOX.maxLng) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== Geocoding desde Google Maps URLs ===\n");

  const result = await db.query(
    'SELECT id, nombre, "googleMapsUrl" FROM "Farmacia" WHERE "googleMapsUrl" IS NOT NULL AND "googleMapsUrl" LIKE \'%maps/dir%\' ORDER BY nombre',
  );

  console.log(`Encontradas ${result.rows.length} farmacias\n`);

  let updated = 0;
  let failed = 0;

  for (const row of result.rows) {
    const address = extractAddress(row.googleMapsUrl);
    if (!address) {
      console.log(`\u2717 ${row.nombre}: no se pudo extraer dirección`);
      failed++;
      await sleep(1500);
      continue;
    }

    console.log(`\u2753 ${row.nombre}: "${address.substring(0, 80)}..."`);

    const coords = await geocode(address);

    if (coords) {
      await db.query('UPDATE "Farmacia" SET lat = $1, lng = $2 WHERE id = $3', [
        coords.lat,
        coords.lng,
        row.id,
      ]);
      console.log(`  \u2713 ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`);
      updated++;
    } else {
      console.log(`  \u2717 Sin resultados de Nominatim`);
      failed++;
    }

    await sleep(1500);
  }

  console.log(`\n=== Resumen ===`);
  console.log(`\u2713 Actualizadas: ${updated}`);
  console.log(`\u2717 Sin geocodificar: ${failed}`);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
