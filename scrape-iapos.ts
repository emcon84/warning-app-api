/**
 * Scraper: Padrón IAPOS — Profesionales de Reconquista
 * Run: bun run scrape-iapos.ts
 *
 * 1. Fetchea todas las páginas del padrón de prestadores de IAPOS
 *    filtrando por localidad=RECONQUISTA
 * 2. Guarda/actualiza en IaposProvider
 * 3. Cross-referencia con Doctor (por nombre normalizado) y setea iapos=true
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BASE_URL = "https://www.santafe.gov.ar/iapos-www/servlet/prcartillaafi";

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface IaposRecord {
  idPre: string;
  codesEsp: string;
  apellido: string;
  nombre: string;
  especialidad: string;
  activo: string;
  provincia: string;
  codigoPostal: string;
  codigoLocalidad: string;
  localidad: string;
  nombreCompleto: string;
  direccion: string;
  telefono: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractGXState(html: string): Record<string, any> | null {
  const m = html.match(/name="GXState" value='(.*?)'/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extractGridData(html: string): string[][] {
  const m = html.match(/name="GridprcartillaContainerDataV" value='(\[.*?\])'/s);
  if (!m) return [];
  try {
    return JSON.parse(m[1]);
  } catch {
    return [];
  }
}

function rowToRecord(row: string[]): IaposRecord {
  return {
    idPre: row[0],
    codesEsp: row[1],
    apellido: row[5],
    nombre: row[6],
    especialidad: row[7],
    activo: row[8],
    provincia: row[9],
    codigoPostal: row[10],
    codigoLocalidad: row[11],
    localidad: row[12],
    nombreCompleto: row[13],
    direccion: row[14],
    telefono: row[15],
  };
}

function normalizeNombre(name: string): string {
  return name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/\s+/g, " ")
    .trim();
}

// ── Scraping ──────────────────────────────────────────────────────────────────

async function fetchInitialPage(): Promise<{ html: string; cookies: string }> {
  const res = await fetch(
    `${BASE_URL}?lTfmV3RiZC36cMjTpd_J9QkNV03NeOhtahOx5v3i4lU=`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      },
    }
  );

  const cookies = res.headers.get("set-cookie") ?? "";
  const html = await res.text();
  return { html, cookies };
}

async function fetchSearchPage(cookies: string): Promise<{
  html: string;
  state: Record<string, any>;
}> {
  const body = new URLSearchParams({
    vFESPECODIGO_ESPECIALIDAD: "",
    vFFLOCACODIGO_CODIGO_LOCALIDAD: "RECONQUISTA",
    vFPRCARAPELL: "",
    vFPRCARNOM: "",
    BUSCAR: "Buscar",
    GXState: JSON.stringify({
      _EventName: "E'E_BUSCAR'.",
      _EventGridId: "76",
      _EventRowId: null,
    }),
  });

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: BASE_URL,
      Cookie: cookies,
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    },
    body: body.toString(),
  });

  const html = await res.text();
  const state = extractGXState(html);
  if (!state) throw new Error("No GXState en respuesta de búsqueda");

  return { html, state };
}

async function fetchNextPage(
  cookies: string,
  currentState: Record<string, any>
): Promise<{
  html: string;
  state: Record<string, any>;
  rows: string[][];
}> {
  const newState = {
    ...currentState,
    _EventName: "E'PAGINGNEXT(GRIDPRCARTILLA)'.",
    _EventGridId: "GRIDPRCARTILLA",
    _EventRowId: null,
  };

  const body = new URLSearchParams({
    vFESPECODIGO_ESPECIALIDAD: "",
    vFFLOCACODIGO_CODIGO_LOCALIDAD: "RECONQUISTA",
    vFPRCARAPELL: "",
    vFPRCARNOM: "",
    GXState: JSON.stringify(newState),
    GridprcartillaContainerDataV: "[]",
  });

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: BASE_URL,
      Cookie: cookies,
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    },
    body: body.toString(),
  });

  const html = await res.text();
  const state = extractGXState(html);
  if (!state) throw new Error("No GXState en página siguiente");
  const rows = extractGridData(html);

  return { html, state, rows };
}

async function scrapeAllPages(): Promise<IaposRecord[]> {
  console.log("→ Cargando página inicial...");
  const { cookies } = await fetchInitialPage();

  console.log("→ Buscando en Reconquista...");
  const { state: searchState } = await fetchSearchPage(cookies);

  const allRows: IaposRecord[] = [];
  let currentState = searchState;
  let page = 0;

  while (true) {
    page++;
    console.log(`→ Obteniendo página ${page}...`);
    const { state, rows } = await fetchNextPage(cookies, currentState);

    const records = rows.map(rowToRecord);
    allRows.push(...records);

    console.log(`   ${records.length} registros (total: ${allRows.length})`);

    currentState = state;

    if (state.vHASNEXTPAGE_GRIDPRCARTILLA === false || rows.length === 0) {
      break;
    }

    // Pequeña pausa para no sobrecargar el servidor
    await Bun.sleep(500);
  }

  return allRows;
}

// ── Deduplicación ─────────────────────────────────────────────────────────────

function deduplicateRecords(records: IaposRecord[]): IaposRecord[] {
  // Una persona puede aparecer múltiples veces (por especialidad o consultorio)
  // Agrupamos por idPre, priorizando la entrada con teléfono y dirección
  const byId = new Map<string, IaposRecord>();

  for (const rec of records) {
    const existing = byId.get(rec.idPre);
    if (!existing) {
      byId.set(rec.idPre, rec);
    } else {
      // Preferir entrada con más datos
      const existingScore =
        (existing.telefono ? 1 : 0) + (existing.direccion ? 1 : 0);
      const newScore = (rec.telefono ? 1 : 0) + (rec.direccion ? 1 : 0);
      if (newScore > existingScore) {
        byId.set(rec.idPre, rec);
      }
    }
  }

  return Array.from(byId.values());
}

// ── Base de datos ─────────────────────────────────────────────────────────────

async function syncToDatabase(records: IaposRecord[]): Promise<void> {
  const unique = deduplicateRecords(records);
  console.log(`\n→ Sincronizando ${unique.length} profesionales únicos...`);

  const now = new Date();
  let saved = 0;

  for (const rec of unique) {
    const nombre = `${rec.apellido} ${rec.nombre}`.trim();

    await prisma.iaposProvider.upsert({
      where: { nombre },
      update: {
        direccion: rec.direccion || "",
        telefono: rec.telefono || "",
        updatedAt: now,
      },
      create: {
        nombre,
        direccion: rec.direccion || "",
        telefono: rec.telefono || "",
        updatedAt: now,
      },
    });
    saved++;
  }

  console.log(`✓ ${saved} registros en IaposProvider`);
}

function extractApellidoFromDoctorName(nombreDoctor: string): string {
  // Eliminar prefijos: Dr., Dra., Dr , Dra
  let name = nombreDoctor
    .replace(/^(Dr[a]?\.|Dr[a]?\s)/i, "")
    .trim();

  // Normalizar
  name = normalizeNombre(name);

  // Extraer apellido: el último o penúltimo token (puede haber iniciales medias)
  // Ej: "Pedro Eduardo Josa" → apellido = "JOSA"
  // Ej: "Marcelo G. Ramseyer" → apellido = "RAMSEYER"
  // Ej: "Marcelo A. Sartor (H)" → apellido = "SARTOR"
  // Limpiamos sufijos entre paréntesis
  name = name.replace(/\s*\([^)]*\)/g, "").trim();

  const parts = name.split(/\s+/);
  // Tomar las últimas 1 o 2 partes (para apellidos compuestos)
  // Pero filtrar iniciales (palabras de 1-2 chars con punto)
  const significantParts = parts.filter(p => p.length > 2 && !p.endsWith('.'));

  if (significantParts.length === 0) return parts[parts.length - 1] ?? "";
  return significantParts[significantParts.length - 1];
}

async function markDoctorsWithIapos(records: IaposRecord[]): Promise<void> {
  console.log("\n→ Cruzando con tabla Doctor...");

  // Obtener todos los doctores activos
  const doctors = await prisma.doctor.findMany({
    where: { activo: true },
    select: { id: true, nombre: true },
  });

  console.log(`   ${doctors.length} doctores en la base de datos`);

  // Construir mapa: apellido IAPOS → lista de registros
  // Los nombres IAPOS son "APELLIDO NOMBRE"
  const iaposByApellido = new Map<string, IaposRecord[]>();
  for (const rec of records) {
    const apellido = normalizeNombre(rec.apellido);
    if (!iaposByApellido.has(apellido)) {
      iaposByApellido.set(apellido, []);
    }
    iaposByApellido.get(apellido)!.push(rec);
  }

  let marcados = 0;
  let candidatos: string[] = [];
  let noMatch: string[] = [];

  for (const doctor of doctors) {
    // El nombre del doctor suele ser "Nombre Apellido" → extraemos apellido
    const apellidoDoctor = extractApellidoFromDoctorName(doctor.nombre);

    const iaposMatches = iaposByApellido.get(apellidoDoctor);
    if (!iaposMatches) {
      noMatch.push(doctor.nombre);
      continue;
    }

    // Con el apellido en común, validar que al menos una parte del nombre coincida
    const nombreDoctorNorm = normalizeNombre(
      doctor.nombre
        .replace(/^(Dr[a]?\.|Dr[a]?\s)/i, "")
        .replace(/\s*\([^)]*\)/g, "")
    );
    const partesDoctor = nombreDoctorNorm.split(/\s+/).filter(p => p.length > 2 && !p.endsWith('.'));

    const match = iaposMatches.some((rec) => {
      const iaposNombreParts = normalizeNombre(rec.nombre).split(/\s+/);
      // Al menos una parte del nombre debe coincidir
      return iaposNombreParts.some((part) => partesDoctor.includes(part));
    });

    if (match) {
      candidatos.push(`${doctor.nombre} (apellido: ${apellidoDoctor})`);
      await prisma.doctor.update({
        where: { id: doctor.id },
        data: { iapos: true },
      });
      marcados++;
    } else {
      noMatch.push(
        `${doctor.nombre} [apellido match: ${iaposMatches.map(r => r.nombre).join(", ")}]`
      );
    }
  }

  console.log(`✓ ${marcados} doctores marcados como iapos=true`);
  if (candidatos.length > 0) {
    console.log("  Doctores marcados:");
    candidatos.forEach((c) => console.log(`    ✓ ${c}`));
  }
  if (noMatch.length > 0 && noMatch.length <= 30) {
    console.log("\n  Sin match:");
    noMatch.forEach((c) => console.log(`    ✗ ${c}`));
  }
}

// ── Reset previo (opcional) ────────────────────────────────────────────────────

async function resetIaposFlag(): Promise<void> {
  const updated = await prisma.doctor.updateMany({
    where: { iapos: true },
    data: { iapos: false },
  });
  console.log(`→ Reset iapos=false en ${updated.count} doctores`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Scraper IAPOS — Padrón Reconquista ===\n");

  try {
    // 1. Scraping
    const allRecords = await scrapeAllPages();
    console.log(`\n✓ Total registros scrapeados: ${allRecords.length}`);

    // 2. Guardar en IaposProvider
    await syncToDatabase(allRecords);

    // 3. Reset flags previos y re-marcar doctores
    await resetIaposFlag();
    await markDoctorsWithIapos(allRecords);

    console.log("\n=== Listo ===");
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
