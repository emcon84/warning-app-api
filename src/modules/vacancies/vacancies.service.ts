import { sanitizeText } from "../../shared/sanitize";
import { sendPushToUser, sendPushToClientToken } from "../../shared/push";
import * as repo from "./vacancies.repository";

// ── Vacantes ──────────────────────────────────────────────────────────────────

export async function listVacantes(params: { barrio?: string; habilidad?: string }) {
  return repo.findVacantes({
    barrio:    params.barrio    || undefined,
    habilidad: params.habilidad || undefined,
  });
}

export async function getVacante(id: string) {
  const v = await repo.findVacanteById(id);
  if (!v || !v.activa) throw { status: 404, message: "Vacante no encontrada" };
  return v;
}

export async function getMisVacantes(clerkUserId: string) {
  const comercio = await repo.findComercioByClerkId(clerkUserId);
  if (!comercio) throw { status: 404, message: "No tenés un comercio registrado" };
  return repo.findMisVacantes(comercio.id);
}

export async function createVacante(clerkUserId: string, body: Record<string, unknown>) {
  const comercio = await repo.findComercioByClerkId(clerkUserId);
  if (!comercio) throw { status: 403, message: "Necesitás tener un perfil de comercio para publicar vacantes" };

  const titulo      = sanitizeText(body.titulo as string, 150);
  const descripcion = sanitizeText(body.descripcion as string, 1000);
  if (!titulo || !descripcion) throw { status: 400, message: "Faltan campos: titulo, descripcion" };

  const habilidades = Array.isArray(body.habilidades)
    ? (body.habilidades as string[]).map(h => sanitizeText(h, 60)).filter(Boolean)
    : [];
  const barrio    = sanitizeText(body.barrio    as string, 100) || undefined;
  const horario   = sanitizeText(body.horario   as string, 150) || undefined;
  const salario   = sanitizeText(body.salario   as string, 80)  || undefined;
  const modalidad = sanitizeText(body.modalidad as string, 60)  || undefined;

  return repo.createVacante({ comercioId: comercio.id, titulo, descripcion, habilidades, barrio, horario, salario, modalidad });
}

async function resolveVacanteOwnership(clerkUserId: string, vacanteId: string) {
  const comercio = await repo.findComercioByClerkId(clerkUserId);
  if (!comercio) throw { status: 403, message: "No autorizado" };
  const vacante = await repo.findVacanteByIdOnly(vacanteId);
  if (!vacante || vacante.comercioId !== comercio.id) throw { status: 404, message: "Vacante no encontrada" };
  return vacante;
}

export async function updateVacante(clerkUserId: string, vacanteId: string, body: Record<string, unknown>) {
  await resolveVacanteOwnership(clerkUserId, vacanteId);

  const data: Record<string, unknown> = {};
  if (body.titulo)       data.titulo       = sanitizeText(body.titulo as string, 150);
  if (body.descripcion)  data.descripcion  = sanitizeText(body.descripcion as string, 1000);
  if (body.habilidades)  data.habilidades  = (body.habilidades as string[]).map(h => sanitizeText(h, 60)).filter(Boolean);
  if (body.barrio      !== undefined) data.barrio    = sanitizeText(body.barrio    as string, 100)  || null;
  if (body.horario     !== undefined) data.horario   = sanitizeText(body.horario   as string, 150)  || null;
  if (body.salario     !== undefined) data.salario   = sanitizeText(body.salario   as string, 80)   || null;
  if (body.modalidad   !== undefined) data.modalidad = sanitizeText(body.modalidad as string, 60)   || null;
  if (body.activa      !== undefined) data.activa    = body.activa === true || body.activa === "true";

  return repo.updateVacante(vacanteId, data);
}

export async function deleteVacante(clerkUserId: string, vacanteId: string) {
  await resolveVacanteOwnership(clerkUserId, vacanteId);
  await repo.deleteVacante(vacanteId);
  return { ok: true };
}

// ── Conversaciones ────────────────────────────────────────────────────────────

export async function getMisConversaciones(clerkUserId: string) {
  const comercio = await repo.findComercioByClerkId(clerkUserId);
  if (!comercio) throw { status: 404, message: "No tenés un comercio registrado" };
  const vacanteIds = await repo.findVacanteIdsByComercio(comercio.id);
  return repo.findConversacionesByComercio(vacanteIds);
}

export async function getConversacion(
  convId: string,
  clerkUserId: string | null,
  clientToken: string | null
) {
  const convo = await repo.findConversacionById(convId);
  if (!convo) throw { status: 404, message: "Conversación no encontrada" };

  const isClient  = clientToken && convo.clientToken === clientToken;
  const isComercio = clerkUserId && convo.vacante.comercio.clerkUserId === clerkUserId;
  if (!isClient && !isComercio) throw { status: 403, message: "No autorizado" };

  return convo;
}

export async function startConversacion(vacanteId: string, body: Record<string, unknown>) {
  const vacante = await repo.findVacanteByIdOnly(vacanteId);
  if (!vacante || !vacante.activa) throw { status: 404, message: "Vacante no encontrada" };

  const clientToken = sanitizeText(body.clientToken as string, 100);
  const clientName  = sanitizeText(body.clientName  as string, 100) || undefined;
  const mensaje     = sanitizeText(body.mensaje      as string, 1000);
  if (!clientToken || !mensaje) throw { status: 400, message: "Faltan campos: clientToken, mensaje" };

  return repo.createConversacion({ vacanteId, clientToken, clientName, mensaje });
}

export async function sendMensaje(
  convId: string,
  clerkUserId: string | null,
  body: Record<string, unknown>
) {
  const clientToken = body.clientToken as string | undefined;
  const convo = await repo.findConversacionWithComercio(convId);
  if (!convo) throw { status: 404, message: "Conversación no encontrada" };

  const isClient   = clientToken && convo.clientToken === clientToken;
  const isComercio = clerkUserId && convo.vacante.comercio.clerkUserId === clerkUserId;
  if (!isClient && !isComercio) throw { status: 403, message: "No autorizado" };

  const content = sanitizeText(body.content as string, 1000);
  if (!content) throw { status: 400, message: "Falta el contenido del mensaje" };

  const senderType = isComercio ? "professional" : "client";
  const msg = await repo.createMensaje(convId, senderType, content);
  await repo.touchConversacion(convId);

  const preview = content.length > 60 ? content.slice(0, 60) + "…" : content;

  if (senderType === "client") {
    const comercioClerkId = convo.vacante.comercio.clerkUserId;
    if (comercioClerkId) {
      sendPushToUser(comercioClerkId, {
        title: "Nuevo mensaje en vacante", body: preview,
        url: `/chat/vacante/${convId}`, icon: "/icon-192x192.png",
      });
    }
  }
  if (senderType === "professional" && convo.clientToken) {
    sendPushToClientToken(convo.clientToken, {
      title: "Te respondieron", body: preview,
      url: `/chat/vacante/${convId}`, icon: "/icon-192x192.png",
    });
  }

  return msg;
}
