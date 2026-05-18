import { uploadFileToR2 } from "../../shared/storage";
import { sanitizeText, generateSlug } from "../../shared/sanitize";
import { sendPushToUser } from "../../shared/push";
import * as repo from "./events.repository";

export const CATEGORIAS_EVENTO = [
  "Música", "Gastronomía", "Deportes", "Teatro", "Arte",
  "Fiesta", "Feria", "Educación", "Solidario", "Otro",
] as const;

export async function listEvents(filters: { categoria?: string; barrio?: string; upcoming?: boolean }) {
  return repo.findAllEvents(filters);
}

export async function getUpcomingEvents(limit = 5) {
  return repo.findUpcomingEvents(limit);
}

export async function getEventBySlug(slug: string) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };
  return event;
}

export async function getMyEvents(clerkUserId: string) {
  return repo.findEventsByClerkId(clerkUserId);
}

export async function createEvent(clerkUserId: string, formData: FormData) {
  const nombre    = sanitizeText(formData.get("nombre"), 150);
  const lugar     = sanitizeText(formData.get("lugar"), 150);
  const categoria = sanitizeText(formData.get("categoria"), 50);
  const fechaRaw  = formData.get("fecha") as string | null;
  const organizador = sanitizeText(formData.get("organizador"), 100);

  if (!nombre || !lugar || !categoria || !fechaRaw || !organizador)
    throw { status: 400, message: "Faltan campos obligatorios: nombre, lugar, categoría, fecha, organizador" };

  if (!CATEGORIAS_EVENTO.includes(categoria as any))
    throw { status: 400, message: "Categoría inválida" };

  const banner = await uploadFileToR2(formData.get("banner") as File | null, "evento");
  const logo   = await uploadFileToR2(formData.get("logo")   as File | null, "evento");

  const fotos: string[] = [];
  for (let i = 0; i < 10; i++) {
    const url = await uploadFileToR2(formData.get(`foto${i}`) as File | null, "evento");
    if (url) fotos.push(url);
  }

  const slug = generateSlug(nombre, categoria);

  return repo.createEvent({
    clerkUserId,
    slug,
    nombre,
    lugar,
    categoria,
    organizador,
    fecha:       new Date(fechaRaw),
    fechaFin:    formData.get("fechaFin")   ? new Date(formData.get("fechaFin") as string)   : undefined,
    descripcion: sanitizeText(formData.get("descripcion"), 1000) || undefined,
    direccion:   sanitizeText(formData.get("direccion"), 200)    || undefined,
    barrio:      sanitizeText(formData.get("barrio"), 100)       || undefined,
    precio:      sanitizeText(formData.get("precio"), 80)        || undefined,
    banner:      banner ?? undefined,
    logo:        logo   ?? undefined,
    ...(fotos.length ? { fotos } : {}),
  });
}

export async function updateEvent(clerkUserId: string, slug: string, formData: FormData) {
  const event = await repo.findEventBySlugAndOwner(slug, clerkUserId);
  if (!event) throw { status: 404, message: "Evento no encontrado" };

  const patch: Record<string, unknown> = {};
  const fields: [string, number][] = [
    ["nombre", 150], ["lugar", 150], ["organizador", 100],
    ["descripcion", 1000], ["direccion", 200], ["barrio", 100], ["precio", 80],
  ];
  for (const [field, max] of fields) {
    const v = formData.get(field);
    if (v !== null) patch[field] = sanitizeText(v, max) || null;
  }
  const categoria = formData.get("categoria");
  if (categoria && CATEGORIAS_EVENTO.includes(categoria as any)) patch.categoria = categoria;

  const fechaRaw    = formData.get("fecha")    as string | null;
  const fechaFinRaw = formData.get("fechaFin") as string | null;
  if (fechaRaw)    patch.fecha    = new Date(fechaRaw);
  if (fechaFinRaw) patch.fechaFin = new Date(fechaFinRaw);

  const banner = await uploadFileToR2(formData.get("banner") as File | null, "evento");
  const logo   = await uploadFileToR2(formData.get("logo")   as File | null, "evento");
  if (banner) patch.banner = banner;
  if (logo)   patch.logo   = logo;

  const newPhotos: string[] = [];
  for (let i = 0; i < 10; i++) {
    const url = await uploadFileToR2(formData.get(`foto${i}`) as File | null, "evento");
    if (url) newPhotos.push(url);
  }
  if (newPhotos.length) patch.fotos = [...(event.fotos ?? []), ...newPhotos];

  const updated = await repo.updateEvent(event.id, patch);

  notifySubscribers(event.id, event.slug, event.nombre, {
    title: `Actualización: ${event.nombre}`,
    body:  "El evento fue actualizado. Mirá los últimos cambios.",
  });

  return updated;
}

