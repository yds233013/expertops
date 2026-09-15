-- CreateEnum
CREATE TYPE "ContactPreference" AS ENUM ('UNKNOWN', 'EMAIL_ALL', 'EMAIL_ESSENTIAL', 'NO_CONTACT');

-- AlterTable
ALTER TABLE "Expert" ADD COLUMN     "contactPreference" "ContactPreference" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "contactPreferenceSetAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OutboxMessage" ADD COLUMN     "dedupeKey" TEXT;

-- CreateIndex
CREATE INDEX "Expert_contactPreference_idx" ON "Expert"("contactPreference");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_dedupeKey_key" ON "OutboxMessage"("dedupeKey");
