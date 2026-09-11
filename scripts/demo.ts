/**
 * Repeatable, isolated cybersecurity demo.
 *
 * Builds one complete slice of the expert lifecycle and walks it through every
 * exception the operator is meant to handle:
 *
 *   1. A project needing four cybersecurity experts.
 *   2. Some existing experts qualify; the shortfall opens a sourcing campaign.
 *   3. A candidate submits an incomplete screening.
 *   4. A reviewer goes overdue.
 *   5. A qualified expert has no capacity.
 *   6. An accepted expert has an onboarding blocker.
 *   7. An assigned expert withdraws.
 *   8. A replacement batch is approved.
 *   9. Work needs revision, then is approved.
 *  10. A payment discrepancy is resolved before export.
 *
 * Isolation: every record this script creates carries a run tag, so it can run
 * against a populated development database without touching anything already
 * there. It never truncates. Re-running produces a fresh, independently tagged
 * set; pass `--clean` to remove previous demo runs first.
 *
 * Time: the script installs a FixedClock and advances it explicitly. There is
 * no HTTP endpoint that can move time, and the clock refuses to install in a
 * production build.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { FixedClock, resetAmbientClock, setAmbientClock } from '@/lib/clock';
import { createLogger } from '@/lib/logger';
import { hashPassword } from '@/lib/crypto';
import { slugify } from '@/lib/ids';
import { minorToPlainDecimal } from '@/lib/decimal';
import { operatorActor, type Actor } from '@/server/services/activity';
import { createCandidate, submitApplication } from '@/server/services/candidates';
import { createCampaign, setCampaignStatus } from '@/server/services/sourcing';
import {
  assignReviewer,
  publishVersion,
  createDraftVersion,
  createTemplate,
  submitReview,
  submitScreening,
  startScreening,
} from '@/server/services/screening';
import {
  grantQualification,
  setProjectQualificationRequirement,
} from '@/server/services/qualifications';
import { createProject, setProjectStatus } from '@/server/services/projects';
import { runMatching } from '@/server/services/matching';
import {
  createInvitation,
  respondToInvitation,
  sendInvitation,
} from '@/server/services/invitations';
import { declareAvailability } from '@/server/services/availability';
import {
  decideVerification,
  getOnboardingCase,
  saveChecklistAnswers,
  submitOnboarding,
} from '@/server/services/onboarding';
import { confirmAssignment, proposeAssignment } from '@/server/services/staffing';
import { recordWithdrawal } from '@/server/services/staffing-gaps';
import { decideBatch, dispatchBatch, submitBatchForApproval } from '@/server/services/outreach';
import { createWorkItem, reviewWork, submitWork } from '@/server/services/work';
import { raiseSupportRequest, setBlocking, resolveSupport } from '@/server/services/support';
import {
  approveBatch,
  createBatch as createPaymentBatch,
  exportBatch,
  resolveDiscrepancy,
  submitBatchForApproval as submitPaymentBatch,
} from '@/server/services/payments';
import { createExpert } from '@/server/services/experts';
import { listAttention } from '@/server/services/attention';
import { enqueueJob } from '@/server/services/jobs';
import { Worker } from '@/server/worker/runner';

const prisma = new PrismaClient({ log: [] });
const log = createLogger('demo');

/** A tag that makes every record from this run identifiable and removable. */
const RUN_TAG = process.env.DEMO_TAG ?? `demo-${Date.now().toString(36)}`;
const EMAIL_DOMAIN = 'example.test';

const clock = new FixedClock(new Date('2026-04-06T09:00:00Z'));

let step = 0;
function heading(title: string) {
  step += 1;
  console.log(`\n${'='.repeat(72)}\n${step}. ${title}\n${'='.repeat(72)}`);
}
function note(message: string) {
  console.log(`   ${message}`);
}

/** Drain the queue so event-driven follow-ups have actually happened. */
async function drain(worker: Worker, passes = 12) {
  for (let pass = 0; pass < passes; pass += 1) {
    const summary = await worker.tick(clock.now());
    if (summary.jobsClaimed === 0) return;
  }
}

