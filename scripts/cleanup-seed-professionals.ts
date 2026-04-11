import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Los profesionales seed tienen clerkUserId del formato seed_user_XXX
  const seedProfessionals = await prisma.professional.findMany({
    where: {
      clerkUserId: {
        startsWith: "seed_user_",
      },
    },
    select: {
      id: true,
      nombre: true,
      apellido: true,
      slug: true,
      clerkUserId: true,
    },
  });

  if (seedProfessionals.length === 0) {
    console.log("No hay profesionales seed para eliminar.");
    return;
  }

  console.log(`Encontrados ${seedProfessionals.length} profesionales seed:`);
  for (const pro of seedProfessionals) {
    console.log(`  - ${pro.nombre} ${pro.apellido} (${pro.clerkUserId})`);
  }

  const ids = seedProfessionals.map((p) => p.id);

  // Eliminar en cascada: ratings, reviews, conversaciones primero
  const deletedRatings = await prisma.rating.deleteMany({
    where: { professionalId: { in: ids } },
  });

  const deletedReviews = await prisma.publicReview.deleteMany({
    where: { professionalId: { in: ids } },
  });

  // Obtener conversaciones para borrar mensajes
  const conversations = await prisma.conversation.findMany({
    where: { professionalId: { in: ids } },
    select: { id: true },
  });
  const convIds = conversations.map((c) => c.id);

  const deletedMessages = await prisma.message.deleteMany({
    where: { conversationId: { in: convIds } },
  });

  const deletedConversations = await prisma.conversation.deleteMany({
    where: { professionalId: { in: ids } },
  });

  // Finalmente eliminar los profesionales
  const deleted = await prisma.professional.deleteMany({
    where: { id: { in: ids } },
  });

  console.log(`\nLimpieza completada:`);
  console.log(`  - ${deleted.count} profesionales eliminados`);
  console.log(`  - ${deletedRatings.count} ratings eliminados`);
  console.log(`  - ${deletedReviews.count} reviews eliminadas`);
  console.log(`  - ${deletedMessages.count} mensajes eliminados`);
  console.log(`  - ${deletedConversations.count} conversaciones eliminadas`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
