import { sanitizeText } from "../../shared/sanitize";
import { uploadFileToR2 } from "../../shared/storage";
import { sendPushToUser, sendPushToClientToken } from "../../shared/push";
import * as repo from "./empleados.repository";

function buildSlug(nombre: string, apellido: string): string {
  return `${nombre}-${apellido}-${Math.random().toString(36).slice(2, 7)}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Empleados ─────────────────────────────────────────────────────────────────

export async function listEmpleados(params: { barrio?: string; habilidad?: string }) {
  return repo.findEmpleados({
    barrio:    params.barrio    || undefined,
    habilidad: params.habilidad || undefined,
  });
}

export async function getMyProfile(clerkUserId: string) {
  const emp = await repo.findEmpleadoByClerkId(clerkUserId);
  if (!emp) throw { status: 404, message: "No tenés un perfil de empleado" };
  return emp;
}

export async function getPublicProfile(slug: string) {
  const emp = await repo.findEmpleadoBySlug(slug);
  if (!emp || !emp.activo) throw { status: 404, message: "Empleado no encontrado" };
  return emp;
}

export async function createEmpleado(clerkUserId: string, formData: FormData) {
  const existing = await repo.findEmpleadoByClerkIdFull(clerkUserId);
  if (existing) throw { status: 409, message: "Ya tenés un perfil de empleado creado" };

  const nombre     = sanitizeText(formData.get("nombre") as string, 100);
  const apellido   = sanitizeText(formData.get("apellido") as string, 100);
  const rawHab     = formData.get("habilidades") as string | null;
  const habilidades = rawHab ? rawHab.split(",").map(h => h.trim()).filter(Boolean) : [];

  if (!nombre || !apellido || habilidades.length === 0) {
    throw { status: 400, message: "Faltan campos obligatorios: nombre, apellido, habilidades" };
  }

  const descripcion = sanitizeText(formData.get("descripcion") as string, 500) || undefined;
  const barrio      = sanitizeText(formData.get("barrio") as string, 100) || undefined;
  const whatsapp    = sanitizeText(formData.get("whatsapp") as string, 30) || undefined;
  const foto        = await uploadFileToR2(formData.get("photo") as File | null, "empleado") || undefined;

  return repo.createEmpleado({
    clerkUserId, nombre, apellido,
    slug: buildSlug(nombre, apellido),
    habilidades, descripcion, barrio, whatsapp, foto,
  });
}

export async function updateMyProfile(clerkUserId: string, formData: FormData) {
  const existing = await repo.findEmpleadoByClerkIdFull(clerkUserId);
  if (!existing) throw { status: 404, message: "No tenés un perfil de empleado" };

  const data: Record<string, unknown> = {};

  const nombre    = formData.get("nombre") as string | null;
  const apellido  = formData.get("apellido") as string | null;
  const descripcion = formData.get("descripcion") as string | null;
  const barrio    = formData.get("barrio") as string | null;
  const whatsapp  = formData.get("whatsapp") as string | null;
  const habRaw    = formData.get("habilidades") as string | null;
  const dispRaw   = formData.get("disponible") as string | null;
  const photoFile = formData.get("photo") as File | null;

  if (nombre)      data.nombre      = sanitizeText(nombre, 100);
  if (apellido)    data.apellido    = sanitizeText(apellido, 100);
  if (descripcion !== null) data.descripcion = sanitizeText(descripcion, 500) || null;
  if (barrio !== null)      data.barrio      = sanitizeText(barrio, 100) || null;
  if (whatsapp !== null)    data.whatsapp    = sanitizeText(whatsapp, 30) || null;
  if (habRaw !== null)      data.habilidades = habRaw.split(",").map(h => h.trim()).filter(Boolean);
  if (dispRaw !== null)     data.disponible  = dispRaw === "true";

  if (photoFile && photoFile.size > 0) {
    data.foto = await uploadFileToR2(photoFile, "empleado");
  }

  return repo.updateEmpleado(clerkUserId, data);
}

// ── Conversaciones ────────────────────────────────────────────────────────────

export async function getMyConversaciones(clerkUserId: string) {
  const emp = await repo.findEmpleadoByClerkIdFull(clerkUserId);
  if (!emp) throw { status: 404, message: "No tenés un perfil de empleado" };
  return repo.findConversacionesByEmpleado(emp.id);
}

export async function getConversacion(
  convId: string,
  clerkUserId: string | null,
  clientToken: string | null
) {
  const convo = await repo.findConversacionById(convId);
  if (!convo) throw { status: 404, message: "Conversación no encontrada" };

  const isClient   = clientToken && convo.clientToken === clientToken;
  const isEmpleado = clerkUserId && convo.empleado.clerkUserId === clerkUserId;
  if (!isClient && !isEmpleado) throw { status: 403, message: "No autorizado" };

  return convo;
}

export async function startConversacion(slug: string, body: Record<string, unknown>) {
  const emp = await repo.findEmpleadoBySlug(slug);
  if (!emp || !emp.activo) throw { status: 404, message: "Empleado no encontrado" };

  const clientToken = sanitizeText(body.clientToken as string, 100);
  const clientName  = sanitizeText(body.clientName as string, 100) || undefined;
  const mensaje     = sanitizeText(body.mensaje as string, 1000);

  if (!clientToken || !mensaje) throw { status: 400, message: "Faltan campos: clientToken, mensaje" };

  return repo.createConversacion({ empleadoId: emp.id, clientToken, clientName, mensaje });
}

export async function sendMensaje(
  convId: string,
  clerkUserId: string | null,
  body: Record<string, unknown>
) {
  const clientToken = body.clientToken as string | undefined;
  const convo = await repo.findConversacionWithEmpleado(convId);
  if (!convo) throw { status: 404, message: "Conversación no encontrada" };

  const isClient   = clientToken && convo.clientToken === clientToken;
  const isEmpleado = clerkUserId && convo.empleado.clerkUserId === clerkUserId;
  if (!isClient && !isEmpleado) throw { status: 403, message: "No autorizado" };

  const content = sanitizeText(body.content as string, 1000);
  if (!content) throw { status: 400, message: "Falta el contenido del mensaje" };

  const senderType = isEmpleado ? "professional" : "client";
  const msg = await repo.createMensaje(convId, senderType, content);
  await repo.touchConversacion(convId);

  const preview = content.length > 60 ? content.slice(0, 60) + "…" : content;

  if (senderType === "client" && convo.empleado.clerkUserId) {
    sendPushToUser(convo.empleado.clerkUserId, {
      title: "Nuevo mensaje", body: preview,
      url: `/chat/empleado/${convId}`, icon: "/icon-192x192.png",
    });
  }
  if (senderType === "professional" && convo.clientToken) {
    sendPushToClientToken(convo.clientToken, {
      title: "Te respondieron", body: preview,
      url: `/chat/empleado/${convId}`, icon: "/icon-192x192.png",
    });
  }

  return msg;
}
