-- AlterTable
ALTER TABLE "Report" ADD COLUMN "photos" TEXT[];

-- Migrar datos existentes: convertir photo a photos array
UPDATE "Report" SET "photos" = ARRAY[photo] WHERE photo IS NOT NULL;
