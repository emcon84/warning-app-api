import * as cheerio from "cheerio";
import { sanitizeText } from "../../shared/sanitize";

// ── Types ────────────────────────────────────────────────────────────────────

export interface NewsArticle {
  id: string;
  title: string;
  excerpt: string;
  imageUrl: string | null;
  sourceUrl: string;
  sourceName: string;
  publishedAt: string;
}

interface PortalConfig {
  name: string;
  feedUrl: string;
  articleSelector: string;
  titleSelector: string;
  urlSelector: string;
  imageSelector: string;
  dateSelector: string;
  imageAttr: string;
  urlPrefix: string;
  imageFromStyle?: boolean;
}

const PORTALS: Record<string, PortalConfig> = {
  reconquistahoy: {
    name: "Reconquista Hoy",
    feedUrl: "https://www.reconquistahoy.com",
    articleSelector: 'article[itemscope][itemtype*="NewsArticle"]',
    titleSelector: '[itemprop="headline"]',
    urlSelector: 'a[itemprop="url"]',
    imageSelector: 'picture img.pic',
    dateSelector: '[itemprop="datePublished"]',
    imageAttr: "src",
    urlPrefix: "",
  },
  reconquistaar: {
    name: "Reconquista.com.ar",
    feedUrl: "https://www.reconquista.com.ar",
    articleSelector: "div.post-item.post-block",
    titleSelector: "h2.entry-title a",
    urlSelector: "h2.entry-title a",
    imageSelector: "a.mnp-post-image",
    dateSelector: "",
    imageAttr: "style",
    urlPrefix: "",
    imageFromStyle: true,
  },
};

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data: NewsArticle[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function isCacheValid(portal: string): boolean {
  const entry = cache.get(portal);
  if (!entry) return false;
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// ── Scraper ────────────────────────────────────────────────────────────────────

function extractId(url: string): string {
  const match = url.match(/\/(\d+)-/);
  return match ? match[1] : url;
}

function extractImageUrl($el: cheerio.Cheerio, config: PortalConfig): string | null {
  const raw = $el.find(config.imageSelector).first().attr(config.imageAttr);
  if (!raw) return null;
  if (config.imageFromStyle) {
    const m = raw.match(/url\(['"]([^'"]+)['"]\)/i);
    return m ? m[1] : null;
  }
  return raw;
}

function extractDateFromUrl(url: string): string {
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00-03:00`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return "";
}

export async function scrapePortal(portalKey: string): Promise<NewsArticle[]> {
  const config = PORTALS[portalKey];
  if (!config) throw { status: 404, message: `Portal "${portalKey}" no encontrado` };

  const res = await fetch(config.feedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ReportesReconquistaBot/1.0; +https://reportesreconquista.com)",
    },
  });

  if (!res.ok) throw { status: 502, message: `Error al fetching ${config.name}: ${res.status}` };

  const html = await res.text();
  const $ = cheerio.load(html);
  const articles: NewsArticle[] = [];

  $(config.articleSelector).each((_, el) => {
    const $el = $(el);

    const title = sanitizeText($el.find(config.titleSelector).first().text(), 200);
    if (!title) return;

    const rawUrl = $el.find(config.urlSelector).first().attr("href") || "";
    if (!rawUrl) return;

    const fullUrl = rawUrl.startsWith("http") ? rawUrl : `${config.urlPrefix}${rawUrl}`;
    const imageUrl = extractImageUrl($el, config);

    let publishedAt = "";
    if (config.dateSelector) {
      const dateRaw = $el.find(config.dateSelector).first().attr("content") || "";
      publishedAt = dateRaw || "";
    }
    if (!publishedAt) {
      publishedAt = extractDateFromUrl(fullUrl);
    }
    if (!publishedAt) {
      publishedAt = new Date().toISOString();
    }

    articles.push({
      id: extractId(fullUrl),
      title,
      excerpt: title,
      imageUrl,
      sourceUrl: fullUrl,
      sourceName: config.name,
      publishedAt,
    });
  });

  return articles;
}

// ── Service ───────────────────────────────────────────────────────────────────

export async function getNews(portal: string = "reconquistahoy"): Promise<NewsArticle[]> {
  if (!PORTALS[portal]) throw { status: 404, message: `Portal "${portal}" no encontrado` };

  if (isCacheValid(portal)) {
    return cache.get(portal)!.data;
  }

  const articles = await scrapePortal(portal);
  cache.set(portal, { data: articles, fetchedAt: Date.now() });
  return articles;
}

export async function refreshNews(portal: string = "reconquistahoy"): Promise<NewsArticle[]> {
  if (!PORTALS[portal]) throw { status: 404, message: `Portal "${portal}" no encontrado` };

  const articles = await scrapePortal(portal);
  cache.set(portal, { data: articles, fetchedAt: Date.now() });
  return articles;
}

// ── Periodic Refresh ───────────────────────────────────────────────────────────

let periodicTimer: ReturnType<typeof setInterval> | null = null;

const PORTAL_KEYS = Object.keys(PORTALS);

export function startPeriodicRefresh(intervalMs: number = 5 * 60 * 1000): void {
  if (periodicTimer) return;

  console.log(`📰 News: periodic refresh cada ${intervalMs / 1000}s para [${PORTAL_KEYS.join(", ")}]`);

  const refreshAll = async () => {
    for (const key of PORTAL_KEYS) {
      try {
        const articles = await scrapePortal(key);
        cache.set(key, { data: articles, fetchedAt: Date.now() });
        console.log(`📰 News: ${key} → ${articles.length} artículos`);
      } catch (e) {
        console.error(`📰 News: error en ${key}:`, e);
      }
    }
  };

  refreshAll();
  periodicTimer = setInterval(refreshAll, intervalMs);
}

export function stopPeriodicRefresh(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}
