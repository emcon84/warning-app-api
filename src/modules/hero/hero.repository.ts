import { prisma } from "../../lib/prisma";

// ── HeroSlide CRUD ──────────────────────────────────────────────────────────

export async function findActiveSlides() {
  const now = new Date();
  return prisma.heroSlide.findMany({
    where: {
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    },
    orderBy: [{ isPinned: "desc" }, { sortOrder: "asc" }],
  });
}

export async function findAllSlides() {
  return prisma.heroSlide.findMany({
    orderBy: [{ isPinned: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
  });
}

export async function findSlideById(id: string) {
  return prisma.heroSlide.findUnique({ where: { id } });
}

export async function createSlide(data: {
  slideType: string;
  refId?: string;
  title: string;
  subtitle?: string;
  ctaText?: string;
  ctaUrl?: string;
  imageUrl?: string;
  imagePosition?: string;
  isPinned?: boolean;
  sortOrder?: number;
  startsAt?: Date;
  endsAt?: Date;
}) {
  return prisma.heroSlide.create({ data });
}

export async function updateSlide(
  id: string,
  data: {
    title?: string;
    subtitle?: string | null;
    ctaText?: string | null;
    ctaUrl?: string | null;
    imageUrl?: string | null;
    imagePosition?: string;
    isPinned?: boolean;
    sortOrder?: number;
    startsAt?: Date | null;
    endsAt?: Date | null;
  }
) {
  return prisma.heroSlide.update({ where: { id }, data });
}

export async function togglePin(id: string, isPinned: boolean) {
  return prisma.heroSlide.update({ where: { id }, data: { isPinned } });
}

export async function deleteSlide(id: string) {
  return prisma.heroSlide.delete({ where: { id } });
}

export async function deleteSlidesByType(types: string[]) {
  return prisma.heroSlide.deleteMany({
    where: { slideType: { in: types } },
  });
}

// ── Ranking queries ─────────────────────────────────────────────────────────

export async function findActiveProfessionalsForRanking() {
  return prisma.professional.findMany({
    where: { activo: true },
    select: {
      id: true,
      slug: true,
      nombre: true,
      apellido: true,
      oficios: true,
      descripcion: true,
      ratingAvg: true,
      ratingCount: true,
      recommendations: true,
      foto: true,
      createdAt: true,
    },
  });
}

export async function findActiveComerciosForRanking() {
  return prisma.comercio.findMany({
    where: { activo: true },
    select: {
      id: true,
      slug: true,
      nombre: true,
      rubro: true,
      descripcion: true,
      ratingAvg: true,
      ratingCount: true,
      recommendations: true,
      foto: true,
      logo: true,
      isPremium: true,
      createdAt: true,
    },
  });
}

export async function findMaxRatingCount(table: "professional" | "comercio") {
  if (table === "professional") {
    const result = await prisma.professional.aggregate({
      _max: { ratingCount: true },
      where: { activo: true },
    });
    return result._max.ratingCount ?? 1;
  }
  const result = await prisma.comercio.aggregate({
    _max: { ratingCount: true },
    where: { activo: true },
  });
  return result._max.ratingCount ?? 1;
}
