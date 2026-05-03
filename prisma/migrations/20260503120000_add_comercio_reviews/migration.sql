-- CreateTable: ComercioReview
CREATE TABLE "ComercioReview" (
    "id" TEXT NOT NULL,
    "comercioId" TEXT NOT NULL,
    "clerkUserId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComercioReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComercioReview_comercioId_clerkUserId_key" ON "ComercioReview"("comercioId", "clerkUserId");
CREATE INDEX "ComercioReview_comercioId_idx" ON "ComercioReview"("comercioId");
CREATE INDEX "ComercioReview_createdAt_idx" ON "ComercioReview"("createdAt");
CREATE INDEX "ComercioReview_clerkUserId_idx" ON "ComercioReview"("clerkUserId");

-- AddForeignKey
ALTER TABLE "ComercioReview" ADD CONSTRAINT "ComercioReview_comercioId_fkey" FOREIGN KEY ("comercioId") REFERENCES "Comercio"("id") ON DELETE CASCADE ON UPDATE CASCADE;
