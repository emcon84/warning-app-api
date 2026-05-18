import { prisma } from "../../lib/prisma";
import type { Prisma } from "@prisma/client";

// ── Select presets ────────────────────────────────────────────────────────────

export const PUBLIC_LIST_SELECT = {
  id: true, nombre: true, apellido: true, slug: true, tipo: true,
  oficios: true, barrio: true, foto: true, disponible: true,
  ratingAvg: true, ratingCount: true, recommendations: true,
} satisfies Prisma.ProfessionalSelect;

const REVIEW_SELECT = {
  id: true, professionalId: true, clerkUserId: true, reviewerName: true,
  score: true, comment: true, reported: true, reportedAt: true, createdAt: true,
} satisfies Prisma.PublicReviewSelect;

// ── Professionals ─────────────────────────────────────────────────────────────

export async function findProfessionals(filters: {
  oficio?: string;
  barrio?: string;
  tipo?: string;
}) {
  return prisma.professional.findMany({
    where: {
      activo: true,
      ...(filters.oficio ? { oficios: { has: filters.oficio } } : {}),
      ...(filters.barrio ? { barrio: filters.barrio } : {}),
      ...(filters.tipo   ? { tipo: filters.tipo }     : {}),
    },
    select: PUBLIC_LIST_SELECT,
  });
}

export async function findProfessionalBySlug(slug: string) {
  return prisma.professional.findUnique({ where: { slug } });
}

export async function findProfessionalBySlugPublic(slug: string) {
  return prisma.professional.findUnique({
    where: { slug },
    include: {
      Rating: {
        where: { scoreByClient: { not: null } },
        select: { scoreByClient: true, commentByClient: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });
}

export async function findProfessionalById(id: string) {
  return prisma.professional.findUnique({ where: { id } });
}

export async function findProfessionalByClerkId(clerkUserId: string) {
  return prisma.professional.findUnique({ where: { clerkUserId } });
}

export async function findProfessionalByWhatsapp(waClean: string) {
  return prisma.professional.findFirst({
    where: {
      OR: [
        { whatsapp: waClean },
        { whatsapp: "549" + waClean.slice(-10) },
      ],
    },
  });
}

export async function findProOwner(clerkUserId: string | null, proCode: string | undefined) {
  if (clerkUserId) return prisma.professional.findUnique({ where: { clerkUserId }, select: { id: true } });
  if (proCode)     return prisma.professional.findUnique({ where: { id: proCode  }, select: { id: true } });
  return null;
}

export async function findProWithFotos(id: string) {
  return prisma.professional.findUnique({ where: { id }, select: { id: true, fotos: true } });
}

export async function createProfessional(data: {
  clerkUserId: string | null;
  nombre: string;
  apellido: string;
  slug: string;
  tipo: string | null;
  oficios: string[];
  descripcion?: string;
  telefono?: string;
  whatsapp: string;
  pin: string | null;
  updatedAt: Date;
}) {
  return prisma.professional.create({ data });
}

export async function updateProfessional(id: string, data: Prisma.ProfessionalUpdateInput) {
  return prisma.professional.update({ where: { id }, data });
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function findReviewsByPro(professionalId: string) {
  return prisma.publicReview.findMany({
    where: { professionalId, reported: false },
    orderBy: { createdAt: "desc" },
    select: REVIEW_SELECT,
  });
}

export async function findReviewByUserAndPro(professionalId: string, clerkUserId: string) {
  return prisma.publicReview.findFirst({ where: { professionalId, clerkUserId } });
}

export async function createReview(data: {
  professionalId: string;
  clerkUserId: string;
  reviewerName: string;
  score: number;
  comment: string;
}) {
  return prisma.publicReview.create({ data, select: REVIEW_SELECT });
}

export async function recalcProfessionalRating(professionalId: string) {
  const agg = await prisma.publicReview.aggregate({
    where: { professionalId, reported: false },
    _avg: { score: true },
    _count: { score: true },
  });
  return prisma.professional.update({
    where: { id: professionalId },
    data: {
      ratingAvg: Math.round((agg._avg.score ?? 0) * 10) / 10,
      ratingCount: agg._count.score,
      updatedAt: new Date(),
    },
  });
}

export async function findReviewById(id: string) {
  return prisma.publicReview.findUnique({ where: { id }, select: REVIEW_SELECT });
}

export async function reportReview(id: string) {
  return prisma.publicReview.update({
    where: { id },
    data: { reported: true, reportedAt: new Date() },
  });
}

// ── Recommendations ───────────────────────────────────────────────────────────

export async function createRecommendation(data: {
  targetType: string;
  targetId: string;
  ipHash: string;
}) {
  return prisma.recommendation.create({ data });
}

export async function incrementRecommendations(id: string) {
  return prisma.professional.update({
    where: { id },
    data: { recommendations: { increment: 1 }, updatedAt: new Date() },
    select: { recommendations: true },
  });
}
