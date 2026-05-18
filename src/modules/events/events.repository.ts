import { prisma } from "../../lib/prisma";
import type { Prisma } from "@prisma/client";

const PUBLIC_SELECT = {
  id: true, slug: true, nombre: true, descripcion: true,
  lugar: true, direccion: true, barrio: true,
  fecha: true, fechaFin: true, precio: true, categoria: true,
  banner: true, logo: true, fotos: true,
  activo: true, organizador: true, createdAt: true,
  _count: { select: { comentarios: true } },
} satisfies Prisma.EventoSelect;

export async function findAllEvents(filters: {
  categoria?: string;
  barrio?: string;
  upcoming?: boolean;
}) {
  const now = new Date();
  return prisma.evento.findMany({
    where: {
      activo: true,
      ...(filters.upcoming ? { fecha: { gte: now } } : {}),
      ...(filters.categoria ? { categoria: { equals: filters.categoria, mode: "insensitive" } } : {}),
      ...(filters.barrio    ? { barrio:    { contains: filters.barrio,    mode: "insensitive" } } : {}),
    },
    select: PUBLIC_SELECT,
    orderBy: { fecha: "asc" },
  });
}

export async function findUpcomingEvents(limit = 5) {
  return prisma.evento.findMany({
    where: { activo: true, fecha: { gte: new Date() } },
    select: PUBLIC_SELECT,
    orderBy: { fecha: "asc" },
    take: limit,
  });
}

export async function findEventBySlug(slug: string) {
  return prisma.evento.findUnique({
    where: { slug },
    select: PUBLIC_SELECT,
  });
}

export async function findEventsByClerkId(clerkUserId: string) {
  return prisma.evento.findMany({
    where: { clerkUserId },
    select: PUBLIC_SELECT,
    orderBy: { fecha: "desc" },
  });
}

export async function findEventBySlugAndOwner(slug: string, clerkUserId: string) {
  return prisma.evento.findFirst({ where: { slug, clerkUserId } });
}

export async function createEvent(data: Prisma.EventoCreateInput) {
  return prisma.evento.create({ data });
}

export async function updateEvent(id: string, data: Prisma.EventoUpdateInput) {
  return prisma.evento.update({ where: { id }, data });
}

export async function deleteEvent(id: string) {
  return prisma.evento.delete({ where: { id } });
}

export async function findCommentsByEvent(eventoId: string) {
  return prisma.eventoComentario.findMany({
    where: { eventoId },
    orderBy: { createdAt: "desc" },
    select: { id: true, autorNombre: true, texto: true, createdAt: true },
  });
}

export async function createComment(data: Prisma.EventoComentarioCreateInput) {
  return prisma.eventoComentario.create({ data });
}

// ── Event Photos ──────────────────────────────────────────────────────────────

export async function findPhotosByEvent(eventoId: string) {
  return prisma.eventoFoto.findMany({
    where: { eventoId },
    orderBy: { createdAt: "desc" },
    select: { id: true, url: true, autorNombre: true, likes: true, createdAt: true },
  });
}

export async function createPhoto(data: { eventoId: string; clerkUserId: string; autorNombre: string; url: string }) {
  return prisma.eventoFoto.create({ data });
}

export async function likePhoto(fotoId: string, ipHash: string) {
  return prisma.$transaction(async tx => {
    await tx.eventoFotoLike.create({ data: { fotoId, ipHash } });
    return tx.eventoFoto.update({ where: { id: fotoId }, data: { likes: { increment: 1 } }, select: { likes: true } });
  });
}

// ── Event Likes ───────────────────────────────────────────────────────────────

// ── Sorteo ────────────────────────────────────────────────────────────────────

export async function findParticipante(eventoId: string, clerkUserId: string) {
  return prisma.eventoSorteoParticipante.findUnique({
    where: { eventoId_clerkUserId: { eventoId, clerkUserId } },
  });
}

export async function countParticipantes(eventoId: string) {
  return prisma.eventoSorteoParticipante.count({ where: { eventoId } });
}

export async function createParticipante(eventoId: string, clerkUserId: string, nombre: string) {
  const count  = await prisma.eventoSorteoParticipante.count({ where: { eventoId } });
  const numero = count + 1;
  return prisma.eventoSorteoParticipante.create({
    data: { eventoId, clerkUserId, nombre, numero },
  });
}

export async function findAllParticipantes(eventoId: string) {
  return prisma.eventoSorteoParticipante.findMany({
    where: { eventoId },
    orderBy: { numero: "asc" },
    select: { id: true, numero: true, nombre: true, createdAt: true },
  });
}

export async function setWinner(eventoId: string, numero: number, nombre: string) {
  return prisma.evento.update({
    where: { id: eventoId },
    data: { sorteoEjecutado: true, sorteoGanadorNum: numero, sorteoGanadorNombre: nombre },
  });
}

export async function findEventById(id: string) {
  return prisma.evento.findUnique({ where: { id } });
}

// ── Subscriptions ──────────────────────────────────────────────────────────────

export async function findSubscription(eventoId: string, clerkUserId: string) {
  return prisma.eventoSubscripcion.findUnique({
    where: { eventoId_clerkUserId: { eventoId, clerkUserId } },
  });
}

export async function createSubscription(eventoId: string, clerkUserId: string) {
  return prisma.eventoSubscripcion.create({ data: { eventoId, clerkUserId } });
}

export async function deleteSubscription(eventoId: string, clerkUserId: string) {
  return prisma.eventoSubscripcion.delete({
    where: { eventoId_clerkUserId: { eventoId, clerkUserId } },
  });
}

export async function countSubscribers(eventoId: string) {
  return prisma.eventoSubscripcion.count({ where: { eventoId } });
}

export async function findSubscriberIds(eventoId: string) {
  return prisma.eventoSubscripcion.findMany({
    where: { eventoId },
    select: { clerkUserId: true },
  });
}

// ── Event Likes ───────────────────────────────────────────────────────────────

export async function countEventLikes(eventoId: string) {
  return prisma.recommendation.count({ where: { targetType: "evento", targetId: eventoId } });
}

export async function createEventLike(eventoId: string, ipHash: string) {
  return prisma.recommendation.create({
    data: { targetType: "evento", targetId: eventoId, ipHash },
  });
}
