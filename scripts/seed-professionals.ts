import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const professionals = [
  {
    clerkUserId: "seed_user_001",
    nombre: "Marcos",
    apellido: "Villalba",
    slug: "marcos-villalba-plomero-rq001",
    oficios: ["plomería", "destapaciones"],
    descripcion:
      "Plomero con más de 12 años de experiencia en instalaciones de agua fría y caliente, destapaciones de cañerías y reparación de pérdidas. Trabajo en domicilios y comercios de Reconquista y alrededores. Presupuesto sin cargo.",
    barrio: "Centro",
    telefono: "03482-123456",
    whatsapp: "5493482123456",
    ratingAvg: 4.8,
    ratingCount: 23,
  },
  {
    clerkUserId: "seed_user_002",
    nombre: "Luciana",
    apellido: "Ferreyra",
    slug: "luciana-ferreyra-electricista-rq002",
    oficios: ["electricidad", "instalaciones eléctricas"],
    descripcion:
      "Electricista matriculada. Realizo instalaciones eléctricas domiciliarias, tableros, tomas y llaves, colocación de luminarias y reparaciones en general. Trabajo prolijo y con garantía. Atiendo urgencias.",
    barrio: "Barrio Norte",
    telefono: "03482-234567",
    whatsapp: "5493482234567",
    ratingAvg: 4.9,
    ratingCount: 31,
  },
  {
    clerkUserId: "seed_user_003",
    nombre: "Roberto",
    apellido: "Gómez",
    slug: "roberto-gomez-albanil-rq003",
    oficios: ["albañilería", "construcción", "refacciones"],
    descripcion:
      "Albañil con 20 años de experiencia. Construcción de viviendas, ampliaciones, refacciones, revoques, contrapisos y colocación de cerámicos. Trabajo en equipo para obras grandes o solo para trabajos menores.",
    barrio: "Villa del Parque",
    telefono: "03482-345678",
    whatsapp: "5493482345678",
    ratingAvg: 4.6,
    ratingCount: 18,
  },
  {
    clerkUserId: "seed_user_004",
    nombre: "Sebastián",
    apellido: "Ríos",
    slug: "sebastian-rios-pintor-rq004",
    oficios: ["pintura", "pintura interior", "pintura exterior"],
    descripcion:
      "Pintor profesional. Me especializo en pintura interior y exterior, enduído, texturado y decoración. Utilizo materiales de primera calidad. Trabajo limpio, puntual y con presupuesto detallado sin compromiso.",
    barrio: "Barrio Sur",
    telefono: "03482-456789",
    whatsapp: "5493482456789",
    ratingAvg: 4.7,
    ratingCount: 14,
  },
  {
    clerkUserId: "seed_user_005",
    nombre: "Diego",
    apellido: "Mamani",
    slug: "diego-mamani-gasista-rq005",
    oficios: ["gasista", "instalaciones de gas"],
    descripcion:
      "Gasista matriculado (habilitación N° 4821). Instalación y reparación de calefones, termotanques, cocinas y estufas a gas. Detección de pérdidas, instalaciones nuevas y certificaciones. Seguridad garantizada.",
    barrio: "Centro",
    telefono: "03482-567890",
    whatsapp: "5493482567890",
    ratingAvg: 5.0,
    ratingCount: 9,
  },
  {
    clerkUserId: "seed_user_006",
    nombre: "Valeria",
    apellido: "Suárez",
    slug: "valeria-suarez-jardineria-rq006",
    oficios: ["jardinería", "paisajismo", "podas"],
    descripcion:
      "Paisajista y jardinera. Diseño y mantenimiento de jardines, podas de árboles y arbustos, colocación de césped, sistemas de riego y plantas ornamentales. Trabajos semanales, quincenales o puntuales.",
    barrio: "Las Lomas",
    telefono: "03482-678901",
    whatsapp: "5493482678901",
    ratingAvg: 4.5,
    ratingCount: 7,
  },
  {
    clerkUserId: "seed_user_007",
    nombre: "Facundo",
    apellido: "Acosta",
    slug: "facundo-acosta-herrero-rq007",
    oficios: ["herrería", "soldadura", "rejas y portones"],
    descripcion:
      "Herrero con taller propio en Reconquista. Fabricación e instalación de rejas, portones, escaleras, barandas y estructuras metálicas en general. Soldadura MIG, TIG y electrodo. Presupuesto a domicilio.",
    barrio: "Parque Industrial",
    telefono: "03482-789012",
    whatsapp: "5493482789012",
    ratingAvg: 4.4,
    ratingCount: 11,
  },
  {
    clerkUserId: "seed_user_008",
    nombre: "Carla",
    apellido: "Medina",
    slug: "carla-medina-limpieza-rq008",
    oficios: ["limpieza", "limpieza de oficinas", "limpieza post obra"],
    descripcion:
      "Servicio de limpieza profesional para hogares, oficinas y comercios. También realizo limpieza post construcción y post evento. Cuento con todos los productos y herramientas. Soy puntual y comprometida con el trabajo.",
    barrio: "Barrio Oeste",
    telefono: "03482-890123",
    whatsapp: "5493482890123",
    ratingAvg: 4.8,
    ratingCount: 26,
  },
];

async function main() {
  console.log("🌱 Insertando profesionales de prueba...");

  for (const pro of professionals) {
    const existing = await prisma.professional.findUnique({
      where: { slug: pro.slug },
    });

    if (existing) {
      console.log(`⏭  Ya existe: ${pro.nombre} ${pro.apellido}`);
      continue;
    }

    await prisma.professional.create({ data: pro });
    console.log(`✅ Creado: ${pro.nombre} ${pro.apellido} — ${pro.oficios[0]}`);
  }

  console.log("\n✨ Seed completado.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
