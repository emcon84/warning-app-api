/**
 * migrate-uploads-to-r2.ts
 *
 * Sube todos los archivos de /uploads/ referenciados en la DB a Cloudflare R2
 * y actualiza los registros para que usen la URL pública de R2.
 *
 * Uso: bun scripts/migrate-uploads-to-r2.ts
 * Flags:
 *   --dry-run   Solo lista lo que haría, sin subir ni actualizar
 *   --force     Re-sube aunque ya exista en R2
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "fs";
import { join, basename } from "path";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE   = process.argv.includes("--force");

const prisma = new PrismaClient();
const UPLOADS_DIR = join(import.meta.dir, "..", "uploads");
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;
const R2_BUCKET     = process.env.R2_BUCKET_NAME || "warning-app-images";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const MIME: Record<string, string> = {
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  png:  "image/png",
  avif: "image/avif",
  webp: "image/webp",
  gif:  "image/gif",
};

async function existsInR2(key: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadFile(localPath: string, key: string): Promise<string> {
  const ext  = key.split(".").pop()?.toLowerCase() ?? "jpg";
  const mime = MIME[ext] ?? "application/octet-stream";
  const body = readFileSync(localPath);

  if (DRY_RUN) {
    console.log(`  [DRY] upload ${key} (${(body.length / 1024).toFixed(1)} KB)`);
    return `${R2_PUBLIC_URL}/${key}`;
  }

  const alreadyExists = !FORCE && await existsInR2(key);
  if (alreadyExists) {
    console.log(`  ⏭  ${key} ya existe en R2, skip`);
    return `${R2_PUBLIC_URL}/${key}`;
  }

  await r2.send(new PutObjectCommand({
    Bucket:      R2_BUCKET,
    Key:         key,
    Body:        body,
    ContentType: mime,
  }));
  console.log(`  ✅ subido ${key} (${(body.length / 1024).toFixed(1)} KB)`);
  return `${R2_PUBLIC_URL}/${key}`;
}

function localPath(uploadsRef: string): string {
  // "/uploads/comercio_xxx.jpg" → UPLOADS_DIR/comercio_xxx.jpg
  return join(UPLOADS_DIR, basename(uploadsRef));
}

function r2Key(uploadsRef: string): string {
  return basename(uploadsRef);
}

async function main() {
  console.log(`\n🚀 Migración de /uploads/ → R2  ${DRY_RUN ? "(DRY RUN)" : ""}\n`);

  // ── 1. Recopilar todos los registros con refs a /uploads/ ──────────────────

  const [comercios, profesionales, productos, posts, offers] = await Promise.all([
    prisma.comercio.findMany({
      where: {
        OR: [
          { foto: { startsWith: "/uploads/" } },
          { logo: { startsWith: "/uploads/" } },
        ],
      },
      select: { id: true, nombre: true, foto: true, logo: true, fotos: true },
    }),
    // Comercios con galerías (fotos[])
    prisma.comercio.findMany({
      select: { id: true, nombre: true, fotos: true },
    }),
    prisma.professional.findMany({
      where: {
        OR: [
          { foto: { startsWith: "/uploads/" } },
          { fotos: { hasSome: [] } },
        ],
      },
      select: { id: true, nombre: true, foto: true, fotos: true },
    }),
    prisma.producto.findMany({
      where: { foto: { startsWith: "/uploads/" } },
      select: { id: true, nombre: true, foto: true },
    }),
    prisma.comercioPost.findMany({
      where: { foto: { startsWith: "/uploads/" } },
      select: { id: true, foto: true },
    }),
  ]);

  // Filtrar comercios cuya galería tenga /uploads/
  const comerciosConGaleria = profesionales.length >= 0 // reutilizamos el array de comercios
    ? comercios.concat(
        (await prisma.comercio.findMany({ select: { id: true, nombre: true, foto: true, logo: true, fotos: true } }))
          .filter(c => c.fotos.some(f => f.startsWith("/uploads/")))
          .filter(c => !comercios.find(x => x.id === c.id))
      )
    : comercios;

  const profesionalesConRef = profesionales.filter(
    p => p.foto?.startsWith("/uploads/") || p.fotos.some(f => f.startsWith("/uploads/"))
  );

  let totalSubidos = 0;
  let totalSkipped = 0;
  let totalErrores = 0;

  // ── 2. Migrar Comercios ────────────────────────────────────────────────────

  const allComercios = await prisma.comercio.findMany({
    where: {
      OR: [
        { foto: { startsWith: "/uploads/" } },
        { logo: { startsWith: "/uploads/" } },
      ],
    },
    select: { id: true, nombre: true, foto: true, logo: true, fotos: true },
  });

  // También los que tienen /uploads/ en fotos[]
  const allComerciosFotos = await prisma.comercio.findMany({
    select: { id: true, nombre: true, foto: true, logo: true, fotos: true },
  });
  const comerciosConFotosArray = allComerciosFotos.filter(
    c => c.fotos.some(f => f.startsWith("/uploads/"))
  );

  // Merge sin duplicados
  const comercioMap = new Map<string, typeof allComercios[0]>();
  [...allComercios, ...comerciosConFotosArray].forEach(c => comercioMap.set(c.id, c));
  const todosLosComercios = [...comercioMap.values()];

  for (const c of todosLosComercios) {
    console.log(`\n📦 Comercio: ${c.nombre} (${c.id})`);
    const update: Record<string, unknown> = {};

    if (c.foto?.startsWith("/uploads/")) {
      const lp = localPath(c.foto);
      if (!existsSync(lp)) {
        console.log(`  ⚠️  archivo no encontrado: ${lp}`);
        totalErrores++;
      } else {
        try {
          update.foto = await uploadFile(lp, r2Key(c.foto));
          totalSubidos++;
        } catch (e) {
          console.error(`  ❌ error subiendo foto: ${e}`);
          totalErrores++;
        }
      }
    }

    if (c.logo?.startsWith("/uploads/")) {
      const lp = localPath(c.logo);
      if (!existsSync(lp)) {
        console.log(`  ⚠️  logo no encontrado: ${lp}`);
        totalErrores++;
      } else {
        try {
          update.logo = await uploadFile(lp, r2Key(c.logo));
          totalSubidos++;
        } catch (e) {
          console.error(`  ❌ error subiendo logo: ${e}`);
          totalErrores++;
        }
      }
    }

    const nuevasFotos: string[] = [];
    let fotosCambiaron = false;
    for (const f of c.fotos) {
      if (!f.startsWith("/uploads/")) {
        nuevasFotos.push(f);
        continue;
      }
      const lp = localPath(f);
      if (!existsSync(lp)) {
        console.log(`  ⚠️  foto galería no encontrada: ${lp}`);
        totalErrores++;
        nuevasFotos.push(f);
        continue;
      }
      try {
        const r2url = await uploadFile(lp, r2Key(f));
        nuevasFotos.push(r2url);
        fotosCambiaron = true;
        totalSubidos++;
      } catch (e) {
        console.error(`  ❌ error subiendo foto galería: ${e}`);
        totalErrores++;
        nuevasFotos.push(f);
      }
    }
    if (fotosCambiaron) update.fotos = nuevasFotos;

    if (Object.keys(update).length > 0) {
      if (!DRY_RUN) {
        await prisma.comercio.update({ where: { id: c.id }, data: update });
        console.log(`  💾 DB actualizada para ${c.nombre}`);
      } else {
        console.log(`  [DRY] actualizaría DB para ${c.nombre}: ${JSON.stringify(Object.keys(update))}`);
      }
    }
  }

  // ── 3. Migrar Profesionales ────────────────────────────────────────────────

  const todosLosProfesionales = await prisma.professional.findMany({
    where: {
      OR: [
        { foto: { startsWith: "/uploads/" } },
      ],
    },
    select: { id: true, nombre: true, foto: true, fotos: true },
  });
  // También con fotos[] (si las hay)
  const profConFotos = await prisma.professional.findMany({
    select: { id: true, nombre: true, foto: true, fotos: true },
  });
  const profConFotosArray = profConFotos.filter(p => p.fotos.some(f => f.startsWith("/uploads/")));
  const profMap = new Map<string, typeof todosLosProfesionales[0]>();
  [...todosLosProfesionales, ...profConFotosArray].forEach(p => profMap.set(p.id, p));

  for (const p of profMap.values()) {
    console.log(`\n👤 Profesional: ${p.nombre} (${p.id})`);
    const update: Record<string, unknown> = {};

    if (p.foto?.startsWith("/uploads/")) {
      const lp = localPath(p.foto);
      if (!existsSync(lp)) {
        console.log(`  ⚠️  archivo no encontrado: ${lp}`);
        totalErrores++;
      } else {
        try {
          update.foto = await uploadFile(lp, r2Key(p.foto));
          totalSubidos++;
        } catch (e) {
          console.error(`  ❌ error: ${e}`);
          totalErrores++;
        }
      }
    }

    const nuevasFotos: string[] = [];
    let fotosCambiaron = false;
    for (const f of p.fotos) {
      if (!f.startsWith("/uploads/")) { nuevasFotos.push(f); continue; }
      const lp = localPath(f);
      if (!existsSync(lp)) { nuevasFotos.push(f); totalErrores++; continue; }
      try {
        nuevasFotos.push(await uploadFile(lp, r2Key(f)));
        fotosCambiaron = true;
        totalSubidos++;
      } catch { nuevasFotos.push(f); totalErrores++; }
    }
    if (fotosCambiaron) update.fotos = nuevasFotos;

    if (Object.keys(update).length > 0 && !DRY_RUN) {
      await prisma.professional.update({ where: { id: p.id }, data: update });
      console.log(`  💾 DB actualizada`);
    }
  }

  // ── 4. Migrar Productos ────────────────────────────────────────────────────

  const todosLosProductos = await prisma.producto.findMany({
    where: { foto: { startsWith: "/uploads/" } },
    select: { id: true, nombre: true, foto: true },
  });

  for (const p of todosLosProductos) {
    console.log(`\n🛍  Producto: ${p.nombre}`);
    const lp = localPath(p.foto!);
    if (!existsSync(lp)) { totalErrores++; continue; }
    try {
      const r2url = await uploadFile(lp, r2Key(p.foto!));
      if (!DRY_RUN) await prisma.producto.update({ where: { id: p.id }, data: { foto: r2url } });
      totalSubidos++;
    } catch { totalErrores++; }
  }

  // ── 5. Migrar Posts ────────────────────────────────────────────────────────

  const todosLosPosts = await prisma.comercioPost.findMany({
    where: { foto: { startsWith: "/uploads/" } },
    select: { id: true, foto: true },
  });

  for (const p of todosLosPosts) {
    console.log(`\n📢 Post: ${p.id}`);
    const lp = localPath(p.foto!);
    if (!existsSync(lp)) { totalErrores++; continue; }
    try {
      const r2url = await uploadFile(lp, r2Key(p.foto!));
      if (!DRY_RUN) await prisma.comercioPost.update({ where: { id: p.id }, data: { foto: r2url } });
      totalSubidos++;
    } catch { totalErrores++; }
  }

  // ── Resumen ────────────────────────────────────────────────────────────────

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Subidos:  ${totalSubidos}
  ⏭  Skipped:  ${totalSkipped}
  ❌ Errores:  ${totalErrores}
  ${DRY_RUN ? "⚠️  DRY RUN — ningún cambio aplicado" : "🎉 Migración completada"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
