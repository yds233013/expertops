-- AlterTable
ALTER TABLE "Screening" ADD COLUMN     "revisionFeedback" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "revisionRequestedAt" TIMESTAMP(3);
