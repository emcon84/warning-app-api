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
