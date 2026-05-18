import { prisma } from "../../lib/prisma";
import type { Prisma } from "@prisma/client";

// ── Select presets ────────────────────────────────────────────────────────────

const FULL_SELECT = {
  id: true, lat: true, lng: true, category: true, description: true,
  barrio: true, direccion: true, photo: true, photos: true,
  isUrgent: true, createdAt: true, updatedAt: true,
} satisfies Prisma.ReportSelect;

const RECENT_SELECT = {
  id: true, category: true, description: true, barrio: true,
  createdAt: true, isUrgent: true, photo: true,
} satisfies Prisma.ReportSelect;

// ── Reports ───────────────────────────────────────────────────────────────────

export async function findReports(filters: {
  category?: string;
  barrio?: string;
  startDate?: Date;
  endDate?: Date;
}) {
  return prisma.report.findMany({
    where: {
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.barrio   ? { barrio: { contains: filters.barrio, mode: "insensitive" } } : {}),
      ...(filters.startDate || filters.endDate ? {
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate   ? { lte: filters.endDate   } : {}),
        },
      } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: FULL_SELECT,
  });
}

export async function findReportById(id: string) {
  return prisma.report.findUnique({ where: { id }, select: FULL_SELECT });
}

export async function createReport(data: {
  lat: number;
  lng: number;
  category: string;
  description: string;
  barrio: string;
  direccion: string;
  photo: string | null;
  photos: string[];
  isUrgent: boolean;
  createdAt: Date;
}) {
  return prisma.report.create({ data, select: FULL_SELECT });
}

export async function updateReport(id: string, data: Prisma.ReportUpdateInput) {
  return prisma.report.update({ where: { id }, data, select: FULL_SELECT })
    .catch(() => null);
}

export async function deleteReport(id: string) {
  return prisma.report.delete({ where: { id }, select: { id: true } })
    .catch(() => null);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function getStats() {
  const [total, byCategory, byBarrio, recent] = await Promise.all([
    prisma.report.count(),
    prisma.report.groupBy({ by: ["category"], _count: { id: true } }),
    prisma.report.groupBy({
      by: ["barrio"],
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 10,
    }),
    prisma.report.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: RECENT_SELECT,
    }),
  ]);

  return {
    total,
    byCategory: byCategory.map((r) => ({ category: r.category, count: r._count.id })),
    byBarrio:   byBarrio.map((r)   => ({ barrio: r.barrio,       count: r._count.id })),
    recent,
  };
}