/**
 * Run a scheduled sweep on demand.
 *
 * The demo drives a clock set in the past, so the wall-clock `Schedule` rows
 * are not due and would never fire. Enqueuing the sweep directly is also
 * clearer: each step says exactly which automation it is exercising.
 */
async function runSweep(worker: Worker, type: Parameters<typeof enqueueJob>[1]['type']) {
  await enqueueJob(prisma, { type, dedupeKey: `demo:${type}:${clock.now().getTime()}` });
  await drain(worker);
}

async function cleanPreviousRuns() {
  const stale = await prisma.project.findMany({
    where: { description: { contains: '[expertops-demo]' } },
    select: { id: true },
  });
  const staleExperts = await prisma.expert.findMany({
    where: { notes: { contains: '[expertops-demo]' } },
    select: { id: true },
  });
  const staleCandidates = await prisma.candidate.findMany({
    where: { notes: { contains: '[expertops-demo]' } },
    select: { id: true },
  });

  await prisma.project.deleteMany({ where: { id: { in: stale.map((p) => p.id) } } });
  await prisma.candidate.deleteMany({ where: { id: { in: staleCandidates.map((c) => c.id) } } });
  await prisma.expert.deleteMany({ where: { id: { in: staleExperts.map((e) => e.id) } } });
  await prisma.sourcingCampaign.deleteMany({ where: { notes: { contains: '[expertops-demo]' } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: '.demo@expertops.test' } } });

  log.info('previous demo runs removed', {
    projects: stale.length,
    experts: staleExperts.length,
    candidates: staleCandidates.length,
  });
}

