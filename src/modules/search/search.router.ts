import { Elysia, t } from "elysia";
import { prisma } from "../../lib/prisma";

export const searchRouter = new Elysia({ prefix: "/api" })

  .get("/search", async ({ query, set }) => {
    const q = (query.q as string)?.trim();
    if (!q || q.length < 2) {
      return { professionals: [], comercios: [], doctors: [], products: [] };
    }

    const term = `%${q}%`;

    const [professionals, comercios, doctors, products] = await Promise.all([
      prisma.professional.findMany({
        where: {
          activo: true,
          OR: [
            { nombre: { contains: q, mode: "insensitive" } },
            { apellido: { contains: q, mode: "insensitive" } },
            { oficios: { hasSome: [q] } },
            { barrio: { contains: q, mode: "insensitive" } },
            { descripcion: { contains: q, mode: "insensitive" } },
          ],
        },
        select: { id: true, nombre: true, apellido: true, slug: true, oficios: true, barrio: true, foto: true, ratingAvg: true, ratingCount: true },
        take: 5,
      }),

      prisma.comercio.findMany({
        where: {
          activo: true,
          OR: [
            { nombre: { contains: q, mode: "insensitive" } },
            { rubro: { contains: q, mode: "insensitive" } },
            { barrio: { contains: q, mode: "insensitive" } },
            { descripcion: { contains: q, mode: "insensitive" } },
          ],
        },
        select: { id: true, nombre: true, slug: true, rubro: true, barrio: true, logo: true, isPremium: true, isFounder: true },
        take: 5,
      }),

      prisma.doctor.findMany({
        where: {
          activo: true,
          OR: [
            { nombre: { contains: q, mode: "insensitive" } },
            { especialidad: { contains: q, mode: "insensitive" } },
            { barrio: { contains: q, mode: "insensitive" } },
            { obrasSociales: { has: q } },
          ],
        },
        select: { id: true, nombre: true, especialidad: true, barrio: true, obrasSociales: true },
        take: 5,
      }),

      prisma.producto.findMany({
        where: {
          activo: true,
          OR: [
            { nombre: { contains: q, mode: "insensitive" } },
            { descripcion: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          id: true, nombre: true, tipo: true, precio: true, foto: true,
          comercio: { select: { slug: true, nombre: true, logo: true } },
        },
        take: 5,
      }),
    ]);

    set.headers["Cache-Control"] = "public, max-age=60, s-maxage=300";

    return {
      professionals: professionals.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        apellido: p.apellido,
        slug: p.slug,
        oficios: p.oficios,
        barrio: p.barrio,
        foto: p.foto,
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount,
        type: "professional" as const,
      })),
      comercios: comercios.map((c) => ({
        id: c.id,
        nombre: c.nombre,
        slug: c.slug,
        rubro: c.rubro,
        barrio: c.barrio,
        logo: c.logo,
        isPremium: c.isPremium,
        isFounder: c.isFounder,
        type: "comercio" as const,
      })),
      doctors: doctors.map((d) => ({
        id: d.id,
        nombre: d.nombre,
        especialidad: d.especialidad,
        barrio: d.barrio,
        obrasSociales: d.obrasSociales,
        type: "doctor" as const,
      })),
      products: products.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        tipo: p.tipo,
        precio: p.precio,
        foto: p.foto,
        comercioSlug: p.comercio?.slug ?? "",
        comercioNombre: p.comercio?.nombre ?? "",
        comercioLogo: p.comercio?.logo ?? null,
        type: "product" as const,
      })),
    };
  });
