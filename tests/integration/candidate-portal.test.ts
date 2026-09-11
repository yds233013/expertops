import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import {
  actorFor,
  makeCandidate,
  makeDomain,
  makeOperator,
  makeRubricVersion,
} from '../helpers/factories';
import { buildRequest, callRoute, cookieValue } from '../helpers/api';
import { CANDIDATE_COOKIE } from '@/server/http/context';
import { issueCandidatePortalToken } from '@/server/services/candidate-portal';
import { assignReviewer, startScreening, submitReview } from '@/server/services/screening';
import { DELETE as sessionDelete, POST as sessionPost } from '@/app/api/apply/session/route';
import {
  GET as screeningGet,
  POST as screeningPost,
} from '@/app/api/apply/screenings/[screeningId]/route';

/**
 * The candidate journey, driven through the same route handlers the browser
 * calls.
 *
 * The security assertions here are the point of the file: a candidate must
 * never reach another candidate's application by changing an id, and reviewer
 * private notes must be structurally absent from every candidate response.
 */
describe('candidate screening portal', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function setUp() {
    const admin = await makeOperator({ role: 'ADMIN' });
    const domain = await makeDomain();
    const version = await makeRubricVersion(domain.id);
    const candidate = await makeCandidate({ fullName: 'Rosa Iqbal' });
    const screening = await startScreening(prisma, actorFor(admin), {
      candidateId: candidate.id,
      rubricVersionId: version.id,
    });
    const issued = await issueCandidatePortalToken(prisma, { candidateId: candidate.id });
    return { admin, domain, version, candidate, screening, issued };
  }

  /** Redeem a link and return the session cookie value. */
  async function enter(token: string) {
    const result = await callRoute(
      sessionPost,
      buildRequest('POST', '/api/apply/session', { body: { token } }),
    );
    expect(result.status).toBe(200);
    const session = cookieValue(result.response, CANDIDATE_COOKIE);
    expect(session).toBeTruthy();
    return session!;
  }

  it('walks the candidate from link to submission to revision and back', async () => {
    const { admin, candidate, screening, issued } = await setUp();
    const session = await enter(issued.token);

    // The candidate reads the exercise.
    const read = await callRoute(
      screeningGet,
      buildRequest('GET', `/api/apply/screenings/${screening.id}`, { candidateToken: session }),
      { screeningId: screening.id },
    );
    expect(read.status).toBe(200);
    expect(read.body.screening.canSubmit).toBe(true);
    expect(read.body.screening.criteria.length).toBeGreaterThan(0);
    expect(read.body.screening.nextStep).toMatch(/submit/i);

    // First submission, deliberately missing the required work sample link.
    const first = await callRoute(
      screeningPost,
      buildRequest('POST', `/api/apply/screenings/${screening.id}`, {
        candidateToken: session,
        body: { answers: { depth: 'Five years running evaluation pipelines.' } },
      }),
      { screeningId: screening.id },
    );
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(1);
    expect(first.body.isComplete).toBe(false);
    expect(first.body.missingEvidence.join(' ')).toMatch(/work sample link/i);

    // A reviewer asks for changes, with public feedback and private notes.
    const review = await assignReviewer(prisma, actorFor(admin), {
      screeningId: screening.id,
      reviewerId: admin.id,
    });
    await submitReview(prisma, actorFor(admin), {
      reviewId: review.id,
      decision: 'REQUEST_REVISION',
      publicFeedback: 'Please add one work sample link.',
      privateNotes: 'Weak on depth, keep an eye on this one.',
    });
    const { requestRevision } = await import('@/server/services/screening');
    await requestRevision(prisma, actorFor(admin), {
      screeningId: screening.id,
      feedback: 'Add a link to the pipeline you described.',
    });

    // The candidate sees the feedback, their own draft, and nothing private.
    const afterRevision = await callRoute(
      screeningGet,
      buildRequest('GET', `/api/apply/screenings/${screening.id}`, { candidateToken: session }),
      { screeningId: screening.id },
    );
    const view = afterRevision.body.screening;
    expect(view.status).toBe('REVISION_REQUESTED');
    expect(view.canSubmit).toBe(true);
    expect(view.revisionFeedback).toBe('Add a link to the pipeline you described.');
    expect(view.feedback[0].feedback).toBe('Please add one work sample link.');
    expect(view.draft.answers.depth).toMatch(/evaluation pipelines/);
    expect(JSON.stringify(afterRevision.body)).not.toContain('keep an eye on this one');
    expect(JSON.stringify(afterRevision.body)).not.toContain('privateNotes');

    // Resubmission.
    const second = await callRoute(
      screeningPost,
      buildRequest('POST', `/api/apply/screenings/${screening.id}`, {
        candidateToken: session,
        body: {
          answers: { depth: 'Five years running evaluation pipelines.', evidence: 'See link.' },
          workSampleLinks: ['https://example.test/pipeline'],
        },
      }),
      { screeningId: screening.id },
    );
    expect(second.status).toBe(200);
    expect(second.body.revision).toBe(2);
    expect(second.body.isComplete).toBe(true);
    expect(second.body.status).toBe('SUBMITTED');

    // The candidate is told what happens next without being shown the review.
    const settled = await callRoute(
      screeningGet,
      buildRequest('GET', `/api/apply/screenings/${screening.id}`, { candidateToken: session }),
      { screeningId: screening.id },
    );
    expect(settled.body.screening.canSubmit).toBe(false);
    expect(settled.body.screening.nextStep).toMatch(/nothing is needed/i);
    expect(settled.body.screening.submissions).toHaveLength(2);

    // The submission is attributed to the candidate, not to an operator.
    const events = await prisma.activityEvent.findMany({
      where: { entityId: screening.id, action: 'screening.submitted' },
    });
    expect(events.every((event) => event.actorType === 'CANDIDATE')).toBe(true);
    expect(events[0]!.actorLabel).toBe(candidate.fullName);
  });

  it('refuses another candidate’s screening when the id is changed', async () => {
    const { admin, version, issued } = await setUp();
    const session = await enter(issued.token);

    const other = await makeCandidate({ fullName: 'Someone Else' });
    const otherScreening = await startScreening(prisma, actorFor(admin), {
      candidateId: other.id,
      rubricVersionId: version.id,
    });

    const read = await callRoute(
      screeningGet,
      buildRequest('GET', `/api/apply/screenings/${otherScreening.id}`, {
        candidateToken: session,
      }),
      { screeningId: otherScreening.id },
    );
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain('Someone Else');

    const write = await callRoute(
      screeningPost,
      buildRequest('POST', `/api/apply/screenings/${otherScreening.id}`, {
        candidateToken: session,
        body: { answers: { depth: 'not mine' } },
      }),
      { screeningId: otherScreening.id },
    );
    expect(write.status).toBe(404);
    expect(
      await prisma.screeningSubmission.count({ where: { screeningId: otherScreening.id } }),
    ).toBe(0);
  });

  it('refuses a link that is already used, revoked or expired', async () => {
    const { candidate, issued } = await setUp();
    await enter(issued.token);

    // Single use.
    const reused = await callRoute(
      sessionPost,
      buildRequest('POST', '/api/apply/session', { body: { token: issued.token } }),
    );
    expect(reused.status).toBe(401);
    expect(reused.body.error.message).toMatch(/already been used/i);

    const revoked = await issueCandidatePortalToken(prisma, { candidateId: candidate.id });
    await prisma.candidatePortalToken.updateMany({
      where: { candidateId: candidate.id, usedAt: null },
      data: { revokedAt: new Date() },
    });
    const afterRevoke = await callRoute(
      sessionPost,
      buildRequest('POST', '/api/apply/session', { body: { token: revoked.token } }),
    );
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body.error.message).toMatch(/revoked/i);

    const expired = await issueCandidatePortalToken(prisma, { candidateId: candidate.id });
    await prisma.candidatePortalToken.updateMany({
      where: { candidateId: candidate.id, usedAt: null, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const afterExpiry = await callRoute(
      sessionPost,
      buildRequest('POST', '/api/apply/session', { body: { token: expired.token } }),
    );
    expect(afterExpiry.status).toBe(401);
    expect(afterExpiry.body.error.message).toMatch(/expired/i);
  });

  it('requires a session, and rejects a cross-origin submission', async () => {
    const { screening, issued } = await setUp();

    const anonymous = await callRoute(
      screeningGet,
      buildRequest('GET', `/api/apply/screenings/${screening.id}`),
      { screeningId: screening.id },
    );
    expect(anonymous.status).toBe(401);

    const session = await enter(issued.token);
    const crossOrigin = await callRoute(
      screeningPost,
      buildRequest('POST', `/api/apply/screenings/${screening.id}`, {
        candidateToken: session,
        origin: 'https://attacker.example',
        body: { answers: { depth: 'forged' } },
      }),
      { screeningId: screening.id },
    );
    expect(crossOrigin.status).toBe(403);
    expect(await prisma.screeningSubmission.count()).toBe(0);
  });

  it('ends the session on sign out', async () => {
    const { screening, issued } = await setUp();
    const session = await enter(issued.token);

    const signedOut = await callRoute(
      sessionDelete,
      buildRequest('DELETE', '/api/apply/session', { candidateToken: session }),
    );
    expect(signedOut.status).toBe(200);

    const after = await callRoute(
      screeningGet,
      buildRequest('GET', `/api/apply/screenings/${screening.id}`, { candidateToken: session }),
      { screeningId: screening.id },
    );
    expect(after.status).toBe(401);
  });

  it('does not accept a submission after the window closes', async () => {
    const { screening, issued } = await setUp();
    const session = await enter(issued.token);

    await prisma.screening.update({
      where: { id: screening.id },
      data: { dueAt: new Date(Date.now() - 60_000) },
    });

    const read = await callRoute(
      screeningGet,
      buildRequest('GET', `/api/apply/screenings/${screening.id}`, { candidateToken: session }),
      { screeningId: screening.id },
    );
    expect(read.body.screening.canSubmit).toBe(false);
    expect(read.body.screening.closedReason).toMatch(/closed/i);

    const late = await callRoute(
      screeningPost,
      buildRequest('POST', `/api/apply/screenings/${screening.id}`, {
        candidateToken: session,
        body: { answers: { depth: 'late' } },
      }),
      { screeningId: screening.id },
    );
    expect(late.status).toBe(409);
    expect(await prisma.screeningSubmission.count()).toBe(0);
  });
});
