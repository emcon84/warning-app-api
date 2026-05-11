import { prisma } from "../../lib/prisma";
import type { Prisma } from "@prisma/client";

// ── Select presets ────────────────────────────────────────────────────────────

const FARMACIA_SELECT = {
  id: true, nombre: true, direccion: true, telefono: true,
  lat: true, lng: true, activo: true, createdAt: true,
} satisfies Prisma.FarmaciaSelect;

export type FarmaciaRow = Prisma.FarmaciaGetPayload<{ select: typeof FARMACIA_SELECT }>;

// ── Farmacias ─────────────────────────────────────────────────────────────────

export async function findActiveFarmacias() {
  return prisma.farmacia.findMany({
    where: { activo: true },
    orderBy: { nombre: "asc" },
    select: FARMACIA_SELECT,
  });
}

export async function updateFarmacia(id: string, data: Prisma.FarmaciaUpdateInput) {
  return prisma.farmacia.update({ where: { id }, data, select: FARMACIA_SELECT })
    .catch(() => null);
}
