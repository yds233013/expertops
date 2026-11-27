-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('BOUNCE', 'COMPLAINT', 'MANUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutboxStatus" ADD VALUE 'SUPPRESSED';
ALTER TYPE "OutboxStatus" ADD VALUE 'BOUNCED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentBatchStatus" ADD VALUE 'PAYING';
ALTER TYPE "PaymentBatchStatus" ADD VALUE 'PAID';

-- AlterEnum
ALTER TYPE "PaymentItemStatus" ADD VALUE 'PAID';

-- AlterTable
ALTER TABLE "AttentionItem" ADD COLUMN     "slackNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Expert" ADD COLUMN     "payoutRequirementsDue" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "payoutStatusUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeAccountId" TEXT;

-- AlterTable
ALTER TABLE "OutboxMessage" ADD COLUMN     "bouncedAt" TIMESTAMP(3),
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'simulated',
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "suppressedReason" TEXT;

-- AlterTable
ALTER TABLE "PaymentBatch" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paidById" TEXT;

-- AlterTable
ALTER TABLE "PaymentItem" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "payoutError" TEXT,
ADD COLUMN     "stripeTransferId" TEXT;

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");

-- CreateIndex
CREATE INDEX "WebhookEvent_provider_receivedAt_idx" ON "WebhookEvent"("provider", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Expert_stripeAccountId_key" ON "Expert"("stripeAccountId");

-- CreateIndex
CREATE INDEX "OutboxMessage_providerMessageId_idx" ON "OutboxMessage"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentItem_stripeTransferId_key" ON "PaymentItem"("stripeTransferId");

