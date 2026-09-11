-- CreateEnum
CREATE TYPE "SourcingCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SourceChannelKind" AS ENUM ('REFERRAL', 'COMMUNITY', 'DIRECT_APPLICATION', 'EVENT', 'IMPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "CandidateStage" AS ENUM ('NEW', 'DUPLICATE_HOLD', 'SCREENING_INVITED', 'SCREENING_SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED', 'QUALIFIED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('SUBMITTED', 'ACKNOWLEDGED', 'SCREENING_STARTED', 'CLOSED_QUALIFIED', 'CLOSED_REJECTED', 'CLOSED_WITHDRAWN');

-- CreateEnum
CREATE TYPE "DuplicateFlagStatus" AS ENUM ('OPEN', 'CONFIRMED_SAME', 'CONFIRMED_DIFFERENT');

-- CreateEnum
CREATE TYPE "RubricStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('NONE', 'WORK_SAMPLE_LINK', 'WRITTEN_ANSWER', 'REFERENCE_STATEMENT');

-- CreateEnum
CREATE TYPE "ScreeningStatus" AS ENUM ('INVITED', 'SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED', 'DECIDED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ScreeningOutcome" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('ASSIGNED', 'SUBMITTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_REVISION');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "QualificationStatus" AS ENUM ('ACTIVE', 'NEEDS_REREVIEW', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AttentionKind" AS ENUM ('BUSINESS_BLOCKER', 'AUTOMATION_FAILURE');

-- CreateEnum
CREATE TYPE "AttentionSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AttentionStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "OutreachBatchKind" AS ENUM ('PROJECT_INVITATION', 'REPLACEMENT', 'SCREENING_INVITATION');

-- CreateEnum
CREATE TYPE "OutreachBatchStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'DISPATCHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkBasis" AS ENUM ('HOURLY', 'DELIVERABLE');

-- CreateEnum
CREATE TYPE "WorkItemStatus" AS ENUM ('DRAFT', 'ASSIGNED', 'SUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED', 'APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkReviewState" AS ENUM ('PENDING', 'REVISION_REQUESTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "SupportCategory" AS ENUM ('ACCESS', 'SCOPE_QUESTION', 'TOOLING', 'SCHEDULING', 'PAYMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'WAITING_ON_EXPERT', 'WAITING_ON_OPS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportAuthorType" AS ENUM ('OPERATOR', 'EXPERT');

-- CreateEnum
CREATE TYPE "PaymentItemStatus" AS ENUM ('DRAFT', 'READY', 'IN_BATCH', 'EXPORTED', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentBatchStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXPORTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OffboardingTaskStatus" AS ENUM ('PENDING', 'CONFIRMED', 'NOT_APPLICABLE');

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourcingCampaign" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "projectId" TEXT,
    "targetCount" INTEGER NOT NULL DEFAULT 1,
    "status" "SourcingCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "ownerId" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourcingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceChannel" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SourceChannelKind" NOT NULL DEFAULT 'OTHER',
    "notes" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "headline" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "yearsExperience" INTEGER NOT NULL DEFAULT 0,
    "stage" "CandidateStage" NOT NULL DEFAULT 'NEW',
    "sourceChannelId" TEXT,
    "referredByExpertId" TEXT,
    "campaignId" TEXT,
    "relationshipOwnerId" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "nextActionAt" TIMESTAMP(3),
    "nextActionNote" TEXT NOT NULL DEFAULT '',
    "contactOptOutAt" TIMESTAMP(3),
    "contactOptOutReason" TEXT,
    "expertId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "campaignId" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "workSampleLinks" JSONB NOT NULL DEFAULT '[]',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateFlag" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "matchedCandidateId" TEXT,
    "matchedExpertId" TEXT,
    "reason" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "status" "DuplicateFlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidatePortalToken" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'SCREENING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "devPlaintext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidatePortalToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidatePortalSession" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidatePortalSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningTemplate" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreeningTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningRubricVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RubricStatus" NOT NULL DEFAULT 'DRAFT',
    "passThreshold" INTEGER NOT NULL DEFAULT 0,
    "guidance" TEXT NOT NULL DEFAULT '',
    "changeNote" TEXT NOT NULL DEFAULT '',
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScreeningRubricVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RubricCriterion" (
    "id" TEXT NOT NULL,
    "rubricVersionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scoringGuidance" TEXT NOT NULL DEFAULT '',
    "maxScore" INTEGER NOT NULL DEFAULT 5,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "requiredEvidence" "EvidenceKind" NOT NULL DEFAULT 'NONE',
    "isGating" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RubricCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Screening" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "rubricVersionId" TEXT NOT NULL,
    "status" "ScreeningStatus" NOT NULL DEFAULT 'INVITED',
    "outcome" "ScreeningOutcome",
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "reviewDueAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "currentRevision" INTEGER NOT NULL DEFAULT 0,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastRemindedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Screening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningSubmission" (
    "id" TEXT NOT NULL,
    "screeningId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "workSampleLinks" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT NOT NULL DEFAULT '',
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "missingEvidence" JSONB NOT NULL DEFAULT '[]',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreeningSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningReview" (
    "id" TEXT NOT NULL,
    "screeningId" TEXT NOT NULL,
    "submissionId" TEXT,
    "reviewerId" TEXT NOT NULL,
    "state" "ReviewState" NOT NULL DEFAULT 'ASSIGNED',
    "decision" "ReviewDecision",
    "scores" JSONB NOT NULL DEFAULT '{}',
    "publicFeedback" TEXT NOT NULL DEFAULT '',
    "privateNotes" TEXT NOT NULL DEFAULT '',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastRemindedAt" TIMESTAMP(3),

    CONSTRAINT "ScreeningReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewConflict" (
    "id" TEXT NOT NULL,
    "screeningId" TEXT NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "summary" TEXT NOT NULL,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" "ReviewDecision",
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Qualification" (
    "id" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "rubricVersionId" TEXT NOT NULL,
    "screeningId" TEXT,
    "status" "QualificationStatus" NOT NULL DEFAULT 'ACTIVE',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rereviewReason" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Qualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectQualificationRequirement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "minRubricVersionId" TEXT NOT NULL,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectQualificationRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttentionItem" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" "AttentionKind" NOT NULL DEFAULT 'BUSINESS_BLOCKER',
    "category" TEXT NOT NULL,
    "severity" "AttentionSeverity" NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "blocker" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "nextAction" TEXT NOT NULL,
    "ownerId" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" "AttentionStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedReason" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "projectId" TEXT,
    "expertId" TEXT,
    "candidateId" TEXT,
    "screeningId" TEXT,
    "assignmentId" TEXT,
    "workItemId" TEXT,
    "supportRequestId" TEXT,
    "paymentBatchId" TEXT,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttentionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachBatch" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" "OutreachBatchKind" NOT NULL,
    "status" "OutreachBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "projectId" TEXT,
    "campaignId" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "expertId" TEXT,
    "candidateId" TEXT,
    "invitationId" TEXT,
    "rationale" TEXT NOT NULL DEFAULT '',
    "matchScore" INTEGER,
    "skippedReason" TEXT,

    CONSTRAINT "OutreachBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "basis" "WorkBasis" NOT NULL DEFAULT 'DELIVERABLE',
    "dueAt" TIMESTAMP(3),
    "status" "WorkItemStatus" NOT NULL DEFAULT 'DRAFT',
    "currentRevision" INTEGER NOT NULL DEFAULT 0,
    "approvedQuantity" DECIMAL(10,2),
    "approvedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSubmission" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "hoursClaimed" DECIMAL(10,2),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkReview" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "reviewerId" TEXT,
    "state" "WorkReviewState" NOT NULL DEFAULT 'PENDING',
    "feedback" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT NOT NULL DEFAULT '',
    "revisionRequest" TEXT,
    "approvedQuantity" DECIMAL(10,2),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportRequest" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "projectId" TEXT,
    "category" "SupportCategory" NOT NULL DEFAULT 'OTHER',
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "ownerId" TEXT,
    "blocksReadiness" BOOLEAN NOT NULL DEFAULT false,
    "blocksDelivery" BOOLEAN NOT NULL DEFAULT false,
    "responseDueAt" TIMESTAMP(3),
    "firstRespondedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportReply" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "authorType" "SupportAuthorType" NOT NULL,
    "authorUserId" TEXT,
    "authorExpertId" TEXT,
    "body" TEXT NOT NULL,
    "internalOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentItem" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workItemId" TEXT,
    "workReviewId" TEXT,
    "basis" "WorkBasis" NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "rateMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "amountMinor" INTEGER NOT NULL,
    "status" "PaymentItemStatus" NOT NULL DEFAULT 'DRAFT',
    "batchId" TEXT,
    "discrepancies" JSONB NOT NULL DEFAULT '[]',
    "discrepancyResolvedById" TEXT,
    "discrepancyResolvedAt" TIMESTAMP(3),
    "discrepancyResolution" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "supersededById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentBatch" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "PaymentBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "exportedAt" TIMESTAMP(3),
    "exportedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OffboardingTask" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "OffboardingTaskStatus" NOT NULL DEFAULT 'PENDING',
    "ownerId" TEXT,
    "dueAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OffboardingTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Domain_slug_key" ON "Domain"("slug");

-- CreateIndex
CREATE INDEX "Domain_isActive_idx" ON "Domain"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SourcingCampaign_code_key" ON "SourcingCampaign"("code");

-- CreateIndex
CREATE INDEX "SourcingCampaign_status_domainId_idx" ON "SourcingCampaign"("status", "domainId");

-- CreateIndex
CREATE INDEX "SourcingCampaign_projectId_idx" ON "SourcingCampaign"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceChannel_slug_key" ON "SourceChannel"("slug");

-- CreateIndex
CREATE INDEX "SourceChannel_kind_isActive_idx" ON "SourceChannel"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_reference_key" ON "Candidate"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_expertId_key" ON "Candidate"("expertId");

-- CreateIndex
CREATE INDEX "Candidate_stage_idx" ON "Candidate"("stage");

-- CreateIndex
CREATE INDEX "Candidate_email_idx" ON "Candidate"("email");

-- CreateIndex
CREATE INDEX "Candidate_relationshipOwnerId_nextActionAt_idx" ON "Candidate"("relationshipOwnerId", "nextActionAt");

-- CreateIndex
CREATE INDEX "Candidate_campaignId_idx" ON "Candidate"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_reference_key" ON "Application"("reference");

-- CreateIndex
CREATE INDEX "Application_status_submittedAt_idx" ON "Application"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "Application_candidateId_idx" ON "Application"("candidateId");

-- CreateIndex
CREATE INDEX "DuplicateFlag_status_idx" ON "DuplicateFlag"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateFlag_candidateId_matchedCandidateId_key" ON "DuplicateFlag"("candidateId", "matchedCandidateId");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateFlag_candidateId_matchedExpertId_key" ON "DuplicateFlag"("candidateId", "matchedExpertId");

-- CreateIndex
CREATE UNIQUE INDEX "CandidatePortalToken_tokenHash_key" ON "CandidatePortalToken"("tokenHash");

-- CreateIndex
CREATE INDEX "CandidatePortalToken_candidateId_idx" ON "CandidatePortalToken"("candidateId");

-- CreateIndex
CREATE INDEX "CandidatePortalToken_expiresAt_idx" ON "CandidatePortalToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CandidatePortalSession_tokenHash_key" ON "CandidatePortalSession"("tokenHash");

-- CreateIndex
CREATE INDEX "CandidatePortalSession_candidateId_idx" ON "CandidatePortalSession"("candidateId");

-- CreateIndex
CREATE INDEX "CandidatePortalSession_expiresAt_idx" ON "CandidatePortalSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningTemplate_slug_key" ON "ScreeningTemplate"("slug");

-- CreateIndex
CREATE INDEX "ScreeningTemplate_domainId_isActive_idx" ON "ScreeningTemplate"("domainId", "isActive");

-- CreateIndex
CREATE INDEX "ScreeningRubricVersion_status_idx" ON "ScreeningRubricVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningRubricVersion_templateId_version_key" ON "ScreeningRubricVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "RubricCriterion_rubricVersionId_position_idx" ON "RubricCriterion"("rubricVersionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "RubricCriterion_rubricVersionId_key_key" ON "RubricCriterion"("rubricVersionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Screening_reference_key" ON "Screening"("reference");

-- CreateIndex
CREATE INDEX "Screening_status_reviewDueAt_idx" ON "Screening"("status", "reviewDueAt");

-- CreateIndex
CREATE INDEX "Screening_candidateId_idx" ON "Screening"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningSubmission_screeningId_revision_key" ON "ScreeningSubmission"("screeningId", "revision");

-- CreateIndex
CREATE INDEX "ScreeningReview_state_dueAt_idx" ON "ScreeningReview"("state", "dueAt");

-- CreateIndex
CREATE INDEX "ScreeningReview_reviewerId_state_idx" ON "ScreeningReview"("reviewerId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningReview_screeningId_reviewerId_key" ON "ScreeningReview"("screeningId", "reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewConflict_screeningId_key" ON "ReviewConflict"("screeningId");

-- CreateIndex
CREATE INDEX "ReviewConflict_status_idx" ON "ReviewConflict"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Qualification_screeningId_key" ON "Qualification"("screeningId");

-- CreateIndex
CREATE INDEX "Qualification_expertId_status_idx" ON "Qualification"("expertId", "status");

-- CreateIndex
CREATE INDEX "Qualification_domainId_status_idx" ON "Qualification"("domainId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Qualification_expertId_domainId_rubricVersionId_key" ON "Qualification"("expertId", "domainId", "rubricVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectQualificationRequirement_projectId_domainId_key" ON "ProjectQualificationRequirement"("projectId", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "AttentionItem_dedupeKey_key" ON "AttentionItem"("dedupeKey");

-- CreateIndex
CREATE INDEX "AttentionItem_status_severity_dueAt_idx" ON "AttentionItem"("status", "severity", "dueAt");

-- CreateIndex
CREATE INDEX "AttentionItem_status_kind_idx" ON "AttentionItem"("status", "kind");

-- CreateIndex
CREATE INDEX "AttentionItem_ownerId_status_idx" ON "AttentionItem"("ownerId", "status");

-- CreateIndex
CREATE INDEX "AttentionItem_projectId_status_idx" ON "AttentionItem"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachBatch_reference_key" ON "OutreachBatch"("reference");

-- CreateIndex
CREATE INDEX "OutreachBatch_status_kind_idx" ON "OutreachBatch"("status", "kind");

-- CreateIndex
CREATE INDEX "OutreachBatch_projectId_idx" ON "OutreachBatch"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachBatchItem_invitationId_key" ON "OutreachBatchItem"("invitationId");

-- CreateIndex
CREATE INDEX "OutreachBatchItem_batchId_idx" ON "OutreachBatchItem"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachBatchItem_batchId_expertId_key" ON "OutreachBatchItem"("batchId", "expertId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_reference_key" ON "WorkItem"("reference");

-- CreateIndex
CREATE INDEX "WorkItem_projectId_status_idx" ON "WorkItem"("projectId", "status");

-- CreateIndex
CREATE INDEX "WorkItem_expertId_status_idx" ON "WorkItem"("expertId", "status");

-- CreateIndex
CREATE INDEX "WorkItem_status_dueAt_idx" ON "WorkItem"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkSubmission_workItemId_revision_key" ON "WorkSubmission"("workItemId", "revision");

-- CreateIndex
CREATE INDEX "WorkReview_workItemId_state_idx" ON "WorkReview"("workItemId", "state");

-- CreateIndex
CREATE INDEX "WorkReview_state_idx" ON "WorkReview"("state");

-- CreateIndex
CREATE UNIQUE INDEX "SupportRequest_reference_key" ON "SupportRequest"("reference");

-- CreateIndex
CREATE INDEX "SupportRequest_status_responseDueAt_idx" ON "SupportRequest"("status", "responseDueAt");

-- CreateIndex
CREATE INDEX "SupportRequest_expertId_status_idx" ON "SupportRequest"("expertId", "status");

-- CreateIndex
CREATE INDEX "SupportRequest_projectId_status_idx" ON "SupportRequest"("projectId", "status");

-- CreateIndex
CREATE INDEX "SupportReply_requestId_createdAt_idx" ON "SupportReply"("requestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentItem_reference_key" ON "PaymentItem"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentItem_workItemId_key" ON "PaymentItem"("workItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentItem_workReviewId_key" ON "PaymentItem"("workReviewId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentItem_supersededById_key" ON "PaymentItem"("supersededById");

-- CreateIndex
CREATE INDEX "PaymentItem_status_expertId_idx" ON "PaymentItem"("status", "expertId");

-- CreateIndex
CREATE INDEX "PaymentItem_batchId_idx" ON "PaymentItem"("batchId");

-- CreateIndex
CREATE INDEX "PaymentItem_projectId_status_idx" ON "PaymentItem"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentBatch_reference_key" ON "PaymentBatch"("reference");

-- CreateIndex
CREATE INDEX "PaymentBatch_status_idx" ON "PaymentBatch"("status");

-- CreateIndex
CREATE INDEX "OffboardingTask_status_dueAt_idx" ON "OffboardingTask"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "OffboardingTask_projectId_expertId_key_key" ON "OffboardingTask"("projectId", "expertId", "key");

-- AddForeignKey
ALTER TABLE "SourcingCampaign" ADD CONSTRAINT "SourcingCampaign_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourcingCampaign" ADD CONSTRAINT "SourcingCampaign_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourcingCampaign" ADD CONSTRAINT "SourcingCampaign_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourcingCampaign" ADD CONSTRAINT "SourcingCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_sourceChannelId_fkey" FOREIGN KEY ("sourceChannelId") REFERENCES "SourceChannel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_referredByExpertId_fkey" FOREIGN KEY ("referredByExpertId") REFERENCES "Expert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SourcingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_relationshipOwnerId_fkey" FOREIGN KEY ("relationshipOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_matchedCandidateId_fkey" FOREIGN KEY ("matchedCandidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_matchedExpertId_fkey" FOREIGN KEY ("matchedExpertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidatePortalToken" ADD CONSTRAINT "CandidatePortalToken_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningTemplate" ADD CONSTRAINT "ScreeningTemplate_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningRubricVersion" ADD CONSTRAINT "ScreeningRubricVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ScreeningTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningRubricVersion" ADD CONSTRAINT "ScreeningRubricVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RubricCriterion" ADD CONSTRAINT "RubricCriterion_rubricVersionId_fkey" FOREIGN KEY ("rubricVersionId") REFERENCES "ScreeningRubricVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Screening" ADD CONSTRAINT "Screening_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Screening" ADD CONSTRAINT "Screening_rubricVersionId_fkey" FOREIGN KEY ("rubricVersionId") REFERENCES "ScreeningRubricVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Screening" ADD CONSTRAINT "Screening_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningSubmission" ADD CONSTRAINT "ScreeningSubmission_screeningId_fkey" FOREIGN KEY ("screeningId") REFERENCES "Screening"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningReview" ADD CONSTRAINT "ScreeningReview_screeningId_fkey" FOREIGN KEY ("screeningId") REFERENCES "Screening"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningReview" ADD CONSTRAINT "ScreeningReview_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "ScreeningSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningReview" ADD CONSTRAINT "ScreeningReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewConflict" ADD CONSTRAINT "ReviewConflict_screeningId_fkey" FOREIGN KEY ("screeningId") REFERENCES "Screening"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewConflict" ADD CONSTRAINT "ReviewConflict_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Qualification" ADD CONSTRAINT "Qualification_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Qualification" ADD CONSTRAINT "Qualification_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Qualification" ADD CONSTRAINT "Qualification_rubricVersionId_fkey" FOREIGN KEY ("rubricVersionId") REFERENCES "ScreeningRubricVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Qualification" ADD CONSTRAINT "Qualification_screeningId_fkey" FOREIGN KEY ("screeningId") REFERENCES "Screening"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Qualification" ADD CONSTRAINT "Qualification_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectQualificationRequirement" ADD CONSTRAINT "ProjectQualificationRequirement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectQualificationRequirement" ADD CONSTRAINT "ProjectQualificationRequirement_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectQualificationRequirement" ADD CONSTRAINT "ProjectQualificationRequirement_minRubricVersionId_fkey" FOREIGN KEY ("minRubricVersionId") REFERENCES "ScreeningRubricVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_screeningId_fkey" FOREIGN KEY ("screeningId") REFERENCES "Screening"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachBatch" ADD CONSTRAINT "OutreachBatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachBatch" ADD CONSTRAINT "OutreachBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachBatch" ADD CONSTRAINT "OutreachBatch_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachBatchItem" ADD CONSTRAINT "OutreachBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "OutreachBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachBatchItem" ADD CONSTRAINT "OutreachBatchItem_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSubmission" ADD CONSTRAINT "WorkSubmission_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkReview" ADD CONSTRAINT "WorkReview_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkReview" ADD CONSTRAINT "WorkReview_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "WorkSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkReview" ADD CONSTRAINT "WorkReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportReply" ADD CONSTRAINT "SupportReply_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SupportRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportReply" ADD CONSTRAINT "SupportReply_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentItem" ADD CONSTRAINT "PaymentItem_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentItem" ADD CONSTRAINT "PaymentItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentItem" ADD CONSTRAINT "PaymentItem_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentItem" ADD CONSTRAINT "PaymentItem_workReviewId_fkey" FOREIGN KEY ("workReviewId") REFERENCES "WorkReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentItem" ADD CONSTRAINT "PaymentItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PaymentBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentItem" ADD CONSTRAINT "PaymentItem_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "PaymentItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatch" ADD CONSTRAINT "PaymentBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatch" ADD CONSTRAINT "PaymentBatch_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffboardingTask" ADD CONSTRAINT "OffboardingTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffboardingTask" ADD CONSTRAINT "OffboardingTask_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffboardingTask" ADD CONSTRAINT "OffboardingTask_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffboardingTask" ADD CONSTRAINT "OffboardingTask_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffboardingTask" ADD CONSTRAINT "OffboardingTask_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
