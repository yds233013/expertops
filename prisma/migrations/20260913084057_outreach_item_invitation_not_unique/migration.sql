-- DropIndex
DROP INDEX "OutreachBatchItem_invitationId_key";

-- CreateIndex
CREATE INDEX "OutreachBatchItem_invitationId_idx" ON "OutreachBatchItem"("invitationId");
