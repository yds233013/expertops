-- Explicit, server-controlled demo eligibility.
--
-- The anonymous demo previously selected records by matching a name prefix
-- ("NET ", "PRACTICE ", "SYNTHETIC "). Names are public input: an applicant
-- could call themselves "NET Someone" and place their own record — and their
-- email and answers — inside a public projection. This column replaces that.
--
-- It defaults to false, so nothing is eligible until something deliberately
-- says so, and nothing reachable over HTTP ever sets it.

-- AlterTable
ALTER TABLE "Expert" ADD COLUMN     "demoEligible" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "demoEligible" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Expert_demoEligible_idx" ON "Expert"("demoEligible");

-- Backfill: only records whose provenance can actually be established.
--
-- Two conditions, both required. The address must match one the seeding
-- scripts generate, and the record must have no application attached — an
-- application means the record arrived through the public form, whatever it
-- is called. Anything that fails either test stays private, which is the
-- correct answer for a record nobody can vouch for.
UPDATE "Expert" e
SET "demoEligible" = true
WHERE (
        e."email" LIKE 'net.%@example.test'
     OR e."email" LIKE 'synthetic.%@example.test'
     OR e."email" LIKE 'practice.%@example.test'
      )
  AND NOT EXISTS (
        SELECT 1
        FROM "Candidate" c
        JOIN "Application" a ON a."candidateId" = c."id"
        WHERE c."expertId" = e."id"
      );

-- Projects are enumerated by title rather than pattern-matched: these are the
-- exact titles the seeding scripts create, and the list is closed.
UPDATE "Project"
SET "demoEligible" = true
WHERE "title" IN (
  'SYNTHETIC staging sandbox project',
  'PRACTICE evaluation pilot',
  'PRACTICE coding review pilot',
  'PRACTICE enterprise process assessment',
  'PRACTICE security posture review',
  'PRACTICE hands-on review pilot'
);
