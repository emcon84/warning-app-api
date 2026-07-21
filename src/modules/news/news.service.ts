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
  feedType?: 'html' | 'rss';
  articleSelector: string;
  titleSelector: string;
  urlSelector: string;
  imageSelector: string;
  dateSelector: string;
  imageAttr: string;
  urlPrefix: string;
  imageFromStyle?: boolean;
  useProxy?: boolean;
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
    useProxy: true,
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
  reconquistanoticias: {
    name: "Reconquista Noticias",
    feedUrl: "https://reconquistanoticias.blogspot.com/feeds/posts/default?alt=rss",
    feedType: "rss",
    articleSelector: "item",
    titleSelector: "title",
    urlSelector: "link",
    imageSelector: "",
    dateSelector: "pubDate",
    imageAttr: "",
    urlPrefix: "",
  },
  vialibre: {
    name: "Vía Libre",
    feedUrl: "https://www.vialibre.ar",
    articleSelector: 'article[itemtype="http://schema.org/NewsArticle"]',
    titleSelector: 'h2[itemprop="headline"]',
    urlSelector: 'a[itemprop="url"]',
    imageSelector: 'img[itemprop="image"]',
    dateSelector: 'meta[itemprop="datePublished"]',
    imageAttr: "src",
    urlPrefix: "https://www.vialibre.ar",
  },
};

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data: NewsArticle[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;

function isCacheValid(portal: string): boolean {
  const entry = cache.get(portal);
  if (!entry) return false;
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// ── Scraper ────────────────────────────────────────────────────────────────────

function extractId(url: string): string {
  const match = url.match(/\/(\d+)-/);
  if (match) return match[1];
  // fallback: hash simple del path para URLs sin ID numérico (blogspot)
  return url.replace(/https?:\/\//, "").replace(/[^a-zA-Z0-9]/g, "_").slice(0, 60);
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

function parseRssFeed(config: PortalConfig, xml: string): NewsArticle[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const articles: NewsArticle[] = [];

  $(config.articleSelector || "item").each((_, el) => {
    const $item = $(el);

    const title = sanitizeText($item.find("title").first().text(), 200);
    if (!title) return;

    const rawUrl = $item.find("link").first().text() || "";
    if (!rawUrl) return;

    const fullUrl = rawUrl.startsWith("http") ? rawUrl : `${config.urlPrefix}${rawUrl}`;

    // Extract image from description HTML
    let imageUrl: string | null = null;
    const descHtml = $item.find("description").first().text() || "";
    if (descHtml) {
      const $desc = cheerio.load(descHtml);
      imageUrl = $desc("img").first().attr("src") || null;
    }

    let publishedAt = "";
    const dateStr = $item.find("pubDate").first().text() || "";
    if (dateStr) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
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

export async function scrapePortal(portalKey: string): Promise<NewsArticle[]> {
  const config = PORTALS[portalKey];
  if (!config) throw { status: 404, message: `Portal "${portalKey}" no encontrado` };

  const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY;
  let url = config.feedUrl;
  let headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; ReportesReconquistaBot/1.0; +https://reportesreconquista.com)",
  };

  if (config.useProxy && scrapingBeeKey) {
    url = `https://app.scrapingbee.com/api/v1/?api_key=${scrapingBeeKey}&url=${encodeURIComponent(config.feedUrl)}&render_js=false&stealth_proxy=true`;
    headers = {};
  }

  const res = await fetch(url, { headers });

  if (!res.ok) throw { status: 502, message: `Error al fetching ${config.name}: ${res.status}` };

  const body = await res.text();

  // RSS feed parsing
  if (config.feedType === "rss") {
    return parseRssFeed(config, body);
  }

  // HTML parsing with Cheerio
  const $ = cheerio.load(body);
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

export function startPeriodicRefresh(intervalMs: number = 60 * 60 * 1000): void {
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
