import { prisma } from "../../lib/prisma";
import type { Prisma } from "@prisma/client";

// ── Select presets ────────────────────────────────────────────────────────────

const PUBLIC_SELECT = {
  id: true, nombre: true, rubro: true, slug: true, barrio: true,
  foto: true, logo: true, descripcion: true, activo: true,
  isPremium: true, isFounder: true, createdAt: true, recommendations: true,
  ratingAvg: true, ratingCount: true,
  _count: { select: { subscripciones: true } },
} satisfies Prisma.ComercioSelect;

const ME_SELECT = {
  id: true, nombre: true, rubro: true, slug: true, descripcion: true,
  direccion: true, barrio: true, whatsapp: true, telefono: true,
  horario: true, foto: true, fotos: true, logo: true, activo: true,
  isPremium: true, isFounder: true, createdAt: true, updatedAt: true,
  aceptaEnvios: true, zonaEnvio: true, costoEnvio: true,
  _count: { select: { subscripciones: true } },
  offers: { orderBy: { createdAt: "desc" as const } },
  productos: { orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.ComercioSelect;

// ── Comercio ──────────────────────────────────────────────────────────────────

export async function findAllStoresPublic(filters: {
  barrio?: string;
  rubro?: string;
}) {
  return prisma.comercio.findMany({
    where: {
      activo: true,
      ...(filters.barrio ? { barrio: { contains: filters.barrio, mode: "insensitive" } } : {}),
      ...(filters.rubro  ? { rubro:  { contains: filters.rubro,  mode: "insensitive" } } : {}),
    },
    select: PUBLIC_SELECT,
  });
}

export async function findStoreBySlug(slug: string) {
  return prisma.comercio.findUnique({
    where: { slug },
    select: {
      ...PUBLIC_SELECT,
      whatsapp: true, telefono: true, horario: true, direccion: true,
      fotos: true, aceptaEnvios: true, zonaEnvio: true, costoEnvio: true,
      offers: {
        where: { activa: true },
        select: { id: true, titulo: true, descripcion: true, precio: true, foto: true, validaHasta: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
      productos: {
        where: { activo: true },
        select: { id: true, nombre: true, tipo: true, descripcion: true, precio: true, foto: true, stock: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

export async function findStoreByClerkId(clerkUserId: string) {
  return prisma.comercio.findUnique({ where: { clerkUserId } });
}

export async function findMyStoreByClerkId(clerkUserId: string) {
  return prisma.comercio.findUnique({
    where: { clerkUserId },
    select: ME_SELECT,
  });
}

export async function findStoreSlugByClerkId(clerkUserId: string) {
  return prisma.comercio.findUnique({
    where: { clerkUserId },
    select: { id: true, slug: true },
  });
}

export async function countStores() {
  return prisma.comercio.count();
}

export async function createStore(data: Prisma.ComercioCreateInput) {
  return prisma.comercio.create({ data });
}

export async function updateStoreByClerkId(
  clerkUserId: string,
  data: Prisma.ComercioUpdateInput
) {
  return prisma.comercio.update({ where: { clerkUserId }, data });
}

export async function incrementRecommendation(id: string) {
  return prisma.comercio.update({
    where: { id },
    data: { recommendations: { increment: 1 } },
    select: { recommendations: true },
  });
}

export async function updateStoreRating(id: string, avg: number, count: number) {
  return prisma.comercio.update({
    where: { id },
    data: { ratingAvg: avg, ratingCount: count },
  });
}

// ── Offers ────────────────────────────────────────────────────────────────────

export async function findOffersByStoreId(storeId: string) {
  return prisma.comercioOffer.findMany({
    where: { comercioId: storeId, activa: true },
    select: { id: true, titulo: true, descripcion: true, precio: true, foto: true, validaHasta: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function createOffer(data: Prisma.ComercioOfferCreateInput) {
  return prisma.comercioOffer.create({ data });
}

export async function findOfferById(id: string) {
  return prisma.comercioOffer.findUnique({ where: { id } });
}

export async function updateOffer(id: string, data: Prisma.ComercioOfferUpdateInput) {
  return prisma.comercioOffer.update({ where: { id }, data });
}

export async function deleteOffer(id: string) {
  return prisma.comercioOffer.delete({ where: { id } });
}

// ── Productos ─────────────────────────────────────────────────────────────────

export async function createProduct(data: Prisma.ProductoCreateInput) {
  return prisma.producto.create({ data });
}

export async function findProductById(id: string) {
  return prisma.producto.findUnique({ where: { id } });
}

export async function updateProduct(id: string, data: Prisma.ProductoUpdateInput) {
  return prisma.producto.update({ where: { id }, data });
}

export async function deleteProduct(id: string) {
  return prisma.producto.delete({ where: { id } });
}

export async function searchProducts(q: string, limit = 10) {
  return prisma.producto.findMany({
    where: {
      activo: true,
      comercio: { activo: true },
      OR: [
        { nombre:      { contains: q, mode: "insensitive" } },
        { descripcion: { contains: q, mode: "insensitive" } },
        { tipo:        { contains: q, mode: "insensitive" } },
        { comercio: { nombre: { contains: q, mode: "insensitive" } } },
        { comercio: { rubro:  { contains: q, mode: "insensitive" } } },
      ],
    },
    take: limit,
    orderBy: { createdAt: "desc" },
    select: {
      id: true, nombre: true, tipo: true, descripcion: true, precio: true, foto: true,
      comercio: { select: { nombre: true, slug: true, logo: true, foto: true, rubro: true } },
    },
  });
}

export async function findRecentProducts(limit = 20) {
  return prisma.producto.findMany({
    where: { activo: true, comercio: { activo: true } },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 40),
    select: {
      id: true, nombre: true, tipo: true, descripcion: true, precio: true, foto: true, createdAt: true,
      comercio: { select: { nombre: true, slug: true, logo: true, foto: true, rubro: true } },
    },
  });
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function findReviewsByStoreId(storeId: string) {
  return prisma.comercioReview.findMany({
    where: { comercioId: storeId },
    orderBy: { createdAt: "desc" },
    select: { id: true, score: true, createdAt: true },
  });
}

export async function upsertReview(comercioId: string, clerkUserId: string, score: number) {
  return prisma.comercioReview.upsert({
    where: { comercioId_clerkUserId: { comercioId, clerkUserId } },
    update: { score },
    create: { comercioId, clerkUserId, score },
  });
}

export async function aggregateReviews(comercioId: string) {
  return prisma.comercioReview.aggregate({
    where: { comercioId },
    _avg: { score: true },
    _count: { score: true },
  });
}

// ── Recommendation (dedup por IP hash) ───────────────────────────────────────

export async function createRecommendation(targetId: string, ipHash: string) {
  return prisma.recommendation.create({
    data: { targetType: "comercio", targetId, ipHash },
  });
}

// ── Sumate / Suscripciones ────────────────────────────────────────────────────

export async function findSubscription(comercioId: string, clerkUserId: string) {
  return prisma.comercioSubscripcion.findUnique({
    where: { comercioId_clerkUserId: { comercioId, clerkUserId } },
  });
}

export async function countSubscribers(comercioId: string) {
  return prisma.comercioSubscripcion.count({ where: { comercioId } });
}

export async function createSubscription(comercioId: string, clerkUserId: string) {
  return prisma.comercioSubscripcion.create({
    data: { comercioId, clerkUserId },
  });
}

export async function deleteSubscription(comercioId: string, clerkUserId: string) {
  return prisma.comercioSubscripcion.delete({
    where: { comercioId_clerkUserId: { comercioId, clerkUserId } },
  });
}

// ── Analytics / Events ────────────────────────────────────────────────────────

const ALLOWED_EVENT_TYPES = ["profile_view", "whatsapp_click", "product_view", "offer_view"] as const;
export type EventType = typeof ALLOWED_EVENT_TYPES[number];

export function isAllowedEventType(type: string): type is EventType {
  return ALLOWED_EVENT_TYPES.includes(type as EventType);
}

export async function upsertEventDay(comercioId: string, type: EventType, date: string) {
  return prisma.comercioEventDay.upsert({
    where: { comercioId_type_date: { comercioId, type, date } },
    create: { comercioId, type, date, count: 1 },
    update: { count: { increment: 1 } },
  });
}

export async function findEventsSince(comercioId: string, since: string) {
  return prisma.comercioEventDay.findMany({
    where: { comercioId, date: { gte: since } },
    orderBy: { date: "asc" },
  });
}

// ── AI Usage ──────────────────────────────────────────────────────────────────

export async function getAiUsageToday(key: string, date: Date) {
  return prisma.productAiUsageDay.findUnique({
    where: { key_date: { key, date } },
    select: { count: true },
  });
}

export async function incrementAiUsage(key: string, date: Date) {
  return prisma.productAiUsageDay.upsert({
    where: { key_date: { key, date } },
    create: { key, date, count: 1 },
    update: { count: { increment: 1 } },
  });
}
