import { sanitizeText, generateSlug } from "../../shared/sanitize";
import { uploadFileToR2 } from "../../shared/storage";
import * as repo from "./professionals.repository";

// ── Ranking ───────────────────────────────────────────────────────────────────

type ListPro = Awaited<ReturnType<typeof repo.findProfessionals>>[0];

function bayesianScore(p: ListPro, globalAvg: number, C: number): number {
  const bayesian = p.ratingCount > 0
    ? (C * globalAvg + p.ratingAvg * p.ratingCount) / (C + p.ratingCount)
    : globalAvg * 0.5;
  return (bayesian / 5) * 60 + Math.min((p.recommendations || 0) / 20, 1) * 30 + (p.foto ? 1 : 0) * 10;
}

// ── Professionals ─────────────────────────────────────────────────────────────

export async function listProfessionals(params: {
  oficio?: string;
  barrio?: string;
  tipo?: string;
}) {
  const validTipo = params.tipo === "profesion" || params.tipo === "oficio" ? params.tipo : undefined;
  const professionals = await repo.findProfessionals({
    oficio: params.oficio || undefined,
    barrio: params.barrio || undefined,
    tipo:   validTipo,
  });

  const globalAvg = professionals.length > 0
    ? professionals.reduce((s, p) => s + p.ratingAvg, 0) / professionals.length
    : 4.0;
  const C = 5;

  return [...professionals].sort((a, b) => bayesianScore(b, globalAvg, C) - bayesianScore(a, globalAvg, C));
}

export async function getMyProfile(clerkUserId: string | null, proCode: string | undefined) {
  const owner = await repo.findProOwner(clerkUserId, proCode);
  if (!owner) throw { status: 404, message: "Perfil no encontrado" };
  return repo.findProfessionalById(owner.id);
}

export async function getPublicProfile(slug: string) {
  const pro = await repo.findProfessionalBySlugPublic(slug);
  if (!pro) throw { status: 404, message: "No encontrado" };
  const { telefono: _t, clerkUserId: _c, pin: _p, ...publicData } = pro as any;
  return publicData;
}

export async function getProfileById(id: string) {
  const pro = await repo.findProfessionalById(id);
  if (!pro) throw { status: 404, message: "No encontrado" };
  const { telefono: _t, whatsapp: _w, clerkUserId: _c, pin: _p, ...publicData } = pro as any;
  return publicData;
}

export async function authWithPin(whatsapp: string, pin: string) {
  if (!whatsapp || !pin) throw { status: 400, message: "Datos incompletos" };
  const waClean = String(whatsapp).replace(/\D/g, "");
  const pro = await repo.findProfessionalByWhatsapp(waClean);
  if (!pro || !pro.pin) throw { status: 401, message: "Numero o PIN incorrecto" };
  const valid = await Bun.password.verify(String(pin), pro.pin);
  if (!valid) throw { status: 401, message: "Numero o PIN incorrecto" };
  return { id: pro.id, nombre: pro.nombre, slug: pro.slug };
}

export async function createProfessional(clerkUserId: string | null, body: Record<string, unknown>) {
  if (clerkUserId) {
    const existing = await repo.findProfessionalByClerkId(clerkUserId);
    if (existing) throw { status: 409, message: "Ya tenés un perfil creado" };
  }

  const nombre      = sanitizeText(body.nombre as string, 60);
  const apellido    = sanitizeText(body.apellido as string, 60);
  const descripcion = sanitizeText(body.descripcion as string, 500) || undefined;
  const whatsapp    = (body.whatsapp as string | undefined)?.trim();
  const oficios     = Array.isArray(body.oficios) ? (body.oficios as string[]) : [];

  if (!nombre || !apellido || !oficios.length || !whatsapp) {
    throw { status: 400, message: "Faltan campos obligatorios" };
  }

  const rawTipo = body.tipo as string | undefined;
  const tipo    = rawTipo === "profesion" || rawTipo === "oficio" ? rawTipo : null;
  const slug    = generateSlug(nombre, apellido, oficios);
  const rawPin  = body.pin as string | undefined;
  const pin     = rawPin ? await Bun.password.hash(rawPin) : null;

  return repo.createProfessional({
    clerkUserId,
    nombre,
    apellido,
    slug,
    tipo,
    oficios,
    descripcion,
    telefono:  (body.telefono as string | undefined) || undefined,
    whatsapp,
    pin,
    updatedAt: new Date(),
  });
}

