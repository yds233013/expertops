-- CreateEnum
CREATE TYPE "ScreeningCheckStatus" AS ENUM ('PENDING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "AccessSystem" AS ENUM ('GITHUB', 'SLACK');

-- CreateEnum
CREATE TYPE "AccessGrantStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKING', 'REVOKED', 'GRANT_FAILED', 'REVOKE_FAILED');

-- AlterTable
ALTER TABLE "Expert" ADD COLUMN     "githubUsername" TEXT,
ADD COLUMN     "slackUserId" TEXT;

-- CreateTable
CREATE TABLE "ScreeningCheck" (
    "id" TEXT NOT NULL,
    "screeningId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "status" "ScreeningCheckStatus" NOT NULL DEFAULT 'PENDING',
    "scorerProvider" TEXT NOT NULL DEFAULT 'simulated',
    "scorerModel" TEXT NOT NULL DEFAULT '',
    "suggestedScores" JSONB NOT NULL DEFAULT '[]',
    "suggestedTotal" INTEGER,
    "maxTotal" INTEGER,
    "suggestedPass" BOOLEAN,
    "summary" TEXT NOT NULL DEFAULT '',
    "evidenceMode" TEXT NOT NULL DEFAULT 'simulated',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "flags" JSONB NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER,
    "error" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAccessResource" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "system" "AccessSystem" NOT NULL,
    "resource" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "permission" TEXT NOT NULL DEFAULT 'push',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectAccessResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessGrant" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "system" "AccessSystem" NOT NULL,
    "status" "AccessGrantStatus" NOT NULL DEFAULT 'PENDING',
    "subject" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'simulated',
    "invitationId" TEXT,
    "invitationPending" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "revokeReason" TEXT,
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningCheck_submissionId_key" ON "ScreeningCheck"("submissionId");

-- CreateIndex
CREATE INDEX "ScreeningCheck_screeningId_idx" ON "ScreeningCheck"("screeningId");

-- CreateIndex
CREATE INDEX "ScreeningCheck_status_idx" ON "ScreeningCheck"("status");

-- CreateIndex
CREATE INDEX "ProjectAccessResource_projectId_removedAt_idx" ON "ProjectAccessResource"("projectId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAccessResource_projectId_system_resource_key" ON "ProjectAccessResource"("projectId", "system", "resource");

-- CreateIndex
CREATE INDEX "AccessGrant_status_idx" ON "AccessGrant"("status");

-- CreateIndex
CREATE INDEX "AccessGrant_projectId_expertId_idx" ON "AccessGrant"("projectId", "expertId");

-- CreateIndex
CREATE INDEX "AccessGrant_expertId_status_idx" ON "AccessGrant"("expertId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_resourceId_expertId_key" ON "AccessGrant"("resourceId", "expertId");

-- AddForeignKey
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_screeningId_fkey" FOREIGN KEY ("screeningId") REFERENCES "Screening"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ScreeningSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAccessResource" ADD CONSTRAINT "ProjectAccessResource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "ProjectAccessResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

