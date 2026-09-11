-- AlterTable
ALTER TABLE "ActivityEvent" ADD COLUMN     "candidateId" TEXT;

-- CreateIndex
CREATE INDEX "ActivityEvent_candidateId_createdAt_idx" ON "ActivityEvent"("candidateId", "createdAt");
