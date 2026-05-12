-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "urssafSapEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Customer" ADD COLUMN "urssafSapRef" TEXT;
