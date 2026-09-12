-- CreateEnum
CREATE TYPE "OutreachItemState" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- AlterEnum
ALTER TYPE "OutreachBatchStatus" ADD VALUE 'PARTIALLY_DISPATCHED';

-- AlterTable
ALTER TABLE "OutreachBatchItem" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dispatchState" "OutreachItemState" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT;

-- CreateIndex
CREATE INDEX "OutreachBatchItem_batchId_dispatchState_idx" ON "OutreachBatchItem"("batchId", "dispatchState");
