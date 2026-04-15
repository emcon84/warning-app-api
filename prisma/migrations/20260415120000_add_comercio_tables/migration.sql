-- CreateTable
CREATE TABLE "Comercio" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "rubro" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "descripcion" TEXT,
    "direccion" TEXT,
    "barrio" TEXT NOT NULL,
    "whatsapp" TEXT NOT NULL,
    "telefono" TEXT,
    "horario" TEXT,
    "foto" TEXT,
    "fotos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comercio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComercioOffer" (
    "id" TEXT NOT NULL,
    "comercioId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "descripcion" TEXT,
    "precio" TEXT,
    "foto" TEXT,
    "validaHasta" TIMESTAMP(3),
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComercioOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Comercio_clerkUserId_key" ON "Comercio"("clerkUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Comercio_slug_key" ON "Comercio"("slug");

-- CreateIndex
CREATE INDEX "Comercio_barrio_idx" ON "Comercio"("barrio");

-- CreateIndex
CREATE INDEX "Comercio_rubro_idx" ON "Comercio"("rubro");

-- CreateIndex
CREATE INDEX "Comercio_activo_idx" ON "Comercio"("activo");

-- CreateIndex
CREATE INDEX "ComercioOffer_comercioId_idx" ON "ComercioOffer"("comercioId");

-- CreateIndex
CREATE INDEX "ComercioOffer_activa_idx" ON "ComercioOffer"("activa");

-- AddForeignKey
ALTER TABLE "ComercioOffer" ADD CONSTRAINT "ComercioOffer_comercioId_fkey" FOREIGN KEY ("comercioId") REFERENCES "Comercio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
