import * as cheerio from "cheerio";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PatioLimpioZone {
  zone: string;
  barrios: string[];
  sacarFechas: string;
  recoleccionDesde: string;
}

export interface PatioLimpioData {
  mes: string;
  year: number;
  sourceUrl: string;
  instrucciones: string;
  zones: PatioLimpioZone[];
  fetchedAt: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

let cache: PatioLimpioData | null = null;

// ── URL builder ──────────────────────────────────────────────────────────────

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function buildUrl(month?: number, year?: number): string {
  const now = new Date();
  const m = month ?? now.getMonth(); // 0-indexed
  const y = year ?? now.getFullYear();
  return `https://reconquista.gob.ar/cronograma-patio-limpio-para-el-mes-de-${MESES[m]}-${y}/`;
}

// ── Scraper ──────────────────────────────────────────────────────────────────

function parseZone(text: string): PatioLimpioZone | null {
  // Match: **Zona X** (Barrio 1, Barrio 2, ...)
  const zoneMatch = text.match(/\*\*Zona\s+([A-E])\*\*\s*\(([^)]+)\)/i);
  if (!zoneMatch) return null;

  const zone = zoneMatch[1].toUpperCase();
  const barrios = zoneMatch[2]
    .split(",")
    .map((b) => b.replace(/^\d+\s*(viviendas?)?\s*/i, "").trim())
    .filter(Boolean);

  // Match: Sacar residuos: **fecha1 y fecha2**
  const sacarMatch = text.match(/Sacar residuos?:?\s*\*?\*?([^*]+?)\*?\*?/i);
  const sacarFechas = sacarMatch ? sacarMatch[1].trim() : "";

  // Match: Recolección desde: **fecha**
  const recoleccionMatch = text.match(/Recolección desde:?\s*\*?\*?([^*]+?)\*?\*?/i);
  const recoleccionDesde = recoleccionMatch ? recoleccionMatch[1].trim() : "";

  return { zone, barrios, sacarFechas, recoleccionDesde };
}

export async function scrapePatioLimpio(month?: number, year?: number): Promise<PatioLimpioData> {
  const url = buildUrl(month, year);
  const now = new Date();
  const mes = MESES[month ?? now.getMonth()];
  const y = year ?? now.getFullYear();

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ReportesReconquistaBot/1.0; +https://reportesreconquista.com)",
    },
  });

  if (!res.ok) {
    throw { status: 502, message: `No se pudo obtener el cronograma de ${mes} ${y}` };
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Find the main article content
  const content = $(".entry-content, article .content, .post-content").first();
  const paragraphs = content.find("p").toArray();

  const zones: PatioLimpioZone[] = [];
  let instrucciones = "";

  for (const p of paragraphs) {
    const text = $(p).text().trim();

    // Skip empty paragraphs
    if (!text || text.length < 10) continue;

    // Check if it's a zone paragraph
    if (text.match(/\*\*Zona\s+[A-E]\*\*/i)) {
      const zone = parseZone(text);
      if (zone) zones.push(zone);
      continue;
    }

    // Collect instructions (before the zone list)
    if (zones.length === 0 && text.length > 30 && !text.includes("http")) {
      instrucciones += (instrucciones ? " " : "") + text;
    }
  }

  // If we found zones, build the data
  if (zones.length === 0) {
    throw { status: 404, message: `No se encontraron zonas en el cronograma de ${mes} ${y}` };
  }

  const data: PatioLimpioData = {
    mes,
    year: y,
    sourceUrl: url,
    instrucciones: instrucciones.slice(0, 500) || `Cronograma de recolección de ramas, pastos y cacharros para ${mes} de ${y}.`,
    zones,
    fetchedAt: new Date().toISOString(),
  };

  // Cache the result
  cache = data;

  return data;
}

export function getCached(): PatioLimpioData | null {
  return cache;
}
