import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { environmentLabel } from '@/lib/env';
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
import { OperatorNav, type NavGroup } from '@/components/operator-nav';
import { SignOutButton } from '@/components/sign-out-button';
import { Badge } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Five sections, in the order the work actually moves: what is stuck, where
 * people come from, how they get onto a project, what they deliver, and the
 * machinery underneath.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Today',
    items: [
      { href: '/attention', label: 'Needs attention' },
      { href: '/dashboard', label: 'Dashboard' },
    ],
  },
  {
    heading: 'Sourcing',
    items: [
      { href: '/candidates', label: 'Candidates' },
      { href: '/campaigns', label: 'Campaigns' },
      { href: '/screenings', label: 'Screening' },
      { href: '/rubrics', label: 'Rubrics' },
    ],
  },
  {
    heading: 'Staffing',
    items: [
      { href: '/projects', label: 'Projects' },
      { href: '/outreach', label: 'Outreach' },
      { href: '/experts', label: 'Experts' },
      { href: '/onboarding', label: 'Verification' },
    ],
  },
  {
    heading: 'Delivery',
    items: [
      { href: '/work', label: 'Work' },
      { href: '/support', label: 'Support' },
      { href: '/payments', label: 'Payments' },
    ],
  },
  {
    heading: 'System',
    items: [
      { href: '/outbox', label: 'Outbox' },
      { href: '/activity', label: 'Activity' },
      { href: '/jobs', label: 'Worker' },
    ],
  },
];

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

  // One number for the mobile trigger: if nothing is waiting, the menu says so
  // by staying plain.
  const waitingTotal = Object.values(badges).reduce((sum, value) => sum + value, 0);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <div className="sidebar">
        <div className="sidebar-inner flex items-center justify-between gap-3 px-4 py-4 lg:block">
          <Link href="/dashboard" className="brand">
            ExpertOps
          </Link>
          <div className="lg:mt-5">
            <OperatorNav groups={NAV_GROUPS} badges={badges} total={waitingTotal} />
          </div>
        </div>
      </div>

      <div className="flex min-h-screen flex-col">
        <header className="topbar">
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-ink-800">{operator.name}</div>
              <div className="truncate text-xs text-ink-500">{operator.email}</div>
            </div>
            <Badge tone="info" title={capabilitiesFor(operator.role).join(', ')}>
              {operator.role}
            </Badge>
            <SignOutButton />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-6xl px-4 pb-8 text-xs text-ink-500 sm:px-6">
          {environmentLabel()}. Email delivery is simulated, all data is synthetic, and nothing here
          is connected to an external service.
        </footer>
      </div>
    </div>
  );
}
