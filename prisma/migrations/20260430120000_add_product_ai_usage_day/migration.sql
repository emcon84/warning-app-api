-- CreateTable
CREATE TABLE "ProductAiUsageDay" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "comercioId" TEXT,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAiUsageDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductAiUsageDay_key_date_key" ON "ProductAiUsageDay"("key", "date");

-- CreateIndex
CREATE INDEX "ProductAiUsageDay_comercioId_idx" ON "ProductAiUsageDay"("comercioId");

-- CreateIndex
CREATE INDEX "ProductAiUsageDay_date_idx" ON "ProductAiUsageDay"("date");

-- AddForeignKey
ALTER TABLE "ProductAiUsageDay" ADD CONSTRAINT "ProductAiUsageDay_comercioId_fkey" FOREIGN KEY ("comercioId") REFERENCES "Comercio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
