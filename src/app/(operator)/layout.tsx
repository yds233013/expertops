import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { capabilitiesFor } from '@/server/auth/permissions';
import { currentOperator } from '@/server/http/context';
import { jobCounts } from '@/server/services/jobs';
import { outboxCounts } from '@/server/services/outbox';
import { onboardingCounts } from '@/server/services/onboarding';
import { attentionCounts } from '@/server/services/attention';
import { candidateCountsByStage } from '@/server/services/candidates';
import { workCounts } from '@/server/services/work';
import { supportCounts } from '@/server/services/support';
import { listBatches } from '@/server/services/outreach';
import { paymentCounts } from '@/server/services/payments';
import { SignOutButton } from '@/components/sign-out-button';
import { Badge } from '@/components/ui';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/attention', label: 'Needs attention' },
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/candidates', label: 'Candidates' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/screenings', label: 'Screening' },
  { href: '/rubrics', label: 'Rubrics' },
  { href: '/projects', label: 'Projects' },
  { href: '/outreach', label: 'Outreach' },
  { href: '/experts', label: 'Experts' },
  { href: '/onboarding', label: 'Verification' },
  { href: '/work', label: 'Delivery' },
  { href: '/support', label: 'Support' },
  { href: '/payments', label: 'Payments' },
  { href: '/outbox', label: 'Outbox' },
  { href: '/activity', label: 'Activity' },
  { href: '/jobs', label: 'Worker' },
] as const;

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const operator = await currentOperator();
  if (!operator) redirect('/login');

  const [
    outbox,
    jobs,
    onboarding,
    attention,
    candidates,
    work,
    payments,
    support,
    awaitingOutreach,
  ] = await Promise.all([
    outboxCounts(prisma),
    jobCounts(prisma),
    onboardingCounts(prisma),
    attentionCounts(prisma),
    candidateCountsByStage(prisma),
    workCounts(prisma),
    paymentCounts(prisma),
    supportCounts(prisma),
    listBatches(prisma, { status: 'PENDING_APPROVAL', limit: 200 }),
  ]);

  // Badges show work waiting on a person, not raw record counts.
  const badges: Record<string, number> = {
    '/attention': attention.total,
    '/candidates':
      candidates.DUPLICATE_HOLD + candidates.SCREENING_SUBMITTED + candidates.IN_REVIEW,
    '/onboarding': onboarding.SUBMITTED,
    '/work': work.SUBMITTED + work.IN_REVIEW,
    '/support': support.OPEN + support.WAITING_ON_OPS,
    '/outreach': awaitingOutreach.length,
    '/payments': payments.withOpenDiscrepancies,
    '/outbox': outbox.QUEUED,
    '/jobs': jobs.DEAD + jobs.FAILED,
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/dashboard" className="text-sm font-bold tracking-tight text-ink-900">
            ExpertOps
          </Link>
          <nav className="flex flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink-600 hover:bg-ink-100 hover:text-ink-900"
              >
                {item.label}
                {badges[item.href] ? (
                  <span className="rounded-full bg-accent-500 px-1.5 text-[0.65rem] font-bold text-white tabular-nums">
                    {badges[item.href]}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <div className="text-right">
              <div className="text-xs font-semibold text-ink-800">{operator.name}</div>
              <div className="text-[0.7rem] text-ink-500">{operator.email}</div>
            </div>
            <Badge tone="info" title={capabilitiesFor(operator.role).join(', ')}>
              {operator.role}
            </Badge>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
      <footer className="mx-auto max-w-7xl px-6 pb-8 text-xs text-ink-500">
        Local development build. Email delivery is simulated, all data is synthetic, and nothing
        here is connected to an external service.
      </footer>
    </div>
  );
}
