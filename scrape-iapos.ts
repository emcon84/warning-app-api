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

/** Limpia el nombre del doctor: quita prefijos, sufijos, iniciales */
function cleanDoctorName(nombreDoctor: string): string {
  return normalizeNombre(nombreDoctor)
    .replace(/^(DRA?\.|KLGO?A?\.|LIC\.|PROF\.)\s*/i, "")
    .replace(/\s*\([^)]*\)/g, "")
    .trim();
}

/**
 * Extrae las "palabras significativas" (más de 2 chars, no iniciales) de un nombre.
 */
function significantWords(name: string): string[] {
  return name.split(/\s+/).filter(p => p.length > 2 && !p.endsWith("."));
}

/**
 * Dado el nombre limpio del doctor (ej "JOSEFINA DALLA COSTA"),
 * devuelve todas las combinaciones de apellido posibles probando
 * las últimas 1, 2 y 3 palabras significativas.
 *
 * Ej: ["COSTA", "DALLA COSTA"]
 */
function apellidoCandidates(cleanName: string): string[] {
  const words = significantWords(cleanName);
  const candidates: string[] = [];
  for (let n = 1; n <= Math.min(3, words.length); n++) {
    candidates.push(words.slice(-n).join(" "));
  }
  return candidates;
}

async function markDoctorsWithIapos(records: IaposRecord[]): Promise<void> {
  console.log("\n→ Cruzando con tabla Doctor...");

  const doctors = await prisma.doctor.findMany({
    where: { activo: true },
    select: { id: true, nombre: true },
  });

  console.log(`   ${doctors.length} doctores en la base de datos`);

  // Índice IAPOS: apellidoNorm → lista de registros
  // El apellido IAPOS (rec.apellido) ya viene separado del nombre
  const iaposByApellido = new Map<string, IaposRecord[]>();
  for (const rec of records) {
    const apellido = normalizeNombre(rec.apellido);
    if (!iaposByApellido.has(apellido)) iaposByApellido.set(apellido, []);
    iaposByApellido.get(apellido)!.push(rec);
  }

  let marcados = 0;
  const marcadosList: string[] = [];
  const noMatchList: string[] = [];

  for (const doctor of doctors) {
    const cleanName = cleanDoctorName(doctor.nombre);
    const apCandidates = apellidoCandidates(cleanName);

    let matchedApellido: string | null = null;
    let matchedRecords: IaposRecord[] = [];

    // Probar cada candidato de apellido (1, 2 o 3 palabras) de más largo a más corto
    for (const candidate of apCandidates.reverse()) {
      const found = iaposByApellido.get(candidate);
      if (found) {
        matchedApellido = candidate;
        matchedRecords = found;
        break;
      }
    }

    if (!matchedApellido) {
      noMatchList.push(doctor.nombre);
      continue;
    }

    // Las partes significativas del nombre del doctor (excluye el apellido)
    const cleanWords = significantWords(cleanName);
    const apellidoWords = matchedApellido.split(" ");
    // Palabras que no son parte del apellido → son el nombre
    const doctorFirstNameWords = cleanWords.filter(w => !apellidoWords.includes(w));

    // Verificar que al menos 1 parte del nombre del doctor coincide
    // con alguna parte del nombre IAPOS
    const matched = matchedRecords.some((rec) => {
      const iaposNombreWords = significantWords(normalizeNombre(rec.nombre));
      return doctorFirstNameWords.some(dw =>
        // Match exacto o uno empieza con el otro (Nancy ≈ NANCI, Grisela ≈ GRISELDA)
        iaposNombreWords.some(iw =>
          iw === dw ||
          (iw.length >= 4 && dw.length >= 4 && (iw.startsWith(dw) || dw.startsWith(iw)))
        )
      );
    });

    if (matched) {
      marcadosList.push(`${doctor.nombre} (apellido: ${matchedApellido})`);
      await prisma.doctor.update({
        where: { id: doctor.id },
        data: { iapos: true },
      });
      marcados++;
    } else {
      noMatchList.push(
        `${doctor.nombre} [apellido OK, nombre distinto: ${matchedRecords.map(r => r.nombre).join(", ")}]`
      );
    }
  }

  console.log(`✓ ${marcados} doctores marcados como iapos=true`);
  if (marcadosList.length > 0) {
    console.log("  Marcados:");
    marcadosList.forEach((c) => console.log(`    ✓ ${c}`));
  }
  if (noMatchList.length > 0) {
    console.log("\n  Sin match:");
    noMatchList.forEach((c) => console.log(`    ✗ ${c}`));
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
