import * as repo from "./hero.repository";
import { uploadFileToR2, deleteFromR2 } from "../../shared/storage";

// ── Types ────────────────────────────────────────────────────────────────────

interface RankableEntity {
  id: string;
  slug: string;
  ratingAvg: number;
  ratingCount: number;
  recommendations: number;
  foto: string | null;
  descripcion: string | null;
  createdAt: Date;
  logo?: string | null;
  isPremium?: boolean;
}

export interface RankedSlide {
  slideType: "professional" | "comercio";
  refId: string;
  title: string;
  subtitle: string;
  ctaText: string;
  ctaUrl: string;
  score: number;
}

// ── Bayesian ranking ─────────────────────────────────────────────────────────

function bayesianAvg(
  entityAvg: number,
  entityCount: number,
  globalAvg: number,
  m: number
): number {
  return (m * globalAvg + entityCount * entityAvg) / (m + entityCount);
}

function computeScore(
  entity: RankableEntity,
  globalAvg: number,
  maxReviewCount: number,
  maxDays: number
): number {
  const bayesian =
    entity.ratingCount > 0
      ? bayesianAvg(entity.ratingAvg, entity.ratingCount, globalAvg, 5)
      : globalAvg * 0.5;

  const ratingScore = (bayesian / 5) * 40;
  const reviewScore =
    Math.log2(entity.ratingCount + 1) / Math.log2(maxReviewCount + 1) * 25;
  const seniorityScore =
    Math.min(
      (Date.now() - entity.createdAt.getTime()) / (1000 * 86400) / maxDays,
      1
    ) * 15;
  const photoBonus = (entity.foto || entity.logo) ? 10 : 0;
  const premiumBonus = entity.isPremium ? 10 : 0;

  return ratingScore + reviewScore + seniorityScore + photoBonus + premiumBonus;
}

// ── Public endpoint ──────────────────────────────────────────────────────────

