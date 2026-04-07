/**
 * Sincroniza el padrón IAPOS de Reconquista con la BD local.
 *
 * Paso 1: Scrapea la página de IAPOS y guarda en tabla IaposProvider
 * Paso 2: Cruza con la tabla Doctor por apellido y marca iapos=true
 *
 * Uso: bun run api/scripts/sync-iapos.ts
 * Cron sugerido (mensual): 0 3 1 * * bun run /path/to/sync-iapos.ts
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

const IAPOS_URL = "https://www.santafe.gob.ar/iapos1/iapos2005/prestadores3-2005.php?localidad=RECONQUISTA&especialidad=0&Submit=++ir++";

// ─── Normalización ───────────────────────────────────────────────────────────

function normalizeStr(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // quitar acentos
    .replace(/[^A-Z\s]/g, " ")         // solo letras y espacios
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrae el primer token (apellido) de un nombre en formato "APELLIDO NOMBRE" */
function extractApellido(nombre: string): string {
  return normalizeStr(nombre).split(" ")[0];
}

// ─── Scraping ────────────────────────────────────────────────────────────────

interface IaposRow {
  nombre: string;
  direccion: string;
  telefono: string;
}

async function scrapeIapos(): Promise<IaposRow[]> {
  console.log("Fetching IAPOS...");
  const res = await fetch(IAPOS_URL, {
    headers: { "User-Agent": "warning-app-sync/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // La página está en iso-8859-1 — usamos TextDecoder
  const buffer = await res.arrayBuffer();
  const html = new TextDecoder("iso-8859-1").decode(buffer);

  // Extraer todas las celdas con clase Verdana10blak
  const cellRegex = /<td[^>]*class="Verdana10blak"[^>]*>([\s\S]*?)<\/td>/gi;
  const cells: string[] = [];
  let match;
  while ((match = cellRegex.exec(html)) !== null) {
    // Limpiar HTML interno y espacios
    const text = match[1]
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    cells.push(text);
  }

  // Cada registro son 5 celdas: nombre, domicilio, otra_especialidad, recertif, telefono
  const rows: IaposRow[] = [];
  for (let i = 0; i + 4 < cells.length; i += 5) {
    const nombre = cells[i].trim();
    const direccion = cells[i + 1].trim();
    const telefono = cells[i + 4].trim();
    if (nombre && nombre.length > 2) {
      rows.push({ nombre, direccion, telefono });
    }
  }

  console.log(`Encontrados ${rows.length} profesionales en IAPOS`);
  return rows;
}

// ─── Persistir en IaposProvider ──────────────────────────────────────────────

async function persistIapos(rows: IaposRow[]) {
  console.log("Limpiando tabla IaposProvider...");
  await db.query('DELETE FROM "IaposProvider"');

  console.log("Insertando registros...");
  let inserted = 0;
  for (const row of rows) {
    await db.query(
      'INSERT INTO "IaposProvider" (id, nombre, direccion, telefono, "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, NOW())',
      [row.nombre, row.direccion, row.telefono]
    );
    inserted++;
  }
  console.log(`✓ ${inserted} registros insertados en IaposProvider`);
}

// ─── Matching con Doctor ──────────────────────────────────────────────────────

async function matchDoctors() {
  console.log("\n=== Cruzando con tabla Doctor ===");

  // Resetear todos a false primero
  await db.query('UPDATE "Doctor" SET iapos = false');

  // Traer todos los doctores
  const doctorsResult = await db.query('SELECT id, nombre FROM "Doctor" WHERE activo = true');
  const doctors = doctorsResult.rows;

  // Traer todos los providers de IAPOS
  const iaposResult = await db.query('SELECT nombre FROM "IaposProvider"');
  const iaposNames = iaposResult.rows.map((r: any) => normalizeStr(r.nombre));

  let matched = 0;
  let unmatched = 0;

  for (const doctor of doctors) {
    const doctorNorm = normalizeStr(doctor.nombre);
    const doctorApellido = extractApellido(doctor.nombre);

    // Estrategia 1: el apellido del doctor está en algún nombre IAPOS
    // Estrategia 2: el nombre completo normalizado tiene overlap significativo
    const found = iaposNames.some(iaposNorm => {
      const iaposApellido = iaposNorm.split(" ")[0];

      // Match exacto de apellido
      if (iaposApellido === doctorApellido) return true;

      // Match parcial: el nombre del doctor contiene el apellido IAPOS o viceversa
      if (doctorNorm.includes(iaposApellido) || iaposNorm.includes(doctorApellido)) return true;

      return false;
    });

    if (found) {
      await db.query('UPDATE "Doctor" SET iapos = true WHERE id = $1', [doctor.id]);
      console.log(`  ✓ ${doctor.nombre}`);
      matched++;
    } else {
      unmatched++;
    }
  }

  console.log(`\n=== Resultado matching ===`);
  console.log(`✓ Médicos marcados como IAPOS: ${matched}`);
  console.log(`~ Sin match: ${unmatched}`);
  console.log(`Total doctores: ${doctors.length}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Sync IAPOS ===\n");

  const rows = await scrapeIapos();
  await persistIapos(rows);
  await matchDoctors();

  console.log("\n✓ Sync completado");
  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
