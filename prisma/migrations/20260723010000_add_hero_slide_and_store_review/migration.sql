-- CreateTable: StoreReview
CREATE TABLE "StoreReview" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable: HeroSlide
CREATE TABLE "HeroSlide" (
    "id" TEXT NOT NULL,
    "slideType" TEXT NOT NULL,
    "refId" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "ctaText" TEXT,
    "ctaUrl" TEXT,
    "imageUrl" TEXT,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeroSlide_pkey" PRIMARY KEY ("id")
);

-- DropTable: HeroSlideBg
DROP TABLE "HeroSlideBg";

-- CreateIndex
CREATE INDEX "StoreReview_storeId_idx" ON "StoreReview"("storeId");
CREATE INDEX "StoreReview_userId_idx" ON "StoreReview"("userId");
CREATE INDEX "StoreReview_score_idx" ON "StoreReview"("score");

-- CreateIndex
CREATE INDEX "HeroSlide_slideType_idx" ON "HeroSlide"("slideType");
CREATE INDEX "HeroSlide_isPinned_idx" ON "HeroSlide"("isPinned");
CREATE INDEX "HeroSlide_sortOrder_idx" ON "HeroSlide"("sortOrder");
CREATE INDEX "HeroSlide_startsAt_idx" ON "HeroSlide"("startsAt");
CREATE INDEX "HeroSlide_endsAt_idx" ON "HeroSlide"("endsAt");

-- AddForeignKey
ALTER TABLE "StoreReview" ADD CONSTRAINT "StoreReview_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Comercio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreReview" ADD CONSTRAINT "StoreReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
