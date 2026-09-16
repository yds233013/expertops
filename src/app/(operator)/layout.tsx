import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { environmentLabel } from '@/lib/env';
import { capabilitiesFor } from '@/server/auth/permissions';
import { workloadQueues } from '@/server/services/workload';
import { currentOperator } from '@/server/http/context';
import { OperatorNav, type NavGroup } from '@/components/operator-nav';
import { SignOutButton } from '@/components/sign-out-button';
import { Badge, SampleDataBadge } from '@/components/ui';

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
      { href: '/opportunities', label: 'Opportunities' },
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

/** Two letters for the account chip. A photo would be inventing a person. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const operator = await currentOperator();
  if (!operator) redirect('/login');

  // Badges show work waiting on a person, not raw record counts, and come from
  // the same service as the dashboard's queue so the two cannot disagree.
  const { queues } = await workloadQueues(prisma);
  const badges: Record<string, number> = Object.fromEntries(
    queues.map((queue) => [queue.href, queue.count]),
  );

  // One number for the mobile trigger: if nothing is waiting, the menu says so
  // by staying plain.
  const waitingTotal = Object.values(badges).reduce((sum, value) => sum + value, 0);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      {/* The first stop for a keyboard, so the rail can be skipped. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="sidebar">
        <div className="sidebar-inner flex items-center justify-between gap-3 px-3 py-3.5 lg:block lg:px-3.5 lg:py-4">
          <Link href="/dashboard" className="brand px-1.5">
            <span className="brand-mark" aria-hidden="true">
              EO
            </span>
            <span>
              ExpertOps
              <span className="brand-sub">Operator workspace</span>
            </span>
          </Link>
          <div className="lg:mt-5">
            <OperatorNav groups={NAV_GROUPS} badges={badges} total={waitingTotal} />
          </div>
          {/* Sits under the last section rather than above the first: the rail
              is for navigating, and this is a standing caveat, not a control. */}
          <div className="mt-6 hidden px-1.5 lg:block">
            <SampleDataBadge />
          </div>
        </div>
      </div>

      <div className="flex min-h-screen flex-col">
        <header className="topbar">
          <span className="hidden text-xs text-ink-500 sm:inline">{environmentLabel()}</span>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <div className="account">
              <span className="avatar" aria-hidden="true">
                {initials(operator.name)}
              </span>
              <div className="hidden min-w-0 sm:block">
                <div className="truncate text-sm font-semibold leading-tight text-ink-800">
                  {operator.name}
                </div>
                <div className="truncate text-xs leading-tight text-ink-500">{operator.email}</div>
              </div>
            </div>
            <span className="hidden sm:inline-flex">
              <Badge tone="info" title={capabilitiesFor(operator.role).join(', ')}>
                {operator.role}
              </Badge>
            </span>
            <SignOutButton />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:py-7">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-6xl px-4 pb-8 pt-2 text-xs text-ink-500 sm:px-6">
          Email delivery is simulated, all data is synthetic, and nothing here is connected to an
          external service.
        </footer>
      </div>
    </div>
  );
}
