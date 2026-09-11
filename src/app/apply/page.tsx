import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { currentCandidate } from '@/server/http/context';
import { listScreeningsForCandidate } from '@/server/services/screening';
import { ScreeningForm } from '@/components/apply/screening-form';
import { SignOutButton } from '@/components/sign-out-button';
import { Badge, Card, EmptyState, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The candidate's whole view of their application.
 *
 * Everything on this page comes from `listScreeningsForCandidate`, the single
 * candidate-safe projection. Reviewer scores and private notes are not fetched
 * here at all, so they cannot leak through a forgotten field.
 */
export default async function ApplyHome() {
  const candidate = await currentCandidate();

  if (!candidate) {
    return (
      <Card title="Your session has ended">
        <p className="text-sm text-ink-600">
          Open the most recent screening link sent to you to continue. Links are single-use, so an
          older one will not work.
        </p>
      </Card>
    );
  }

  const screenings = await listScreeningsForCandidate(prisma, candidate.id);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Hello, {candidate.fullName}</h1>
          <p className="mt-1 text-sm text-ink-600">
            Application <span className="font-mono">{candidate.reference}</span>
          </p>
        </div>
        <SignOutButton url="/api/apply/session" redirectTo="/" label="Sign out" />
      </header>

      {screenings.length === 0 && (
        <Card title="No screening exercise yet">
          <EmptyState
            title="Nothing to complete"
            hint="Your ExpertOps contact will send a link when a screening exercise is ready for you."
          />
        </Card>
      )}

      {screenings.map((screening) => {
        const latestSubmission = screening.submissions[0] ?? null;
        return (
          <Card
            key={screening.id}
            title={`${screening.domain} screening`}
            description={`${screening.reference} · rubric version ${screening.rubricVersion}`}
            actions={<StatusBadge status={screening.status} />}
          >
            <div className="space-y-4">
              <p className="rounded-md bg-accent-50 px-3 py-2 text-sm text-accent-700">
                <span className="font-semibold">Next step: </span>
                {screening.nextStep}
              </p>

              {screening.canSubmit && (
                <p className="text-xs text-ink-600">
                  Due {formatDateTime(screening.dueAt)} ({formatRelative(screening.dueAt)}).
                </p>
              )}

              {screening.guidance && (
                <section>
                  <h3 className="text-sm font-semibold text-ink-900">Instructions</h3>
                  <p className="mt-1 whitespace-pre-line text-sm text-ink-700">
                    {screening.guidance}
                  </p>
                </section>
              )}

              <section>
                <h3 className="text-sm font-semibold text-ink-900">What you are assessed on</h3>
                <ul className="mt-2 space-y-2">
                  {screening.criteria.map((criterion) => (
                    <li key={criterion.key} className="rounded-lg border border-ink-200 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink-900">{criterion.label}</span>
                        <Badge tone="muted">scored out of {criterion.maxScore}</Badge>
                      </div>
                      {criterion.scoringGuidance && (
                        <p className="mt-1 text-xs text-ink-600">{criterion.scoringGuidance}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              {screening.revisionFeedback && (
                <section
                  aria-labelledby={`feedback-${screening.id}`}
                  className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
                >
                  <h3
                    id={`feedback-${screening.id}`}
                    className="text-sm font-semibold text-amber-900"
                  >
                    Requested changes
                  </h3>
                  <p className="mt-1 whitespace-pre-line text-sm text-amber-900">
                    {screening.revisionFeedback}
                  </p>
                  {screening.revisionRequestedAt && (
                    <p className="mt-1 text-xs text-amber-800">
                      Sent {formatDateTime(screening.revisionRequestedAt)}
                    </p>
                  )}
                </section>
              )}

              {screening.feedback.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold text-ink-900">Reviewer feedback</h3>
                  <ul className="mt-2 space-y-2">
                    {screening.feedback.map((entry, index) => (
                      <li
                        key={index}
                        className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-700"
                      >
                        <p className="whitespace-pre-line">{entry.feedback}</p>
                        {entry.submittedAt && (
                          <p className="mt-1 text-xs text-ink-500">
                            {formatDateTime(entry.submittedAt)}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {latestSubmission && !latestSubmission.isComplete && (
                <section
                  aria-labelledby={`missing-${screening.id}`}
                  className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
                >
                  <h3
                    id={`missing-${screening.id}`}
                    className="text-sm font-semibold text-amber-900"
                  >
                    Required evidence is missing
                  </h3>
                  <ul className="mt-1 list-disc pl-5 text-sm text-amber-900">
                    {(latestSubmission.missingEvidence as string[]).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-amber-800">
                    Your responses were recorded either way. You can add the missing evidence while
                    the window is open.
                  </p>
                </section>
              )}

              {screening.submissions.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold text-ink-900">Your submissions</h3>
                  <ul className="mt-2 space-y-1 text-sm">
                    {screening.submissions.map((submission) => (
                      <li
                        key={submission.revision}
                        className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 py-1.5 last:border-b-0"
                      >
                        <span className="text-ink-800">
                          Revision {submission.revision} · {formatDateTime(submission.submittedAt)}
                        </span>
                        <Badge tone={submission.isComplete ? 'success' : 'warning'}>
                          {submission.isComplete ? 'complete' : 'evidence missing'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {screening.canSubmit ? (
                <section aria-labelledby={`respond-${screening.id}`}>
                  <h3 id={`respond-${screening.id}`} className="text-sm font-semibold text-ink-900">
                    Your responses
                  </h3>
                  <div className="mt-3">
                    <ScreeningForm
                      screeningId={screening.id}
                      criteria={screening.criteria}
                      initialAnswers={screening.draft?.answers ?? {}}
                      initialLinks={screening.draft?.workSampleLinks ?? []}
                      initialNote={screening.draft?.note ?? ''}
                      submitLabel={
                        screening.draft ? 'Submit revised responses' : 'Submit responses'
                      }
                    />
                  </div>
                </section>
              ) : (
                screening.closedReason && (
                  <p className="rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700">
                    {screening.closedReason}
                  </p>
                )
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
