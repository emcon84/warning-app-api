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
  const m = month ?? now.getMonth();
  const y = year ?? now.getFullYear();
  return `https://reconquista.gob.ar/cronograma-patio-limpio-para-el-mes-de-${MESES[m]}-${y}/`;
}

// ── FlareSolverr ─────────────────────────────────────────────────────────────

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";

async function fetchViaFlareSolverr(url: string): Promise<string> {
  const res = await fetch(FLARESOLVERR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 30000 }),
  });
  if (!res.ok) throw { status: 502, message: `FlareSolverr error: ${res.status}` };
  const data = await res.json() as { status: string; solution?: { response: string } };
  if (data.status !== "ok" || !data.solution) throw { status: 502, message: "FlareSolverr no pudo obtener la pagina" };
  return data.solution.response;
}

// ── Scraper ──────────────────────────────────────────────────────────────────

export async function scrapePatioLimpio(month?: number, year?: number): Promise<PatioLimpioData> {
  const url = buildUrl(month, year);
  const now = new Date();
  const mes = MESES[month ?? now.getMonth()];
  const y = year ?? now.getFullYear();

  const html = await fetchViaFlareSolverr(url);
  const $ = cheerio.load(html);

  // Get article content
  const article = $("article, .entry-content, .post-content").first();
  if (!article.length) throw { status: 404, message: "No se encontro el contenido del cronograma" };

  // Extract instructions (paragraphs before first zone)
  let instrucciones = "";
  const allPs = article.find("p").toArray();

  const zones: PatioLimpioZone[] = [];

  for (const p of allPs) {
    const $p = $(p);
    const text = $p.text().trim();

    if (!text || text.length < 10) continue;

    // Check if this paragraph contains a zone header
    const strongTags = $p.find("strong").toArray();
    if (strongTags.length > 0) {
      const firstStrong = $(strongTags[0]).text().trim().replace(/\u00A0/g, "");

      if (firstStrong.match(/^Zona\s+[A-E]$/i)) {
        // Parse zone info from this paragraph
        const zoneText = text;

        // Extract barrios from parentheses
        const barriosMatch = zoneText.match(/\(([^)]+)\)/);
        const barrios = barriosMatch
          ? barriosMatch[1].split(",").map((b) => b.trim()).filter(Boolean)
          : [];

        // Extract sacar residuos and recoleccion by looking at raw HTML
        const pHtml = $p.html() || "";
        let sacarFechas = "";
        let recoleccionDesde = "";

        // Find "Sacar residuos:" and get the next strong tag's content
        const sacarMatch = pHtml.match(/Sacar residuos:?\s*(?:&nbsp;)?\s*<strong>(.+?)<\/strong>/is);
        if (sacarMatch) sacarFechas = sacarMatch[1].replace(/<br\s*\/?>/gi, "").trim();

        // Find "Recolección desde:" and get the next strong tag's content
        const recoleccionMatch = pHtml.match(/Recolecci[oó]n desde:?\s*(?:&nbsp;)?\s*<strong>(.+?)<\/strong>/is);
        if (recoleccionMatch) recoleccionDesde = recoleccionMatch[1].replace(/<br\s*\/?>/gi, "").trim();

        zones.push({
          zone: firstStrong.replace("Zona ", ""),
          barrios,
          sacarFechas,
          recoleccionDesde,
        });
        continue;
      }
    }

    // Collect instructions (text before zones)
    if (zones.length === 0 && text.length > 30 && !text.includes("http")) {
      instrucciones += (instrucciones ? " " : "") + text;
    }
  }

  if (zones.length === 0) {
    throw { status: 404, message: `No se encontraron zonas en el cronograma de ${mes} ${y}` };
  }

  const data: PatioLimpioData = {
    mes,
    year: y,
    sourceUrl: url,
    instrucciones: instrucciones.slice(0, 600) || `Cronograma de recolección de ramas, pastos y cacharros para ${mes} de ${y}.`,
    zones,
    fetchedAt: new Date().toISOString(),
  };

  cache = data;
  return data;
}

export function getCached(): PatioLimpioData | null {
  return cache;
}
