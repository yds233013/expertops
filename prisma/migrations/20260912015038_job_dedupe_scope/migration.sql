-- CreateEnum
CREATE TYPE "DedupeScope" AS ENUM ('DISPOSABLE', 'DURABLE');

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "dedupeScope" "DedupeScope" NOT NULL DEFAULT 'DURABLE';

-- CreateIndex
CREATE INDEX "Job_status_dedupeScope_finishedAt_idx" ON "Job"("status", "dedupeScope", "finishedAt");

-- Backfill. Existing rows default to DURABLE, which is the safe direction but
-- would make the whole accumulated scheduler history un-prunable. These three
-- key shapes carry a timestamp or a tick bucket, so their keys can never be
-- reused and are safe to free. Every other existing key is left DURABLE.
UPDATE "Job"
SET "dedupeScope" = 'DISPOSABLE'
WHERE "dedupeKey" IS NOT NULL
  AND (
        "dedupeKey" LIKE 'schedule:%'
     OR "dedupeKey" LIKE 'invitation.send:%'
     OR "dedupeKey" LIKE 'readiness.recheck:%'
     OR "dedupeKey" LIKE 'staffing.propose_replacements:%'
  );
