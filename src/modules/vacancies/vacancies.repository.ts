import { prisma } from "../../lib/prisma";

const COMERCIO_SELECT = { nombre: true, slug: true, foto: true, rubro: true } as const;
const COMERCIO_DETAIL_SELECT = { nombre: true, slug: true, foto: true, rubro: true, barrio: true, whatsapp: true } as const;

// ── Vacantes ──────────────────────────────────────────────────────────────────

export async function findVacantes(filters: { barrio?: string; habilidad?: string }) {
  return prisma.vacante.findMany({
    where: {
      activa: true,
      ...(filters.barrio    ? { barrio: { contains: filters.barrio, mode: "insensitive" } } : {}),
      ...(filters.habilidad ? { habilidades: { has: filters.habilidad } }                   : {}),
    },
    include: { comercio: { select: COMERCIO_SELECT } },
    orderBy: { createdAt: "desc" },
  });
}

export async function findVacanteById(id: string) {
  return prisma.vacante.findUnique({
    where: { id },
    include: { comercio: { select: COMERCIO_DETAIL_SELECT } },
  });
}

export async function findVacanteByIdOnly(id: string) {
  return prisma.vacante.findUnique({ where: { id }, select: { id: true, comercioId: true, activa: true } });
}

export async function findComercioByClerkId(clerkUserId: string) {
  return prisma.comercio.findUnique({ where: { clerkUserId }, select: { id: true, clerkUserId: true } });
}

export async function findMisVacantes(comercioId: string) {
  return prisma.vacante.findMany({
    where: { comercioId },
    orderBy: { createdAt: "desc" },
  });
}

export async function createVacante(data: {
  comercioId: string;
  titulo: string;
  descripcion: string;
  habilidades: string[];
  barrio?: string;
  horario?: string;
  salario?: string;
  modalidad?: string;
}) {
  return prisma.vacante.create({
    data,
    include: { comercio: { select: COMERCIO_SELECT } },
  });
}

export async function updateVacante(id: string, data: Record<string, unknown>) {
  return prisma.vacante.update({ where: { id }, data });
}

export async function deleteVacante(id: string) {
  return prisma.vacante.delete({ where: { id } });
}

// ── Conversaciones ────────────────────────────────────────────────────────────

export async function findConversacionesByComercio(vacanteIds: string[]) {
  return prisma.vacanteConversation.findMany({
    where: { vacanteId: { in: vacanteIds } },
    include: {
      vacante: { select: { titulo: true } },
      Message: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
  });
}

export async function findConversacionById(id: string) {
  return prisma.vacanteConversation.findUnique({
    where: { id },
    include: {
      Message: { orderBy: { createdAt: "asc" } },
      vacante: {
        include: { comercio: { select: { clerkUserId: true, nombre: true, slug: true, foto: true, whatsapp: true } } },
      },
    },
  });
}

export async function findConversacionWithComercio(id: string) {
  return prisma.vacanteConversation.findUnique({
    where: { id },
    include: { vacante: { include: { comercio: { select: { clerkUserId: true } } } } },
  });
}

export async function createConversacion(data: {
  vacanteId: string;
  clientToken: string;
  clientName?: string;
  mensaje: string;
}) {
  return prisma.vacanteConversation.create({
    data: {
      vacanteId: data.vacanteId,
      clientToken: data.clientToken,
      clientName: data.clientName,
      Message: { create: { senderType: "client", content: data.mensaje } },
    },
    include: { Message: true },
  });
}

export async function createMensaje(conversationId: string, senderType: string, content: string) {
  return prisma.vacanteMessage.create({ data: { conversationId, senderType, content } });
}

export async function touchConversacion(id: string) {
  return prisma.vacanteConversation.update({ where: { id }, data: {} });
}

export async function findVacanteIdsByComercio(comercioId: string) {
  const rows = await prisma.vacante.findMany({ where: { comercioId }, select: { id: true } });
  return rows.map(r => r.id);
}
