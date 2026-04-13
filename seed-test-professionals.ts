/**
 * Seed: profesionales de prueba
 * Run: bun run seed-test-professionals.ts
 *
 * - Slugs arrancan con "test-" → el frontend detecta y muestra badge TEST
 * - Todos comparten el whatsapp y clerkUserId del profesional real
 *   (los chats llegan a emcon84@gmail.com)
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const WHATSAPP = "+5493482445015";
const CLERK_USER_ID_BASE = "test_pro_"; // IDs ficticios únicos

const professionals = [
  {
    nombre: "Carlos",
    apellido: "Méndez",
    slug: "test-carlos-mendez-plomero",
    oficios: ["plomero"],
    barrio: "Centro",
    descripcion:
      "Plomero matriculado con más de 15 años de experiencia. Reparación de cañerías, destapes, instalaciones sanitarias completas. Trabajo garantizado y presupuesto sin cargo.",
    ratingAvg: 4.8,
    ratingCount: 23,
    disponible: true,
  },
  {
    nombre: "Roberto",
    apellido: "Silva",
    slug: "test-roberto-silva-electricista",
    oficios: ["electricista"],
    barrio: "Barrio Norte",
    descripcion:
      "Electricista matriculado. Instalaciones domiciliarias e industriales, tableros, iluminación LED, automatizaciones. Servicio de urgencias disponible.",
    ratingAvg: 4.5,
    ratingCount: 17,
    disponible: true,
  },
  {
    nombre: "Diego",
    apellido: "González",
    slug: "test-diego-gonzalez-pintor",
    oficios: ["pintor"],
    barrio: "Barrio Sur",
    descripcion:
      "Pintor profesional. Interior y exterior, impermeabilizaciones, texturados, enduído y pintura al latex. Prolijidad y puntualidad garantizadas.",
    ratingAvg: 4.2,
    ratingCount: 31,
    disponible: true,
  },
  {
    nombre: "Miguel",
    apellido: "Torres",
    slug: "test-miguel-torres-carpintero",
    oficios: ["carpintero"],
    barrio: "Centro",
    descripcion:
      "Carpintero y mueblero. Fabricación a medida, reparaciones, decks, pergolas y revestimientos de madera. Materiales de primera calidad.",
    ratingAvg: 4.9,
    ratingCount: 8,
    disponible: true,
  },
  {
    nombre: "Juan",
    apellido: "Romero",
    slug: "test-juan-romero-gasista",
    oficios: ["gasista matriculado"],
    barrio: "Barrio Este",
    descripcion:
      "Gasista matriculado por Enargas. Instalaciones de gas, service de calefones y calderas, detección de pérdidas. Habilitaciones municipales.",
    ratingAvg: 4.6,
    ratingCount: 14,
    disponible: true,
  },
  {
    nombre: "Sergio",
    apellido: "López",
    slug: "test-sergio-lopez-albanil",
    oficios: ["albañil"],
    barrio: "Barrio Oeste",
    descripcion:
      "Albañil con amplia trayectoria. Construcciones, refacciones, contrapisos, revoques, colocación de cerámicos y rejas. Presupuesto gratis.",
    ratingAvg: 4.3,
    ratingCount: 19,
    disponible: true,
  },
  {
    nombre: "Pablo",
    apellido: "Martínez",
    slug: "test-pablo-martinez-jardinero",
    oficios: ["jardinero"],
    barrio: "Barrio Norte",
    descripcion:
      "Paisajista y jardinero. Diseño de jardines, mantenimiento, poda, hidrosiembra, riego automático. Trabajos semanales o por temporada.",
    ratingAvg: 4.7,
    ratingCount: 11,
    disponible: true,
  },
  {
    nombre: "Martín",
    apellido: "Giménez",
    slug: "test-martin-gimenez-cerrajero",
    oficios: ["cerrajero"],
    barrio: "Centro",
    descripcion:
      "Cerrajero 24 hs. Apertura de puertas, cambio de cilindros, cajas de seguridad, duplicado de llaves y alarmas. Urgencias sin cargo adicional.",
    ratingAvg: 4.4,
    ratingCount: 26,
    disponible: true,
  },
  {
    nombre: "Ana",
    apellido: "Fernández",
    slug: "test-ana-fernandez-disenadora",
    oficios: ["diseñadora gráfica", "ilustradora"],
    barrio: "Centro",
    descripcion:
      "Diseñadora gráfica y visual. Logos, identidad corporativa, redes sociales, cartelería y material impreso. Trabajos con entrega rápida.",
    ratingAvg: 4.8,
    ratingCount: 12,
    disponible: true,
  },
  {
    nombre: "Federico",
    apellido: "Pérez",
    slug: "test-federico-perez-tecnico",
    oficios: ["técnico en computación", "soporte técnico"],
    barrio: "Barrio Sur",
    descripcion:
      "Técnico en informática. Reparación de PC y notebooks, instalación de redes WiFi, recuperación de datos, formateos y virus. Servicio a domicilio.",
    ratingAvg: 5.0,
    ratingCount: 5,
    disponible: false,
  },
];

async function seed() {
  console.log("🌱 Creando profesionales de prueba...\n");

  for (const pro of professionals) {
    const clerkUserId = `${CLERK_USER_ID_BASE}${pro.slug}`;

    const created = await prisma.professional.upsert({
      where: { slug: pro.slug },
      update: {
        whatsapp: WHATSAPP,
        telefono: "3482 445015",
        ratingAvg: pro.ratingAvg,
        ratingCount: pro.ratingCount,
        disponible: pro.disponible,
        activo: true,
      },
      create: {
        clerkUserId,
        nombre: pro.nombre,
        apellido: pro.apellido,
        slug: pro.slug,
        oficios: pro.oficios,
        barrio: pro.barrio,
        descripcion: pro.descripcion,
        whatsapp: WHATSAPP,
        telefono: "3482 445015",
        ratingAvg: pro.ratingAvg,
        ratingCount: pro.ratingCount,
        disponible: pro.disponible,
        activo: true,
        updatedAt: new Date(),
      },
    });

    console.log(`✅ ${created.nombre} ${created.apellido} — ${pro.oficios.join(", ")} (${pro.barrio})`);
  }

  console.log(`\n✨ ${professionals.length} profesionales de prueba listos.`);
  await prisma.$disconnect();
}

seed().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