export async function getActiveSlides() {
  const [rawSlides, pros, comercios] = await Promise.all([
    repo.findActiveSlides(),
    repo.findActiveProfessionalsForRanking(),
    repo.findActiveComerciosForRanking(),
  ]);

  // Build maps for ref lookups
  const validProIds = new Set(pros.map((p) => p.id));
  const validComIds = new Set(comercios.map((c) => c.id));
  const proMap = new Map(pros.map((p) => [p.id, p]));
  const comMap = new Map(comercios.map((c) => [c.id, c]));

  // Filter out orphan slides (refId points to deleted entity)
  const slides = rawSlides.filter((s) => {
    if (s.slideType === "promo") return true;
    if (s.slideType === "professional") return s.refId ? validProIds.has(s.refId) : false;
    if (s.slideType === "comercio") return s.refId ? validComIds.has(s.refId) : false;
    return false;
  });

  const computedAt = new Date();
  const expiresAt = new Date(computedAt.getTime() + 24 * 60 * 60 * 1000);

  return {
    slides: slides.map((s) => {
      let description: string | null = null;
      if (s.slideType === "professional" && s.refId) {
        description = proMap.get(s.refId)?.descripcion ?? null;
      } else if (s.slideType === "comercio" && s.refId) {
        description = comMap.get(s.refId)?.descripcion ?? null;
      }
      return {
        id: s.id,
        slideType: s.slideType as "professional" | "comercio" | "promo",
        refId: s.refId,
        title: s.title,
        subtitle: s.subtitle,
        description,
        ctaText: s.ctaText,
        ctaUrl: s.ctaUrl,
        imageUrl: s.imageUrl,
        imagePosition: s.imagePosition,
        isPinned: s.isPinned,
        sortOrder: s.sortOrder,
      };
    }),
    computedAt: computedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

// ── Admin list ───────────────────────────────────────────────────────────────

export async function listAllSlides() {
  const [slides, pros, comercios] = await Promise.all([
    repo.findAllSlides(),
    repo.findActiveProfessionalsForRanking(),
    repo.findActiveComerciosForRanking(),
  ]);

  const proMap = new Map(pros.map((p) => [p.id, p]));
  const comMap = new Map(comercios.map((c) => [c.id, c]));

  return slides.map((s) => ({
    id: s.id,
    slideType: s.slideType,
    refId: s.refId,
    title: s.title,
    subtitle: s.subtitle,
    ctaText: s.ctaText,
    ctaUrl: s.ctaUrl,
    imageUrl: s.imageUrl,
    imagePosition: s.imagePosition,
    isPinned: s.isPinned,
    sortOrder: s.sortOrder,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    refExists: s.slideType === "promo"
      ? null
      : s.slideType === "professional"
        ? proMap.has(s.refId ?? "")
        : comMap.has(s.refId ?? ""),
    refName: s.slideType === "professional"
      ? proMap.get(s.refId ?? "")?.nombre ?? null
      : s.slideType === "comercio"
        ? comMap.get(s.refId ?? "")?.nombre ?? null
        : null,
    description: s.slideType === "professional"
      ? proMap.get(s.refId ?? "")?.descripcion ?? null
      : s.slideType === "comercio"
        ? comMap.get(s.refId ?? "")?.descripcion ?? null
        : null,
  }));
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function createPromoSlide(fields: {
  title: string;
  subtitle?: string;
  ctaText?: string;
  ctaUrl?: string;
  imagePosition?: string;
  file?: File | null;
  startsAt?: string;
  endsAt?: string;
}) {
  let imageUrl: string | undefined;

  if (fields.file) {
    const url = await uploadFileToR2(fields.file, "hero-promo");
    if (url) imageUrl = url;
  }

  return repo.createSlide({
    slideType: "promo",
    title: fields.title,
    subtitle: fields.subtitle,
    ctaText: fields.ctaText,
    ctaUrl: fields.ctaUrl,
    imageUrl,
    imagePosition: fields.imagePosition,
    startsAt: fields.startsAt ? new Date(fields.startsAt) : undefined,
    endsAt: fields.endsAt ? new Date(fields.endsAt) : undefined,
  });
}

export async function updatePromoSlide(
  id: string,
  fields: {
    title?: string;
    subtitle?: string | null;
    ctaText?: string | null;
    ctaUrl?: string | null;
    imageUrl?: string | null;
    imagePosition?: string;
    file?: File | null;
    isPinned?: boolean;
    sortOrder?: number;
    startsAt?: string | null;
    endsAt?: string | null;
  }
) {
  const existing = await repo.findSlideById(id);
  if (!existing) throw { status: 404, message: "Slide no encontrado" };

  // If imageUrl is explicitly set to null, clear the image (also remove from R2)
  if (fields.imageUrl === null) {
    if (existing.imageUrl) {
      await deleteFromR2(existing.imageUrl).catch(() => {});
    }
  }

  let newImageUrl: string | null | undefined;
  if (fields.file) {
    const url = await uploadFileToR2(fields.file, "hero-promo");
    if (url) newImageUrl = url;
  }

  return repo.updateSlide(id, {
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.subtitle !== undefined ? { subtitle: fields.subtitle } : {}),
    ...(fields.ctaText !== undefined ? { ctaText: fields.ctaText } : {}),
    ...(fields.ctaUrl !== undefined ? { ctaUrl: fields.ctaUrl } : {}),
    ...(fields.isPinned !== undefined ? { isPinned: fields.isPinned } : {}),
    ...(fields.sortOrder !== undefined ? { sortOrder: fields.sortOrder } : {}),
    ...(fields.imageUrl !== undefined ? { imageUrl: fields.imageUrl } : {}),
    ...(newImageUrl !== undefined ? { imageUrl: newImageUrl } : {}),
    ...(fields.imagePosition !== undefined ? { imagePosition: fields.imagePosition } : {}),
    ...(fields.startsAt !== undefined
      ? { startsAt: fields.startsAt ? new Date(fields.startsAt) : null }
      : {}),
    ...(fields.endsAt !== undefined
      ? { endsAt: fields.endsAt ? new Date(fields.endsAt) : null }
      : {}),
  });
}

export async function toggleSlidePin(id: string, isPinned: boolean) {
  const existing = await repo.findSlideById(id);
  if (!existing) throw { status: 404, message: "Slide no encontrado" };
  return repo.togglePin(id, isPinned);
}

export async function removeSlide(id: string) {
  const existing = await repo.findSlideById(id);
  if (!existing) throw { status: 404, message: "Slide no encontrado" };
  if (existing.imageUrl) {
    await deleteFromR2(existing.imageUrl).catch(() => {});
  }
  await repo.deleteSlide(id);
  return { deleted: true };
}

// ── Recalculate ranking ──────────────────────────────────────────────────────

export async function recalculateRanking() {
  const [professionals, comercios] = await Promise.all([
    repo.findActiveProfessionalsForRanking(),
    repo.findActiveComerciosForRanking(),
  ]);

  // Compute global averages for Bayesian prior
  const allratings = [
    ...professionals.map((p) => ({ avg: p.ratingAvg, count: p.ratingCount })),
    ...comercios.map((c) => ({ avg: c.ratingAvg, count: c.ratingCount })),
  ];

  const totalWeighted = allratings.reduce((s, r) => s + r.avg * r.count, 0);
  const totalCount = allratings.reduce((s, r) => s + r.count, 0);
  const globalAvg = totalCount > 0 ? totalWeighted / totalCount : 4.0;

  const [maxProReviews, maxComReviews] = await Promise.all([
    repo.findMaxRatingCount("professional"),
    repo.findMaxRatingCount("comercio"),
  ]);

  const maxReviewCount = Math.max(maxProReviews, maxComReviews, 1);
  // Use max days across both (max ~5 years)
  const now = Date.now();
  const allDays = [...professionals, ...comercios].map(
    (e) => (now - e.createdAt.getTime()) / (1000 * 86400)
  );
  const maxDays = Math.max(...allDays, 1);

  // Score professionals
  const scoredPros: RankedSlide[] = professionals.map((p) => ({
    slideType: "professional" as const,
    refId: p.id,
    title: `${p.nombre} ${p.apellido}`,
    subtitle: p.oficios[0] ?? "Profesional",
    ctaText: "Ver perfil",
    ctaUrl: `/profesional/${p.slug}`,
    score: computeScore(
      { ...p, logo: null, isPremium: false },
      globalAvg,
      maxReviewCount,
      maxDays
    ),
  }));

  // Score comercios
  const scoredComs: RankedSlide[] = comercios.map((c) => ({
    slideType: "comercio" as const,
    refId: c.id,
    title: c.nombre,
    subtitle: c.rubro,
    ctaText: "Ver comercio",
    ctaUrl: `/comercio/${c.slug}`,
    score: computeScore(c, globalAvg, maxReviewCount, maxDays),
  }));

  // Sort by score descending
  scoredPros.sort((a, b) => b.score - a.score);
  scoredComs.sort((a, b) => b.score - a.score);

  // Take top 3 per type
  const top3Pros = scoredPros.slice(0, 3);
  const top3Coms = scoredComs.slice(0, 3);

  // Interleave: pro, comercio, pro, comercio, pro, comercio
  const maxLen = Math.max(top3Pros.length, top3Coms.length);
  const rankedSlides: RankedSlide[] = [];
  let order = 0;

  for (let i = 0; i < maxLen; i++) {
    if (i < top3Pros.length) {
      rankedSlides.push({ ...top3Pros[i], score: order++ });
    }
    if (i < top3Coms.length) {
      rankedSlides.push({ ...top3Coms[i], score: order++ });
    }
  }

  // Delete old auto-generated slides
  const deleted = await repo.deleteSlidesByType(["professional", "comercio"]);

  // Insert new ranked slides
  let created = 0;
  for (const slide of rankedSlides) {
    await repo.createSlide({
      slideType: slide.slideType,
      refId: slide.refId,
      title: slide.title,
      subtitle: slide.subtitle,
      ctaText: slide.ctaText,
      ctaUrl: slide.ctaUrl,
      sortOrder: Math.round(slide.score),
    });
    created++;
  }

  // Remove orphan slides (refId pointing to deleted entities)
  const allSlides = await repo.findAllSlides();
  const validProIds = new Set(professionals.map((p) => p.id));
  const validComIds = new Set(comercios.map((c) => c.id));
  let orphansRemoved = 0;

  for (const slide of allSlides) {
    if (slide.slideType === "professional" && slide.refId && !validProIds.has(slide.refId)) {
      await repo.deleteSlide(slide.id);
      orphansRemoved++;
    } else if (slide.slideType === "comercio" && slide.refId && !validComIds.has(slide.refId)) {
      await repo.deleteSlide(slide.id);
      orphansRemoved++;
    }
  }

  return {
    professionalsScored: professionals.length,
    comerciosScored: comercios.length,
    deletedAutoSlides: deleted.count,
    createdSlides: created,
    orphansRemoved,
    globalAvg: Math.round(globalAvg * 100) / 100,
    maxReviewCount,
    maxDays: Math.round(maxDays),
    rankedSlides: rankedSlides.map((s) => ({
      type: s.slideType,
      title: s.title,
      score: s.score,
    })),
  };
}
