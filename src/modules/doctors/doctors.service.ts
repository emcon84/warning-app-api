import * as repo from "./doctors.repository";

// ── Doctors ───────────────────────────────────────────────────────────────────

export async function listDoctors(params: {
  especialidad?: string;
  obraSocial?: string;
  ciudad?: string;
  iapos?: string;
}) {
  return repo.findDoctors({
    especialidad: params.especialidad || undefined,
    obraSocial:   params.obraSocial   || undefined,
    ciudad:        params.ciudad        || undefined,
    iapos:         params.iapos === "true",
  });
}

export async function getDoctor(id: string) {
  const doctor = await repo.findDoctorById(id);
  if (!doctor) throw { status: 404, message: "Médico no encontrado" };
  return doctor;
}

export async function createDoctor(body: Record<string, unknown>) {
  const nombre      = (body.nombre      as string | undefined)?.trim();
  const especialidad = (body.especialidad as string | undefined)?.trim();
  const direccion   = (body.direccion   as string | undefined)?.trim();
  const lat         = typeof body.lat === "number" ? body.lat : parseFloat(body.lat as string);
  const lng         = typeof body.lng === "number" ? body.lng : parseFloat(body.lng as string);

  if (!nombre || !especialidad || !direccion || isNaN(lat) || isNaN(lng)) {
    throw { status: 400, message: "Faltan campos requeridos: nombre, especialidad, direccion, lat, lng" };
  }

  return repo.createDoctor({
    nombre,
    especialidad,
    direccion,
    barrio:        ((body.barrio  as string | undefined) ?? "").trim(),
    ciudad:        ((body.ciudad  as string | undefined) ?? "Reconquista").trim(),
    telefono:      (body.telefono as string | undefined) || undefined,
    whatsapp:      (body.whatsapp as string | undefined) || undefined,
    lat,
    lng,
    obrasSociales: Array.isArray(body.obrasSociales) ? (body.obrasSociales as string[]) : [],
  });
}

export async function updateDoctor(id: string, body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  if (body.nombre        !== undefined) data.nombre        = String(body.nombre).trim();
  if (body.especialidad  !== undefined) data.especialidad  = String(body.especialidad).trim();
  if (body.direccion     !== undefined) data.direccion     = String(body.direccion).trim();
  if (body.barrio        !== undefined) data.barrio        = String(body.barrio).trim();
  if (body.ciudad        !== undefined) data.ciudad        = String(body.ciudad).trim();
  if (body.telefono      !== undefined) data.telefono      = body.telefono || null;
  if (body.whatsapp      !== undefined) data.whatsapp      = body.whatsapp || null;
  if (body.lat           !== undefined) data.lat           = Number(body.lat);
  if (body.lng           !== undefined) data.lng           = Number(body.lng);
  if (body.obrasSociales !== undefined) data.obrasSociales = body.obrasSociales;
  if (body.activo        !== undefined) data.activo        = Boolean(body.activo);

  const doctor = await repo.updateDoctor(id, data);
  if (!doctor) throw { status: 404, message: "Médico no encontrado" };
  return doctor;
}

export async function deleteDoctor(id: string) {
  const deleted = await repo.deleteDoctor(id);
  if (!deleted) throw { status: 404, message: "Médico no encontrado" };
  return { message: "Médico eliminado" };
}

// ── Confirmaciones ────────────────────────────────────────────────────────────

export async function addConfirmacion(
  doctorId: string,
  body: Record<string, unknown>
) {
  const obraSocial = (body.obraSocial as string | undefined)?.trim();
  const acepta     = body.acepta;

  if (!obraSocial || acepta === undefined) {
    throw { status: 400, message: "Faltan campos: obraSocial, acepta" };
  }

  const exists = await repo.findDoctorId(doctorId);
  if (!exists) throw { status: 404, message: "Médico no encontrado" };

  await repo.createConfirmacion({ doctorId, obraSocial, acepta: Boolean(acepta) });

  const updatedObrasSociales = await repo.recalcObrasSociales(doctorId);
  return repo.updateDoctorObrasSociales(doctorId, updatedObrasSociales);
}

// ── Disponibilidad ────────────────────────────────────────────────────────────

export async function getDisponibilidad(doctorId: string) {
  return repo.findDisponibilidad(doctorId);
}

export async function addDisponibilidad(
  doctorId: string,
  body: Record<string, unknown>
) {
  const dias      = body.dias;
  const horario   = (body.horario   as string | undefined)?.trim();
  const tipoTurno = (body.tipoTurno as string | undefined)?.trim();

  if (!Array.isArray(dias) || dias.length === 0 || !horario || !tipoTurno) {
    throw { status: 400, message: "Faltan campos requeridos: dias, horario, tipoTurno" };
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  return repo.createDisponibilidad({
    doctorId,
    dias:       dias as string[],
    horario,
    tipoTurno,
    obraSocial: ((body.obraSocial as string | undefined) ?? "Todas").trim(),
    nota:       (body.nota as string | undefined) || undefined,
    expiresAt,
  });
}