export async function updateMyProfile(
  clerkUserId: string | null,
  proCode: string | undefined,
  body: Record<string, unknown>
) {
  const owner = await repo.findProOwner(clerkUserId, proCode);
  if (!owner) throw { status: 401, message: "No autorizado" };

  const rawTipo = body.tipo as string | undefined;
  const safeTipo = rawTipo === "profesion" || rawTipo === "oficio" ? rawTipo : undefined;

  const data: Record<string, unknown> = { updatedAt: new Date() };
  if (body.nombre      !== undefined) data.nombre      = body.nombre;
  if (body.apellido    !== undefined) data.apellido     = body.apellido;
  if (safeTipo         !== undefined) data.tipo         = safeTipo;
  if (body.oficios     !== undefined) data.oficios      = body.oficios;
  if (body.descripcion !== undefined) data.descripcion  = body.descripcion;
  if (body.barrio      !== undefined) data.barrio       = body.barrio;
  if (body.telefono    !== undefined) data.telefono     = body.telefono;
  if (body.whatsapp    !== undefined) data.whatsapp     = body.whatsapp;
  if (body.disponible  !== undefined) data.disponible   = body.disponible;
  if (body.fotos       !== undefined) data.fotos        = body.fotos;
  if (body.foto        !== undefined) data.foto         = body.foto;

  return repo.updateProfessional(owner.id, data);
}

export async function uploadProfilePhoto(
  clerkUserId: string | null,
  proCode: string | undefined,
  file: File | null
) {
  const owner = await repo.findProOwner(clerkUserId, proCode);
  if (!owner) throw { status: 401, message: "No autorizado" };
  if (!file || file.size === 0) throw { status: 400, message: "No se recibió ninguna imagen" };

  const fotoUrl = await uploadFileToR2(file, "professional");
  const updated = await repo.updateProfessional(owner.id, { foto: fotoUrl, updatedAt: new Date() });
  return { foto: (updated as any).foto };
}

export async function addGalleryPhoto(
  clerkUserId: string | null,
  proCode: string | undefined,
  file: File | null
) {
  const owner = await repo.findProOwner(clerkUserId, proCode);
  if (!owner) throw { status: 401, message: "No autorizado" };
  if (!file || file.size === 0) throw { status: 400, message: "No se recibió imagen" };

  const pro = await repo.findProWithFotos(owner.id);
  if (!pro) throw { status: 404, message: "Perfil no encontrado" };

  const fotoUrl = await uploadFileToR2(file, "professional_gallery");
  const updated = await repo.updateProfessional(owner.id, {
    fotos: [...pro.fotos, fotoUrl],
    updatedAt: new Date(),
  });
  return { fotos: (updated as any).fotos };
}

export async function deleteGalleryPhoto(
  clerkUserId: string | null,
  proCode: string | undefined,
  fotoUrl: string
) {
  const owner = await repo.findProOwner(clerkUserId, proCode);
  if (!owner) throw { status: 401, message: "No autorizado" };

  const pro = await repo.findProWithFotos(owner.id);
  if (!pro) throw { status: 404, message: "Perfil no encontrado" };

  const fotos = pro.fotos.filter((f) => f !== fotoUrl);
  await repo.updateProfessional(owner.id, { fotos, updatedAt: new Date() });
  return { fotos };
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function getReviews(slug: string) {
  const pro = await repo.findProfessionalBySlug(slug);
  if (!pro) throw { status: 404, message: "No encontrado" };
  return repo.findReviewsByPro(pro.id);
}

export async function addReview(
  slug: string,
  clerkUserId: string,
  body: Record<string, unknown>
) {
  const pro = await repo.findProfessionalBySlug(slug);
  if (!pro) throw { status: 404, message: "No encontrado" };

  const score        = Number(body.score);
  const comment      = sanitizeText((body.comment as string) ?? "", 1000);
  const reviewerName = sanitizeText((body.reviewerName as string) ?? "", 60);

  if (!body.score || score < 1 || score > 5) throw { status: 400, message: "Datos inválidos" };

  const existing = await repo.findReviewByUserAndPro(pro.id, clerkUserId);
  if (existing) throw { status: 409, message: "Ya dejaste una opinión para este profesional" };

  const review = await repo.createReview({
    professionalId: pro.id,
    clerkUserId,
    reviewerName:   reviewerName?.trim() || "Vecino anónimo",
    score:          Math.min(5, Math.max(1, score)),
    comment:        (comment ?? "").trim().slice(0, 1000),
  });

  await repo.recalcProfessionalRating(pro.id);
  return review;
}

export async function reportReview(reviewId: string, clerkUserId: string) {
  const review = await repo.findReviewById(reviewId);
  if (!review) throw { status: 404, message: "No encontrada" };
  if (review.reported) return { ok: true };
  await repo.reportReview(reviewId);
  return { ok: true };
}

// ── Recommendations ───────────────────────────────────────────────────────────

export async function recommendProfessional(slug: string, ip: string) {
  const pro = await repo.findProfessionalBySlug(slug);
  if (!pro) throw { status: 404, message: "No encontrado" };

  const ipBytes = new TextEncoder().encode(ip + pro.id);
  const hashBuf = await crypto.subtle.digest("SHA-256", ipBytes);
  const ipHash  = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");

  try {
    await repo.createRecommendation({ targetType: "professional", targetId: pro.id, ipHash });
    const updated = await repo.incrementRecommendations(pro.id);
    return { ok: true, count: updated.recommendations };
  } catch (e: any) {
    if (e?.code === "P2002") {
      return { ok: false, already: true, count: pro.recommendations };
    }
    throw e;
  }
}
