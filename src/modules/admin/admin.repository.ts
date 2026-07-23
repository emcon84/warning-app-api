import { prisma } from "../../lib/prisma";
import type { Prisma } from "@prisma/client";

// ── Select presets ────────────────────────────────────────────────────────────

const ADMIN_PROFESSIONAL_SELECT = {
  id: true, nombre: true, apellido: true, slug: true, tipo: true,
  oficios: true, barrio: true, foto: true, activo: true,
  ratingAvg: true, ratingCount: true, createdAt: true,
} satisfies Prisma.ProfessionalSelect;

const ADMIN_STORE_SELECT = {
  id: true, nombre: true, rubro: true, slug: true, barrio: true,
  foto: true, logo: true, activo: true, isPremium: true, createdAt: true,
} satisfies Prisma.ComercioSelect;

// ── Professionals ─────────────────────────────────────────────────────────────

export async function findAllProfessionals() {
  return prisma.professional.findMany({
    orderBy: { createdAt: "desc" },
    select: ADMIN_PROFESSIONAL_SELECT,
  });
}

export async function deleteProfessional(id: string) {
  return prisma.professional.delete({ where: { id } });
}

export async function updateProfessionalPin(id: string, pinHash: string) {
  return prisma.professional.update({ where: { id }, data: { pin: pinHash, updatedAt: new Date() } });
}

// ── Reports ───────────────────────────────────────────────────────────────────

export async function findAllReports() {
  return prisma.report.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function deleteReport(id: string) {
  return prisma.report.delete({ where: { id } });
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function findAllReviews(onlyReported: boolean) {
  return prisma.publicReview.findMany({
    where: onlyReported ? { reported: true } : undefined,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      professional: { select: { nombre: true, apellido: true, slug: true } },
    },
  });
}

export async function deleteReview(id: string) {
  return prisma.publicReview.delete({ where: { id } });
}

// ── Stores ────────────────────────────────────────────────────────────────────

export async function findAllStores() {
  return prisma.comercio.findMany({
    orderBy: { createdAt: "desc" },
    select: ADMIN_STORE_SELECT,
  });
}

export async function updateStore(id: string, data: { isPremium?: boolean; isFounder?: boolean }) {
  return prisma.comercio.update({ where: { id }, data });
}

export async function deleteStore(id: string) {
  return prisma.comercio.delete({ where: { id } });
}

// ── Hero Slide Backgrounds (removed — model dropped) ───────────────────────
