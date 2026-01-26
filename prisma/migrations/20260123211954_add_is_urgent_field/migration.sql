-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "isUrgent" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Report_isUrgent_idx" ON "Report"("isUrgent");