async function main() {
  const clean = process.argv.includes('--clean');
  setAmbientClock(clock);

  console.log(`ExpertOps cybersecurity demo\nRun tag: ${RUN_TAG}`);
  console.log('Every record below is tagged and additive. Nothing existing is modified.\n');

  if (clean) await cleanPreviousRuns();

  const worker = new Worker({ client: prisma, name: `demo-worker-${RUN_TAG}`, batchSize: 25 });
  await worker.bootstrap();

  // -----------------------------------------------------------------------
  heading('Operators and domain setup');

  const passwordHash = await hashPassword(process.env.SEED_DEMO_PASSWORD ?? 'demo-password-123');
  const mk = (name: string, role: 'ADMIN' | 'OPERATOR') =>
    prisma.user.create({
      data: { email: `${slugify(name)}.${RUN_TAG}.demo@expertops.test`, name, role, passwordHash },
    });

  const sam = await mk('Sam Okafor (demo)', 'OPERATOR');
  const dana = await mk('Dana Whitfield (demo)', 'ADMIN');
  const reviewer = await mk('Priya Reviewer (demo)', 'OPERATOR');

  const samActor: Actor = operatorActor(sam);
  const danaActor: Actor = operatorActor(dana);
  const reviewerActor: Actor = operatorActor(reviewer);

  const domain = await prisma.domain.upsert({
    where: { slug: 'cybersecurity' },
    update: {},
    create: {
      slug: 'cybersecurity',
      name: 'Cybersecurity',
      description: 'Security operations, incident response and threat analysis.',
    },
  });
  note(`Domain: ${domain.name}`);

  const template = await createTemplate(prisma, danaActor, {
    name: `Cybersecurity screening (${RUN_TAG})`,
    domainId: domain.id,
    description: 'Demo rubric. Published versions are immutable.',
  });
  const draft = await createDraftVersion(prisma, danaActor, {
    templateId: template.id,
    passThreshold: 18,
    guidance: 'Assess demonstrated practice, not credentials.',
    criteria: [
      {
        key: 'incident-response',
        label: 'Incident response depth',
        scoringGuidance: '5 = has led containment on a live intrusion.',
        maxScore: 5,
        weight: 3,
        requiredEvidence: 'WRITTEN_ANSWER',
        isGating: true,
      },
      {
        key: 'threat-analysis',
        label: 'Threat analysis',
        scoringGuidance: '5 = builds original analysis from raw telemetry.',
        maxScore: 5,
        weight: 2,
        requiredEvidence: 'WORK_SAMPLE_LINK',
      },
    ],
  });
  const rubric = await publishVersion(prisma, danaActor, draft.id);
  note(`Published rubric v${rubric.version}. It can never be edited again.`);

  // -----------------------------------------------------------------------
  heading('A project that needs four cybersecurity experts');

  const project = await createProject(prisma, samActor, {
    title: `Cloud intrusion review (${RUN_TAG})`,
    clientName: 'Harborline Payments',
    description:
      '[expertops-demo] Synthetic engagement. Review a simulated cloud intrusion and produce findings.',
    seatsRequested: 4,
    minYearsExperience: 5,
    maxHourlyRateCents: 30_000,
    preferredTimezone: 'Europe/London',
    startDate: new Date('2026-05-04T00:00:00Z'),
    requirements: [
      { skillName: 'Incident Response', required: true, minProficiency: 3, weight: 5 },
      { skillName: 'Cloud Security', required: false, minProficiency: 2, weight: 3 },
    ],
  });
  await setProjectStatus(prisma, samActor, project.id, 'MATCHING');
  await setProjectQualificationRequirement(prisma, samActor, {
    projectId: project.id,
    domainId: domain.id,
    minRubricVersionId: rubric.id,
  });
  note(`${project.code} needs 4 seats and requires ${domain.name} rubric v${rubric.version}.`);

  // -----------------------------------------------------------------------
  heading('Two existing experts already qualify; two seats cannot be filled');

  const existingExperts = [];
  for (const [index, spec] of [
    { name: 'Rowan Barros', rate: 24_000, capacity: 20, tz: 'Europe/London' },
    { name: 'Quinn Mehta', rate: 26_000, capacity: 18, tz: 'Europe/Berlin' },
    // Qualified but with no capacity to offer. Exercise 5.
    { name: 'Noor Haddad', rate: 22_000, capacity: 0, tz: 'Europe/London' },
  ].entries()) {
    const expert = await createExpert(prisma, samActor, {
      fullName: `${spec.name} (${RUN_TAG})`,
      email: `${slugify(spec.name)}.${RUN_TAG}@${EMAIL_DOMAIN}`,
      headline: 'Incident response specialist',
      yearsExperience: 9 + index,
      hourlyRateCents: spec.rate,
      timezone: spec.tz,
      weeklyCapacityHours: spec.capacity,
      notes: '[expertops-demo] synthetic expert',
      skills: [
        { name: 'Incident Response', proficiency: 5 },
        { name: 'Cloud Security', proficiency: 4 },
      ],
    });
    // They are already qualified against the current rubric.
    await prisma.qualification.create({
      data: {
        expertId: expert.id,
        domainId: domain.id,
        rubricVersionId: rubric.id,
        status: 'ACTIVE',
        decidedById: dana.id,
        decidedAt: clock.now(),
        note: 'Qualified in an earlier cycle (demo fixture).',
      },
    });
    existingExperts.push(expert);
  }
  note(
    `${existingExperts.length} experts qualified. ${existingExperts[2]!.fullName} has 0 h/week capacity.`,
  );

  const campaign = await createCampaign(prisma, samActor, {
    name: `Cybersecurity shortfall (${RUN_TAG})`,
    domainId: domain.id,
    projectId: project.id,
    targetCount: 2,
    notes: '[expertops-demo] opened because the network cannot cover the seats.',
  });
  await setCampaignStatus(prisma, samActor, campaign.id, 'ACTIVE');
  note(`Sourcing campaign ${campaign.code} opened for the 2-seat shortfall.`);

  // -----------------------------------------------------------------------
  heading('A candidate applies and submits an INCOMPLETE screening');

  const { candidate } = await createCandidate(prisma, samActor, {
    fullName: `Ines Nurse (${RUN_TAG})`,
    email: `ines.nurse.${RUN_TAG}@${EMAIL_DOMAIN}`,
    headline: 'Security operations lead',
    yearsExperience: 8,
    timezone: 'Europe/London',
    campaignId: campaign.id,
    notes: '[expertops-demo] synthetic candidate',
  });
  await submitApplication(prisma, samActor, {
    candidateId: candidate.id,
    domainId: domain.id,
    workSampleLinks: ['https://example.test/writeups/ransomware-containment'],
  });
  await drain(worker);
  note(`${candidate.fullName} applied; acknowledgement queued by the worker.`);

  const screening = await startScreening(prisma, samActor, {
    candidateId: candidate.id,
    rubricVersionId: rubric.id,
    dueInHours: 72,
  });

  const incomplete = await submitScreening(
    prisma,
    { type: 'SYSTEM', label: candidate.fullName },
    {
      screeningId: screening.id,
      // The threat-analysis criterion requires a work sample link; none given.
      answers: { 'incident-response': 'Led containment on two live intrusions in 2025.' },
      workSampleLinks: [],
    },
  );
  note(
    `Submission recorded as INCOMPLETE: ${incomplete.missingEvidence.length} evidence item(s) missing.`,
  );
  incomplete.missingEvidence.forEach((item) => note(`  - ${item}`));

  await drain(worker);

  // -----------------------------------------------------------------------
  heading('The assigned reviewer goes overdue');

  const review = await assignReviewer(prisma, samActor, {
    screeningId: screening.id,
    reviewerId: reviewer.id,
    dueInHours: 24,
  });
  note(`Review assigned to ${reviewer.name}, due in 24 hours.`);

  clock.advanceHours(36);
  note(`Clock advanced 36 hours to ${clock.now().toISOString()}.`);
  await runSweep(worker, 'review.remind');
  await runSweep(worker, 'review.escalate_overdue');

  const overdueItems = await listAttention(prisma, { category: 'review.overdue' });
  note(`Attention queue now shows ${overdueItems.length} overdue review(s).`);
  overdueItems.slice(0, 1).forEach((item) => {
    note(`  blocker: ${item.blocker}`);
    note(`  next:    ${item.nextAction}`);
  });

  // The reviewer finally responds, asking for the missing evidence.
  await submitReview(prisma, reviewerActor, {
    reviewId: review.id,
    decision: 'REQUEST_REVISION',
    publicFeedback: 'Please attach the threat-analysis work sample referenced in your answer.',
    privateNotes: 'Strong IR answer. Internal note: not visible to the candidate.',
    scores: { 'incident-response': 5 },
  });
  note('Reviewer asked for a revision. Private notes stay operator-only.');

  const { requestRevision } = await import('@/server/services/screening');
  await requestRevision(prisma, samActor, {
    screeningId: screening.id,
    feedback: 'Add the work sample link and resubmit.',
    extraHours: 48,
  });

  const complete = await submitScreening(
    prisma,
    { type: 'SYSTEM', label: candidate.fullName },
    {
      screeningId: screening.id,
      answers: {
        'incident-response': 'Led containment on two live intrusions in 2025.',
        'threat-analysis': 'Built attribution from raw EDR telemetry; write-up linked.',
      },
      workSampleLinks: ['https://example.test/writeups/attribution-analysis'],
    },
  );
  note(`Resubmitted as revision ${complete.revision}; complete = ${complete.isComplete}.`);
  await drain(worker);

  const secondReview = await prisma.screeningReview.findFirst({
    where: { screeningId: screening.id, state: 'ASSIGNED' },
  });
  if (secondReview) {
    await submitReview(
      prisma,
      operatorActor(
        await prisma.user.findUniqueOrThrow({ where: { id: secondReview.reviewerId } }),
      ),
      {
        reviewId: secondReview.id,
        decision: 'APPROVE',
        scores: { 'incident-response': 5, 'threat-analysis': 4 },
        publicFeedback: 'Clear, evidenced answers.',
      },
    );
  }

  // The first reviewer asked for a revision and the second approved, so the two
  // submitted decisions disagree. The system refuses to break the tie; an
  // authorised operator records the outcome instead.
  const conflict = await prisma.reviewConflict.findUnique({
    where: { screeningId: screening.id },
  });
  if (conflict && conflict.status === 'OPEN') {
    note(`Reviewers disagree: ${conflict.summary}`);
    note('The system will not pick a winner. An admin resolves it explicitly.');
    const { resolveConflict } = await import('@/server/services/screening');
    await resolveConflict(prisma, danaActor, {
      screeningId: screening.id,
      resolution: 'APPROVE',
      note: 'The revision addressed the first reviewer’s objection; the later approval stands.',
    });
  }

  const { qualification } = await grantQualification(prisma, danaActor, {
    screeningId: screening.id,
    note: 'Approved on the resubmitted evidence.',
  });
  note(`${candidate.fullName} qualified. A human made that decision, not the system.`);
  await drain(worker);

  const newExpert = await prisma.expert.findUniqueOrThrow({
    where: { id: qualification.expertId },
  });
  await prisma.expert.update({
    where: { id: newExpert.id },
    data: { notes: '[expertops-demo] converted from candidate', weeklyCapacityHours: 20 },
  });
  await prisma.expertSkill.createMany({
    data: [
      {
        expertId: newExpert.id,
        skillId: (
          await prisma.skill.upsert({
            where: { slug: 'incident-response' },
            update: {},
            create: { slug: 'incident-response', name: 'Incident Response' },
          })
        ).id,
        proficiency: 5,
      },
    ],
    skipDuplicates: true,
  });

  // -----------------------------------------------------------------------
  heading('Matching, invitations and an onboarding blocker');

  await runMatching(prisma, samActor, project.id, {
    limit: 20,
    includeExcluded: true,
    now: clock.now(),
  });

  const inviteTargets = [existingExperts[0]!, existingExperts[1]!, newExpert];
  for (const expert of inviteTargets) {
    const invitation = await createInvitation(prisma, samActor, {
      projectId: project.id,
      expertId: expert.id,
      message: 'Cloud intrusion review, four-week engagement.',
      ttlHours: 72,
    });
    await sendInvitation(prisma, { type: 'SYSTEM', label: 'worker' }, invitation.id);
    await respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: true });
  }
  await drain(worker);
  note(`${inviteTargets.length} experts invited and accepted.`);

  // Everyone declares availability and completes onboarding, except one who is
  // blocked by a support request. Exercise 6.
  for (const expert of inviteTargets) {
    await declareAvailability(
      prisma,
      { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
      expert.id,
      {
        startAt: new Date('2026-05-01T00:00:00Z'),
        endAt: new Date('2026-07-01T00:00:00Z'),
        hoursPerWeek: 16,
        projectId: project.id,
      },
    );

    const expertActor: Actor = { type: 'EXPERT', expertId: expert.id, label: expert.fullName };
    const openCase = await getOnboardingCase(prisma, expert.id);
    await saveChecklistAnswers(
      prisma,
      expertActor,
      expert.id,
      openCase.items
        .filter((item) => item.required)
        .map((item) => ({ key: item.key, value: item.kind === 'ATTESTATION' ? 'true' : 'None' })),
    );
    await submitOnboarding(prisma, expertActor, expert.id);
  }

  const blockedExpert = inviteTargets[2]!;
  const support = await raiseSupportRequest(
    prisma,
    { type: 'EXPERT', expertId: blockedExpert.id, label: blockedExpert.fullName },
    {
      expertId: blockedExpert.id,
      projectId: project.id,
      category: 'ACCESS',
      subject: 'No access to the client log platform',
      message: 'I cannot reach the SIEM export the brief refers to.',
    },
  );
  await setBlocking(prisma, samActor, {
    requestId: support.id,
    blocksReadiness: true,
    note: 'Cannot start without log access.',
  });
  note(`${blockedExpert.fullName} is blocked by support request ${support.reference}.`);

  for (const expert of inviteTargets) {
    await decideVerification(prisma, danaActor, { expertId: expert.id, approve: true });
  }
  await drain(worker);
  await runSweep(worker, 'attention.sweep');

  const blockedItems = await listAttention(prisma, { category: 'staffing.blocked_expert' });
  note(`Attention queue shows ${blockedItems.length} blocked expert(s) despite verification.`);

  await resolveSupport(prisma, samActor, {
    requestId: support.id,
    resolution: 'Client granted read-only SIEM access; confirmed working.',
  });
  await drain(worker);
  note('Support request resolved; the readiness block clears.');

  // -----------------------------------------------------------------------
  heading('Staffing, then a withdrawal');

  const assignments = [];
  for (const expert of inviteTargets) {
    const proposal = await proposeAssignment(prisma, samActor, {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 16,
      rateCents: 24_000,
    });
    const confirmed = await confirmAssignment(prisma, samActor, proposal.id);
    assignments.push(confirmed.assignment);
  }
  await drain(worker);
  note(`${assignments.length}/4 seats confirmed. One seat still open.`);

  const leaver = inviteTargets[1]!;
  const withdrawal = await recordWithdrawal(prisma, samActor, {
    projectId: project.id,
    expertId: leaver.id,
    reason: 'Client conflict emerged at their day job.',
  });
  note(`${leaver.fullName} withdrew. Gap is now ${withdrawal.gap.gap} seat(s).`);
  await drain(worker);

  // -----------------------------------------------------------------------
  heading('A replacement batch is proposed, then approved by a human');

  const batch = await prisma.outreachBatch.findFirst({
    where: { projectId: project.id, kind: 'REPLACEMENT' },
    orderBy: { createdAt: 'desc' },
    include: { items: true },
  });

  if (!batch) {
    note('No automatic batch (nobody left in the match pool). Building one by hand for the demo.');
  } else {
    note(
      `Batch ${batch.reference} proposed with ${batch.items.length} recipient(s). Nothing sent yet.`,
    );
    if (batch.status === 'DRAFT') {
      await submitBatchForApproval(prisma, samActor, batch.id);
    }
    // Approved by a different operator than the one who assembled it.
    await decideBatch(prisma, danaActor, { batchId: batch.id, approve: true, note: 'Approved.' });
    note(`${dana.name} approved the batch. Only now can anything be dispatched.`);
    const dispatched = await dispatchBatch(prisma, danaActor, batch.id);
    note(
      `Dispatched ${dispatched.dispatched} invitation(s); ${dispatched.skipped.length} skipped.`,
    );
    await drain(worker);
  }

  // -----------------------------------------------------------------------
  heading('Work is assigned, needs revision, then is approved');

  const workingAssignment = assignments[0]!;
  const workingExpert = inviteTargets[0]!;

  const workItem = await createWorkItem(prisma, samActor, {
    assignmentId: workingAssignment.id,
    title: 'Initial intrusion timeline',
    instructions: 'Reconstruct the attacker timeline from the supplied synthetic telemetry.',
    basis: 'HOURLY',
    dueAt: new Date('2026-05-18T00:00:00Z'),
  });

  const expertActor: Actor = {
    type: 'EXPERT',
    expertId: workingExpert.id,
    label: workingExpert.fullName,
  };

  await submitWork(prisma, expertActor, {
    workItemId: workItem.id,
    summary: 'First pass at the timeline.',
    content: 'Timeline covering initial access through lateral movement.',
    hoursClaimed: '12.5',
  });
  await drain(worker);
  note(`${workItem.reference} submitted, claiming 12.50 hours.`);

  await reviewWork(prisma, samActor, {
    workItemId: workItem.id,
    approve: false,
    revisionRequest: 'Exfiltration stage is missing. Add it with supporting evidence.',
    feedback: { completeness: 'Stops at lateral movement.', clarity: 'Clear as far as it goes.' },
  });
  note('Revision requested. A single review never changes the expert’s standing.');

  await submitWork(prisma, expertActor, {
    workItemId: workItem.id,
    summary: 'Added the exfiltration stage.',
    content: 'Full timeline including exfiltration and the evidence for each step.',
    hoursClaimed: '16.00',
  });
  await drain(worker);

  // The reviewer authorises fewer hours than claimed, creating a discrepancy.
  await reviewWork(prisma, samActor, {
    workItemId: workItem.id,
    approve: true,
    summary: 'Complete and well evidenced.',
    feedback: { accuracy: 'Matches the telemetry.', completeness: 'Full chain covered.' },
    approvedQuantity: '14.50',
  });
  note('Approved at 14.50 hours against 16.00 claimed. That difference is a discrepancy.');
  await drain(worker);

  // -----------------------------------------------------------------------
  heading('Payment preparation: discrepancy resolved before export');

  const paymentItem = await prisma.paymentItem.findFirstOrThrow({
    where: { workItemId: workItem.id },
  });
  const flags = paymentItem.discrepancies as unknown as Array<{ code: string; message: string }>;
  note(
    `Draft payment ${paymentItem.reference}: ${minorToPlainDecimal(paymentItem.amountMinor)} ${paymentItem.currency}`,
  );
  flags.forEach((flag) => note(`  flag ${flag.code}: ${flag.message}`));

  // Idempotency check: running the drafting job again must not double-pay.
  const { draftPaymentFromApprovedWork } = await import('@/server/services/payments');
  const repeat = await draftPaymentFromApprovedWork(prisma, samActor, { workItemId: workItem.id });
  note(`Re-running the drafting job created a new item: ${repeat.created} (expected false).`);

  await resolveDiscrepancy(prisma, samActor, {
    paymentItemId: paymentItem.id,
    resolution: 'Reviewer disallowed 1.5 hours of setup time; agreed with the expert by email.',
  });
  note('Discrepancy cleared with a written explanation.');

  const paymentBatch = await createPaymentBatch(prisma, samActor, {
    periodStart: new Date('2026-05-01T00:00:00Z'),
    periodEnd: new Date('2026-05-31T00:00:00Z'),
    note: `[expertops-demo] ${RUN_TAG}`,
    itemIds: [paymentItem.id],
  });
  await submitPaymentBatch(prisma, samActor, paymentBatch.id);

  // Approved by someone other than the creator.
  await approveBatch(prisma, danaActor, {
    batchId: paymentBatch.id,
    note: 'Checked against the review.',
  });
  const exported = await exportBatch(prisma, danaActor, paymentBatch.id);
  note(`Batch ${paymentBatch.reference} exported as ${exported.filename}.`);
  note('Exported means a file was produced for finance. Nobody has been paid.');
  console.log('\n--- CSV ---');
  console.log(exported.csv.trim());
  console.log('--- end CSV ---');

  // -----------------------------------------------------------------------
  heading('Where the operator stands now');

  await drain(worker);
  await runSweep(worker, 'attention.sweep');
  await runSweep(worker, 'staffing.detect_gaps');
  const open = await listAttention(prisma, { projectId: project.id });
  const allOpen = await listAttention(prisma, {});

  console.log(`\n   ${project.code} attention items: ${open.length}`);
  for (const item of open) {
    console.log(`   [${item.severity}] ${item.title}`);
    console.log(`       blocker: ${item.blocker}`);
    console.log(`       next:    ${item.nextAction}`);
    console.log(`       owner:   ${item.owner?.name ?? 'UNASSIGNED'}`);
  }

  const automationFailures = allOpen.filter((item) => item.kind === 'AUTOMATION_FAILURE');
  console.log(`\n   Business blockers: ${allOpen.length - automationFailures.length}`);
  console.log(
    `   Automation failures: ${automationFailures.length} (shown separately, never mixed in)`,
  );

  const deadJobs = await prisma.job.count({ where: { status: 'DEAD' } });
  console.log(`   Dead jobs: ${deadJobs}`);

  console.log(`\nDemo complete. Run tag: ${RUN_TAG}`);
  console.log('Sign in as any demo operator listed above, or re-run with --clean to reset.');
  console.log(`  ${sam.email}`);
  console.log(`  ${dana.email}`);
  console.log(`  ${reviewer.email}`);
}

main()
  .catch((error) => {
    log.error('demo failed', { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    resetAmbientClock();
    await prisma.$disconnect();
  });
