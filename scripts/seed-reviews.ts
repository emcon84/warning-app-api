import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const reviewsPerPro: Record<string, { name: string; score: number; comment: string }[]> = {
  "diego-mamani-gasista-rq005": [
    { name: "Carlos M.", score: 5, comment: "Excelente profesional. Vino el mismo día que llamé, resolvió la pérdida de gas en menos de una hora y a un precio muy razonable. 100% recomendado." },
    { name: "María L.", score: 5, comment: "Muy prolijo y rápido. Me instaló el calefón nuevo sin ningún problema. Muy amable y trabajó limpio." },
    { name: "Roberto F.", score: 5, comment: "Lo contraté para revisar la instalación completa de gas. Muy serio y confiable. Ya lo tengo agendado para cualquier trabajo futuro." },
  ],
  "luciana-ferreyra-electricista-rq002": [
    { name: "Ana S.", score: 5, comment: "Luciana es una profesional de primera. Hizo toda la instalación eléctrica de mi local en tiempo y forma. Muy recomendable." },
    { name: "Jorge P.", score: 5, comment: "Me cambió el tablero eléctrico. Trabajo de calidad, ordenado y con garantía. La recomiendo sin dudarlo." },
    { name: "Silvia R.", score: 4, comment: "Muy buena atención y trabajo prolijo. Un poco de demora en confirmar el turno pero el trabajo fue excelente." },
  ],
  "marcos-villalba-plomero-rq001": [
    { name: "Eduardo T.", score: 5, comment: "Lo llamé por una pérdida de agua y vino enseguida. Resolvió el problema rápido y dejó todo impecable." },
    { name: "Graciela N.", score: 5, comment: "Muy buen servicio. Hizo la instalación completa del baño nuevo. Precio justo y trabajo de calidad." },
    { name: "Horacio B.", score: 4, comment: "Buen trabajo en general. Destapó las cañerías sin problemas. Lo volvería a contratar." },
  ],
  "carla-medina-limpieza-rq008": [
    { name: "Patricia V.", score: 5, comment: "Carla es increíble. Deja todo reluciente. La contrato cada quince días y siempre supera las expectativas." },
    { name: "Martín G.", score: 5, comment: "Hizo la limpieza post obra en mi casa nueva. Quedó impecable. Muy eficiente y puntual." },
    { name: "Laura C.", score: 5, comment: "La mejor limpiadora que contraté. Muy responsable y detallista con su trabajo." },
  ],
  "sebastian-rios-pintor-rq004": [
    { name: "Diego A.", score: 5, comment: "Pintó toda mi casa interior. Trabajo prolijo, puntual y a un precio muy competitivo. Lo recomiendo." },
    { name: "Nora M.", score: 4, comment: "Buen trabajo en la pintura exterior de la casa. El texturado quedó muy bien." },
  ],
  "roberto-gomez-albanil-rq003": [
    { name: "Gustavo L.", score: 5, comment: "Hizo una ampliación en mi casa. Trabajo serio, prolijo y respetó los tiempos acordados." },
    { name: "Sandra F.", score: 4, comment: "Muy buen trabajo en los revoques. Precio justo y buena predisposición." },
  ],
};

async function main() {
  console.log("🌱 Insertando opiniones de prueba...");

  for (const [slug, reviews] of Object.entries(reviewsPerPro)) {
    const pro = await prisma.professional.findUnique({ where: { slug } });
    if (!pro) { console.log(`⚠  No encontrado: ${slug}`); continue; }

    for (const r of reviews) {
      await prisma.publicReview.create({
        data: {
          professionalId: pro.id,
          reviewerName: r.name,
          score: r.score,
          comment: r.comment,
        },
      });
    }

    // Actualizar ratingAvg y ratingCount reales
    const agg = await prisma.publicReview.aggregate({
      where: { professionalId: pro.id },
      _avg: { score: true },
      _count: { score: true },
    });
    await prisma.professional.update({
      where: { id: pro.id },
      data: {
        ratingAvg: Math.round((agg._avg.score ?? 0) * 10) / 10,
        ratingCount: agg._count.score,
      },
    });

    console.log(`✅ ${reviews.length} opiniones para ${pro.nombre} ${pro.apellido}`);
  }

  console.log("\n✨ Seed de opiniones completado.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
