-- CreateEnum
CREATE TYPE "TaskCheckStatus" AS ENUM ('COMPLETED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "TaskVerdict" AS ENUM ('BROKEN_SPEC', 'ANSWER_LEAK', 'TOO_EASY', 'DISCRIMINATING', 'UNSOLVED');

-- CreateEnum
CREATE TYPE "GoldDecision" AS ENUM ('APPROVE', 'REVISE');

-- AlterTable
ALTER TABLE "WorkSubmission" ADD COLUMN     "taskSpec" JSONB;

-- CreateTable
CREATE TABLE "TaskCheck" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "TaskCheckStatus" NOT NULL,
    "verdict" "TaskVerdict",
    "requestedAttempts" INTEGER NOT NULL,
    "validAttempts" INTEGER NOT NULL,
    "passes" INTEGER NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "inconclusiveReason" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostMicros" INTEGER,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldTask" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "domainId" TEXT,
    "prompt" TEXT NOT NULL,
    "referenceAnswer" TEXT NOT NULL,
    "checker" JSONB NOT NULL,
    "expectedDecision" "GoldDecision" NOT NULL,
    "rationale" TEXT NOT NULL,
    "createdById" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldAnswer" (
    "id" TEXT NOT NULL,
    "goldTaskId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "GoldDecision" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "correct" BOOLEAN NOT NULL,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoldAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskCheck_submissionId_key" ON "TaskCheck"("submissionId");

-- CreateIndex
CREATE INDEX "TaskCheck_verdict_idx" ON "TaskCheck"("verdict");

-- CreateIndex
CREATE INDEX "TaskCheck_expertId_checkedAt_idx" ON "TaskCheck"("expertId", "checkedAt");

-- CreateIndex
CREATE INDEX "TaskCheck_projectId_checkedAt_idx" ON "TaskCheck"("projectId", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GoldTask_reference_key" ON "GoldTask"("reference");

-- CreateIndex
CREATE INDEX "GoldTask_retiredAt_idx" ON "GoldTask"("retiredAt");

-- CreateIndex
CREATE INDEX "GoldAnswer_reviewerId_idx" ON "GoldAnswer"("reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "GoldAnswer_goldTaskId_reviewerId_key" ON "GoldAnswer"("goldTaskId", "reviewerId");

-- AddForeignKey
ALTER TABLE "TaskCheck" ADD CONSTRAINT "TaskCheck_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "WorkSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCheck" ADD CONSTRAINT "TaskCheck_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCheck" ADD CONSTRAINT "TaskCheck_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCheck" ADD CONSTRAINT "TaskCheck_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldTask" ADD CONSTRAINT "GoldTask_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldTask" ADD CONSTRAINT "GoldTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldAnswer" ADD CONSTRAINT "GoldAnswer_goldTaskId_fkey" FOREIGN KEY ("goldTaskId") REFERENCES "GoldTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldAnswer" ADD CONSTRAINT "GoldAnswer_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