export async function deleteEvent(clerkUserId: string, slug: string) {
  const event = await repo.findEventBySlugAndOwner(slug, clerkUserId);
  if (!event) throw { status: 404, message: "Evento no encontrado" };
  await repo.deleteEvent(event.id);
  return { ok: true };
}

export async function getComments(slug: string) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };
  return repo.findCommentsByEvent(event.id);
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export async function getFollowStatus(slug: string, clerkUserId: string | null) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };
  const count      = await repo.countSubscribers(event.id);
  const subscribed = clerkUserId ? !!(await repo.findSubscription(event.id, clerkUserId)) : false;
  return { subscribed, count };
}

export async function followEvent(slug: string, clerkUserId: string) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };
  try { await repo.createSubscription(event.id, clerkUserId); } catch (e: any) { if (e?.code !== "P2002") throw e; }
  return { ok: true };
}

export async function unfollowEvent(slug: string, clerkUserId: string) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };
  try { await repo.deleteSubscription(event.id, clerkUserId); } catch { /* ya no sigue */ }
  return { ok: true };
}

async function notifySubscribers(eventoId: string, eventoSlug: string, eventoNombre: string, payload: { title: string; body: string }) {
  const subs = await repo.findSubscriberIds(eventoId);
  for (const { clerkUserId } of subs) {
    sendPushToUser(clerkUserId, { ...payload, url: `/evento/${eventoSlug}` });
  }
}

// ── Event Photos ──────────────────────────────────────────────────────────────

export async function getEventPhotos(slug: string) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };
  return repo.findPhotosByEvent(event.id);
}

export async function uploadEventPhoto(slug: string, clerkUserId: string, autorNombre: string, file: File) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };

  const url = await uploadFileToR2(file, "evento");
  if (!url) throw { status: 400, message: "Error al subir la foto" };

  const foto = await repo.createPhoto({
    eventoId:    event.id,
    clerkUserId,
    autorNombre: sanitizeText(autorNombre, 80) || "Asistente",
    url,
  });

  notifySubscribers(event.id, slug, (event as any).nombre ?? slug, {
    title: `Nueva foto en ${(event as any).nombre ?? slug}`,
    body:  "Alguien subió una foto desde el evento",
  });

  return foto;
}

export async function likeEventPhoto(fotoId: string, ip: string) {
  const ipHash = await hashIp(ip + fotoId);
  try {
    const updated = await repo.likePhoto(fotoId, ipHash);
    return { ok: true, likes: updated.likes };
  } catch (e: any) {
    if (e?.code === "P2002") return { ok: false, already: true };
    throw e;
  }
}

async function hashIp(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

// ── Event Likes ───────────────────────────────────────────────────────────────

export async function likeEvent(slug: string, ip: string) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };

  const ipBytes = new TextEncoder().encode(ip + event.id);
  const hashBuf = await crypto.subtle.digest("SHA-256", ipBytes);
  const ipHash  = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

  try {
    await repo.createEventLike(event.id, ipHash);
    const count = await repo.countEventLikes(event.id);
    return { ok: true, count };
  } catch (e: any) {
    if (e?.code === "P2002") {
      const count = await repo.countEventLikes(event.id);
      return { ok: false, already: true, count };
    }
    throw e;
  }
}

export async function getEventLikes(slug: string) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };
  return { count: await repo.countEventLikes(event.id) };
}

export async function addComment(slug: string, clerkUserId: string, autorNombre: string, texto: string) {
  const event = await repo.findEventBySlug(slug);
  if (!event) throw { status: 404, message: "Evento no encontrado" };

  const clean = sanitizeText(texto, 500);
  if (!clean || clean.length < 3) throw { status: 400, message: "El comentario es muy corto" };

  return repo.createComment({
    evento:      { connect: { id: event.id } },
    clerkUserId,
    autorNombre: sanitizeText(autorNombre, 80) || "Anónimo",
    texto:       clean,
  });
}
