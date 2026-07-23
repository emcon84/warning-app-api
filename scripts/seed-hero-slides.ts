import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── Bayesian ranking ──────────────────────────────────────────────────────────

function bayesianAvg(
  entityAvg: number,
  entityCount: number,
  globalAvg: number,
  m: number
): number {
  return (m * globalAvg + entityCount * entityAvg) / (m + entityCount);
}

function computeScore(
  entity: {
    ratingAvg: number;
    ratingCount: number;
    recommendations: number;
    foto: string | null;
    logo?: string | null;
    isPremium?: boolean;
    createdAt: Date;
  },
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🌱 Seeding hero slides with Bayesian ranking...");

  // 1. Fetch active professionals and comercios
  const [professionals, comercios] = await Promise.all([
    prisma.professional.findMany({
      where: { activo: true },
      select: {
        id: true,
        slug: true,
        nombre: true,
        apellido: true,
        oficios: true,
        ratingAvg: true,
        ratingCount: true,
        recommendations: true,
        foto: true,
        createdAt: true,
      },
    }),
    prisma.comercio.findMany({
      where: { activo: true },
      select: {
        id: true,
        slug: true,
        nombre: true,
        rubro: true,
        ratingAvg: true,
        ratingCount: true,
        recommendations: true,
        foto: true,
        logo: true,
        isPremium: true,
        createdAt: true,
      },
    }),
  ]);

  console.log(`   → ${professionals.length} professionals, ${comercios.length} comercios fetched`);

  if (professionals.length === 0 && comercios.length === 0) {
    console.log("   ⚠ No active entities found — nothing to seed");
    return;
  }

  // 2. Compute global averages for Bayesian prior
  const allRatings = [
    ...professionals.map((p) => ({ avg: p.ratingAvg, count: p.ratingCount })),
    ...comercios.map((c) => ({ avg: c.ratingAvg, count: c.ratingCount })),
  ];
  const totalWeighted = allRatings.reduce((s, r) => s + r.avg * r.count, 0);
  const totalCount = allRatings.reduce((s, r) => s + r.count, 0);
  const globalAvg = totalCount > 0 ? totalWeighted / totalCount : 4.0;

  // Compute max values for normalization
  const maxProReviews = professionals.reduce((m, p) => Math.max(m, p.ratingCount), 0);
  const maxComReviews = comercios.reduce((m, c) => Math.max(m, c.ratingCount), 0);
  const maxReviewCount = Math.max(maxProReviews, maxComReviews, 1);

  const now = Date.now();
  const allDays = [...professionals, ...comercios].map(
    (e) => (now - e.createdAt.getTime()) / (1000 * 86400)
  );
  const maxDays = Math.max(...allDays, 1);

  // 3. Score and sort
  const scoredPros = professionals
    .map((p) => ({
      slideType: "professional" as const,
      refId: p.id,
      title: `${p.nombre} ${p.apellido}`,
      subtitle: p.oficios[0] ?? "Profesional",
      ctaText: "Ver perfil",
      ctaUrl: `/profesional/${p.slug}`,
      score: computeScore(p, globalAvg, maxReviewCount, maxDays),
    }))
    .sort((a, b) => b.score - a.score);

  const scoredComs = comercios
    .map((c) => ({
      slideType: "comercio" as const,
      refId: c.id,
      title: c.nombre,
      subtitle: c.rubro,
      ctaText: "Ver comercio",
      ctaUrl: `/comercio/${c.slug}`,
      score: computeScore(c, globalAvg, maxReviewCount, maxDays),
    }))
    .sort((a, b) => b.score - a.score);

  // 4. Take top 3 per type
  const topPros = scoredPros.slice(0, 3);
  const topComs = scoredComs.slice(0, 3);

  // 5. Delete existing auto-generated slides
  const deleted = await prisma.heroSlide.deleteMany({
    where: { slideType: { in: ["professional", "comercio"] } },
  });
  console.log(`   → Deleted ${deleted.count} existing auto slides`);

  // 6. Interleave: pro, comercio, pro, comercio, pro, comercio
  const maxLen = Math.max(topPros.length, topComs.length);
  let order = 0;

  for (let i = 0; i < maxLen; i++) {
    if (i < topPros.length) {
      const s = topPros[i];
      await prisma.heroSlide.create({
        data: {
          slideType: s.slideType,
          refId: s.refId,
          title: s.title,
          subtitle: s.subtitle,
          ctaText: s.ctaText,
          ctaUrl: s.ctaUrl,
          sortOrder: order++,
        },
      });
      console.log(`   ✅ Created professional slide: "${s.title}" (score: ${Math.round(s.score)})`);
    }
    if (i < topComs.length) {
      const s = topComs[i];
      await prisma.heroSlide.create({
        data: {
          slideType: s.slideType,
          refId: s.refId,
          title: s.title,
          subtitle: s.subtitle,
          ctaText: s.ctaText,
          ctaUrl: s.ctaUrl,
          sortOrder: order++,
        },
      });
      console.log(`   ✅ Created comercio slide: "${s.title}" (score: ${Math.round(s.score)})`);
    }
  }

  // 7. Remove orphan slides
  const allSlides = await prisma.heroSlide.findMany();
  const validProIds = new Set(professionals.map((p) => p.id));
  const validComIds = new Set(comercios.map((c) => c.id));
  let orphans = 0;

  for (const slide of allSlides) {
    if (slide.slideType === "professional" && slide.refId && !validProIds.has(slide.refId)) {
      await prisma.heroSlide.delete({ where: { id: slide.id } });
      orphans++;
    } else if (slide.slideType === "comercio" && slide.refId && !validComIds.has(slide.refId)) {
      await prisma.heroSlide.delete({ where: { id: slide.id } });
      orphans++;
    }
  }

  if (orphans > 0) {
    console.log(`   → Removed ${orphans} orphan slides`);
  }

  const totalCreated = topPros.length + topComs.length;
  console.log(`\n✨ Seed completado. ${totalCreated} hero slides created.`);
  console.log(`   Global avg: ${globalAvg.toFixed(2)} | Max reviews: ${maxReviewCount} | Max days: ${Math.round(maxDays)}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
