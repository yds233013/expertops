import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatRelative } from '@/lib/time';
import { roleHasCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { listVerificationQueue, onboardingCounts } from '@/server/services/onboarding';
import { VerifyPanel } from '@/components/verify-panel';
import { Badge, Card, EmptyState, ProvenanceTag, StatTile, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function VerificationQueuePage() {
  const operator = await requireOperator();
  const [queue, counts] = await Promise.all([
    listVerificationQueue(prisma),
    onboardingCounts(prisma),
  ]);
  const canVerify = roleHasCapability(operator.role, 'onboarding:verify');

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="page-title">Verification queue</h1>
          <ProvenanceTag kind="operator" />
        </div>
        <p className="mt-1 text-sm text-ink-600">
          Nothing on this page is decided automatically. An operator must approve or return each
          submission before the expert becomes staffable.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="Awaiting review"
          value={counts.SUBMITTED}
          tone="warning"
          hint="you decide"
        />
        <StatTile label="In progress" value={counts.IN_PROGRESS} />
        <StatTile label="Not started" value={counts.NOT_STARTED} />
        <StatTile label="Verified" value={counts.VERIFIED} tone="success" />
        <StatTile label="Returned" value={counts.REJECTED} tone="danger" />
      </div>

      {queue.length === 0 ? (
        <EmptyState
          title="Nothing waiting for review"
          hint="Submissions arrive here when an expert completes their onboarding checklist."
        />
      ) : (
        <div className="space-y-4">
          {queue.map((onboardingCase) => (
            <Card
              key={onboardingCase.id}
              title={
                <Link className="hover:underline" href={`/experts/${onboardingCase.expertId}`}>
                  {onboardingCase.expert.fullName}
                </Link>
              }
              description={`${onboardingCase.expert.reference} · ${onboardingCase.expert.headline} · submitted ${formatRelative(onboardingCase.submittedAt)}`}
              actions={<StatusBadge status={onboardingCase.status} />}
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Checklist
                  </h3>
                  <ul className="space-y-1 text-sm">
                    {onboardingCase.items.map((item) => (
                      <li key={item.id} className="flex items-start justify-between gap-3">
                        <div>
                          <span className="text-ink-800">{item.label}</span>
                          {item.value && item.kind !== 'ATTESTATION' && (
                            <div className="text-xs text-ink-500">{item.value}</div>
                          )}
                        </div>
                        <Badge tone={item.completedAt ? 'success' : 'muted'}>
                          {item.completedAt ? 'done' : 'open'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Profile
                  </h3>
                  <div className="flex flex-wrap gap-1">
                    {onboardingCase.expert.skills.map((link) => (
                      <Badge key={link.id} tone="muted">
                        {link.skill.name} {link.proficiency}/5
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-ink-500">
                    {onboardingCase.expert.yearsExperience} years · {onboardingCase.expert.timezone}
                  </p>
                  {canVerify ? (
                    <VerifyPanel
                      expertId={onboardingCase.expertId}
                      expertName={onboardingCase.expert.fullName}
                    />
                  ) : (
                    <p className="text-xs text-ink-500">
                      Your role can read this queue but cannot decide on submissions.
                    </p>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
