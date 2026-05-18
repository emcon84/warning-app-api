import { sanitizeText } from "../../shared/sanitize";
import { uploadFileToR2 } from "../../shared/storage";
import { sendPushToComercioSubscriptors } from "../../shared/push";
import * as repo from "./posts.repository";

const POST_TYPES = ["novedad", "oferta", "sorteo"] as const;
type PostType = (typeof POST_TYPES)[number];

const PAGE_LIMIT = 12;

export async function getRecentPosts(rawLimit: string | undefined) {
  const limit = Math.min(parseInt(rawLimit ?? "10"), 30);
  return repo.findRecentPosts(isNaN(limit) ? 10 : limit);
}

export async function getPostById(postId: string) {
  const post = await repo.findPostById(postId);
  if (!post) throw { status: 404, message: "Post no encontrado" };
  return post;
}

export async function toggleLike(postId: string, unlike: boolean) {
  const delta = unlike ? -1 : 1;
  const updated = await repo.incrementPostLikes(postId, delta);
  if (!updated) throw { status: 404, message: "Post no encontrado" };
  return { likes: Math.max(0, updated.likes) };
}

export async function getPostsByStore(slug: string, rawPage: string | undefined) {
  const store = await repo.findStoreIdBySlug(slug);
  if (!store) throw { status: 404, message: "Comercio no encontrado" };

  const page = Math.max(1, parseInt(rawPage ?? "1") || 1);
  const [posts, total] = await repo.findPostsByStoreId(store.id, page, PAGE_LIMIT);

  return { posts, total, page, pages: Math.ceil(total / PAGE_LIMIT) };
}

export async function createPost(slug: string, clerkUserId: string, formData: FormData) {
  const store = await repo.findStoreForPostCreate(slug);
  if (!store || store.clerkUserId !== clerkUserId)
    throw { status: 403, message: "No autorizado" };

  const contenido = sanitizeText(formData.get("contenido") as string, 1000);
  if (!contenido) throw { status: 400, message: "El contenido es obligatorio" };

  const rawTipo    = formData.get("tipo") as string;
  const tipo: PostType = (POST_TYPES as readonly string[]).includes(rawTipo)
    ? (rawTipo as PostType)
    : "novedad";

  const precioAntes   = sanitizeText(formData.get("precioAntes") as string, 50) || null;
  const precioDespues = sanitizeText(formData.get("precioDespues") as string, 50) || null;
  const rawFecha      = formData.get("fechaSorteo") as string | null;
  const fechaSorteo   = rawFecha ? new Date(rawFecha) : null;
  const foto          = await uploadFileToR2(formData.get("photo") as File | null, "post");

  const post = await repo.createPost({
    comercioId: store.id,
    tipo,
    contenido,
    foto,
    precioAntes,
    precioDespues,
    fechaSorteo,
  });

  const pushBody =
    tipo === "oferta" ? `Nueva oferta: ${contenido.slice(0, 80)}` :
    tipo === "sorteo" ? `Nuevo sorteo: ${contenido.slice(0, 80)}` :
    contenido.slice(0, 100);

  sendPushToComercioSubscriptors(store.id, {
    title: store.nombre,
    body: pushBody,
    url: `/comercio/${slug}`,
    icon: store.logo || store.foto || "/icon-192x192.png",
  });

  return post;
}

export async function deletePost(slug: string, postId: string, clerkUserId: string) {
  const store = await repo.findStoreForPostDelete(slug);
  if (!store || store.clerkUserId !== clerkUserId)
    throw { status: 403, message: "No autorizado" };

  await repo.softDeletePost(postId, store.id);
  return { ok: true };
}
