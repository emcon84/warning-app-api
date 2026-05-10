import { prisma } from "../../lib/prisma";
import type { Prisma } from "@prisma/client";

// ── Select presets ────────────────────────────────────────────────────────────

const RECENT_SELECT = {
  id: true,
  tipo: true,
  contenido: true,
  foto: true,
  likes: true,
  createdAt: true,
  comercio: {
    select: { id: true, nombre: true, slug: true, foto: true, logo: true, rubro: true, whatsapp: true },
  },
} satisfies Prisma.ComercioPostSelect;

const DETAIL_SELECT = {
  id: true,
  tipo: true,
  contenido: true,
  foto: true,
  precioAntes: true,
  precioDespues: true,
  fechaSorteo: true,
  likes: true,
  activo: true,
  createdAt: true,
  comercio: {
    select: { id: true, nombre: true, slug: true, barrio: true, whatsapp: true, foto: true, logo: true },
  },
} satisfies Prisma.ComercioPostSelect;

const LIST_SELECT = {
  id: true,
  tipo: true,
  contenido: true,
  foto: true,
  precioAntes: true,
  precioDespues: true,
  fechaSorteo: true,
  likes: true,
  activo: true,
  createdAt: true,
} satisfies Prisma.ComercioPostSelect;

// ── Posts ─────────────────────────────────────────────────────────────────────

export async function findRecentPosts(limit: number) {
  return prisma.comercioPost.findMany({
    where: { activo: true },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: RECENT_SELECT,
  });
}

export async function findPostById(postId: string) {
  return prisma.comercioPost.findUnique({
    where: { id: postId },
    select: DETAIL_SELECT,
  });
}

export async function incrementPostLikes(postId: string, delta: number) {
  return prisma.comercioPost.update({
    where: { id: postId },
    data: { likes: { increment: delta } },
    select: { likes: true },
  }).catch(() => null);
}

export async function findPostsByStoreId(
  comercioId: string,
  page: number,
  limit: number
) {
  const skip = (page - 1) * limit;
  return Promise.all([
    prisma.comercioPost.findMany({
      where: { comercioId, activo: true },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      select: LIST_SELECT,
    }),
    prisma.comercioPost.count({ where: { comercioId, activo: true } }),
  ]);
}

export async function createPost(data: {
  comercioId: string;
  tipo: string;
  contenido: string;
  foto: string | null;
  precioAntes: string | null;
  precioDespues: string | null;
  fechaSorteo: Date | null;
}) {
  return prisma.comercioPost.create({ data });
}

export async function softDeletePost(postId: string, comercioId: string) {
  return prisma.comercioPost.updateMany({
    where: { id: postId, comercioId },
    data: { activo: false },
  });
}

// ── Store lookups (for post operations) ───────────────────────────────────────

export async function findStoreIdBySlug(slug: string) {
  return prisma.comercio.findUnique({ where: { slug }, select: { id: true } });
}

export async function findStoreForPostCreate(slug: string) {
  return prisma.comercio.findUnique({
    where: { slug },
    select: { id: true, clerkUserId: true, nombre: true, logo: true, foto: true },
  });
}

export async function findStoreForPostDelete(slug: string) {
  return prisma.comercio.findUnique({
    where: { slug },
    select: { id: true, clerkUserId: true },
  });
}
