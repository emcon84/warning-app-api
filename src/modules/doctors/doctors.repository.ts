import { prisma } from "../../lib/prisma";
import type { Prisma } from "@prisma/client";
import { OBRAS_SOCIALES } from "../../../lib/constants";

// ── Select presets ────────────────────────────────────────────────────────────

const DOCTOR_SELECT = {
  id: true, nombre: true, especialidad: true, direccion: true,
  barrio: true, ciudad: true, telefono: true, whatsapp: true,
  lat: true, lng: true, obrasSociales: true, activo: true,
  iapos: true, createdAt: true,
} satisfies Prisma.DoctorSelect;

const CONFIRMACION_SELECT = {
  id: true, obraSocial: true, acepta: true, createdAt: true,
} satisfies Prisma.ConfirmacionSelect;

const DISPONIBILIDAD_SELECT = {
  id: true, doctorId: true, dias: true, horario: true,
  tipoTurno: true, obraSocial: true, nota: true,
  createdAt: true, expiresAt: true,
} satisfies Prisma.TurnoDisponibilidadSelect;

// ── Doctors ───────────────────────────────────────────────────────────────────

export async function findDoctors(filters: {
  especialidad?: string;
  obraSocial?: string;
  ciudad?: string;
  iapos?: boolean;
}) {
  return prisma.doctor.findMany({
    where: {
      activo: true,
      ...(filters.iapos       ? { iapos: true }                                                    : {}),
      ...(filters.especialidad ? { especialidad: filters.especialidad }                            : {}),
      ...(filters.ciudad       ? { ciudad: { contains: filters.ciudad, mode: "insensitive" } }    : {}),
      ...(filters.obraSocial   ? { obrasSociales: { has: filters.obraSocial } }                   : {}),
    },
    orderBy: { nombre: "asc" },
    select: {
      ...DOCTOR_SELECT,
      Confirmacion: { orderBy: { createdAt: "desc" }, take: 10, select: CONFIRMACION_SELECT },
    },
  });
}

export async function findDoctorById(id: string) {
  return prisma.doctor.findUnique({
    where: { id },
    select: {
      ...DOCTOR_SELECT,
      Confirmacion: { orderBy: { createdAt: "desc" }, select: CONFIRMACION_SELECT },
    },
  });
}

export async function createDoctor(data: {
  nombre: string;
  especialidad: string;
  direccion: string;
  barrio: string;
  ciudad: string;
  telefono?: string;
  whatsapp?: string;
  lat: number;
  lng: number;
  obrasSociales: string[];
}) {
  return prisma.doctor.create({
    data: { ...data, updatedAt: new Date() },
    select: DOCTOR_SELECT,
  });
}

export async function updateDoctor(id: string, data: Prisma.DoctorUpdateInput) {
  return prisma.doctor.update({ where: { id }, data, select: DOCTOR_SELECT })
    .catch(() => null);
}

export async function deleteDoctor(id: string) {
  return prisma.doctor.delete({ where: { id }, select: { id: true } })
    .catch(() => null);
}

// ── Confirmaciones ────────────────────────────────────────────────────────────

export async function findDoctorId(id: string) {
  return prisma.doctor.findUnique({ where: { id }, select: { id: true } });
}

export async function createConfirmacion(data: {
  doctorId: string;
  obraSocial: string;
  acepta: boolean;
}) {
  return prisma.confirmacion.create({ data, select: CONFIRMACION_SELECT });
}

export async function recalcObrasSociales(doctorId: string): Promise<string[]> {
  const results = await Promise.all(
    OBRAS_SOCIALES.map((os) =>
      prisma.confirmacion.findMany({
        where: { doctorId, obraSocial: os },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { acepta: true },
      })
    )
  );

  return OBRAS_SOCIALES.filter((_, i) => {
    const rows = results[i];
    return rows.length > 0 && rows.filter((r) => r.acepta).length > rows.length / 2;
  });
}

export async function updateDoctorObrasSociales(id: string, obrasSociales: string[]) {
  return prisma.doctor.update({
    where: { id },
    data: { obrasSociales },
    select: DOCTOR_SELECT,
  });
}

// ── Disponibilidad ────────────────────────────────────────────────────────────

export async function findDisponibilidad(doctorId: string) {
  return prisma.turnoDisponibilidad.findMany({
    where: { doctorId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: DISPONIBILIDAD_SELECT,
  });
}

export async function createDisponibilidad(data: {
  doctorId: string;
  dias: string[];
  horario: string;
  tipoTurno: string;
  obraSocial: string;
  nota?: string;
  expiresAt: Date;
}) {
  return prisma.turnoDisponibilidad.create({ data, select: DISPONIBILIDAD_SELECT });
}
