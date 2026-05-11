import { prisma } from "../../lib/prisma";
import type { Prisma } from "@prisma/client";

// ── Select presets ────────────────────────────────────────────────────────────

const PUBLIC_SELECT = {
  id: true, nombre: true, apellido: true, slug: true, habilidades: true,
  barrio: true, foto: true, descripcion: true, disponible: true,
  activo: true, createdAt: true,
} satisfies Prisma.EmpleadoSelect;

const ME_SELECT = {
  id: true, nombre: true, apellido: true, slug: true, habilidades: true,
  descripcion: true, barrio: true, whatsapp: true, foto: true,
  disponible: true, activo: true, createdAt: true, updatedAt: true,
} satisfies Prisma.EmpleadoSelect;

// ── Empleados ─────────────────────────────────────────────────────────────────

export async function findEmpleados(filters: { barrio?: string; habilidad?: string }) {
  return prisma.empleado.findMany({
    where: {
      activo: true,
      ...(filters.barrio   ? { barrio: { contains: filters.barrio, mode: "insensitive" } } : {}),
      ...(filters.habilidad ? { habilidades: { has: filters.habilidad } } : {}),
    },
    select: PUBLIC_SELECT,
    orderBy: { createdAt: "desc" },
  });
}

export async function findEmpleadoByClerkId(clerkUserId: string) {
  return prisma.empleado.findUnique({ where: { clerkUserId }, select: ME_SELECT });
}

export async function findEmpleadoByClerkIdFull(clerkUserId: string) {
  return prisma.empleado.findUnique({ where: { clerkUserId } });
}

export async function findEmpleadoBySlug(slug: string) {
  return prisma.empleado.findUnique({ where: { slug }, select: PUBLIC_SELECT });
}

export async function createEmpleado(data: {
  clerkUserId: string;
  nombre: string;
  apellido: string;
  slug: string;
  habilidades: string[];
  descripcion?: string;
  barrio?: string;
  whatsapp?: string;
  foto?: string;
}) {
  return prisma.empleado.create({ data });
}

export async function updateEmpleado(clerkUserId: string, data: Prisma.EmpleadoUpdateInput) {
  return prisma.empleado.update({ where: { clerkUserId }, data });
}

// ── Conversaciones ────────────────────────────────────────────────────────────

export async function findConversacionesByEmpleado(empleadoId: string) {
  return prisma.empleadoConversation.findMany({
    where: { empleadoId },
    include: { Message: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { updatedAt: "desc" },
  });
}

export async function findConversacionById(id: string) {
  return prisma.empleadoConversation.findUnique({
    where: { id },
    include: {
      Message: { orderBy: { createdAt: "asc" } },
      empleado: { select: { slug: true, nombre: true, apellido: true, foto: true, whatsapp: true, clerkUserId: true } },
    },
  });
}

export async function findConversacionWithEmpleado(id: string) {
  return prisma.empleadoConversation.findUnique({
    where: { id },
    include: { empleado: { select: { clerkUserId: true } } },
  });
}

export async function createConversacion(data: {
  empleadoId: string;
  clientToken: string;
  clientName?: string;
  mensaje: string;
}) {
  return prisma.empleadoConversation.create({
    data: {
      empleadoId: data.empleadoId,
      clientToken: data.clientToken,
      clientName: data.clientName,
      Message: { create: { senderType: "client", content: data.mensaje } },
    },
    include: { Message: true },
  });
}

export async function createMensaje(conversationId: string, senderType: string, content: string) {
  return prisma.empleadoMessage.create({
    data: { conversationId, senderType, content },
  });
}

export async function touchConversacion(id: string) {
  return prisma.empleadoConversation.update({ where: { id }, data: {} });
}
