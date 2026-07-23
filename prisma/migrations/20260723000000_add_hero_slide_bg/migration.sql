-- CreateTable
CREATE TABLE "HeroSlideBg" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeroSlideBg_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HeroSlideBg_targetType_targetKey_key" ON "HeroSlideBg"("targetType", "targetKey");

-- CreateIndex
CREATE INDEX "HeroSlideBg_targetType_idx" ON "HeroSlideBg"("targetType");
