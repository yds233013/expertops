import Link from 'next/link';
import { clsx } from 'clsx';
import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { attentionCounts, listAttention } from '@/server/services/attention';
import { workerHealth } from '@/server/services/worker-health';
import { AttentionActions } from '@/components/attention-actions';
import { Badge, Card, EmptyState, PageHeader, StatTile } from '@/components/ui';
import { type AttentionKind, type AttentionSeverity } from '@prisma/client';

export const dynamic = 'force-dynamic';

/**
 * The operator's main working surface.
 *
 * Every row answers four questions: what is stuck, what it costs, who owns it,
 * and what to do next. Business blockers and automation failures are shown in
 * separate sections, because a broken job is an engineering problem and mixing
 * the two hides both.
 */
const SEVERITY_ORDER: AttentionSeverity[] = ['HIGH', 'MEDIUM', 'LOW'];

function severityTone(severity: AttentionSeverity) {
  return severity === 'HIGH' ? 'danger' : severity === 'MEDIUM' ? 'warning' : 'neutral';
}

export default async function AttentionPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; severity?: string; mine?: string; unassigned?: string }>;
}) {
  const operator = await requireOperator();
  const params = await searchParams;

  const kind = (params.kind as AttentionKind) || undefined;
  const severity = (params.severity as AttentionSeverity) || undefined;

  const [items, counts, operators, health] = await Promise.all([
    listAttention(prisma, {
      kind,
      severity,
      ownerId: params.mine === 'true' ? operator.id : undefined,
      unassignedOnly: params.unassigned === 'true',
      limit: 200,
    }),
    attentionCounts(prisma),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    workerHealth(prisma),
  ]);

  const business = items.filter((item) => item.kind === 'BUSINESS_BLOCKER');
  const automation = items.filter((item) => item.kind === 'AUTOMATION_FAILURE');
  const canManage = roleHasCapability(operator.role, 'attention:manage');
  const now = new Date();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Needs attention"
        description="Everything that is stuck and needs a person. Items appear and disappear on their own as conditions change, so an empty list means nothing is waiting."
      />

      {/* An empty queue means nothing is waiting only if something is running to
          put things on it. A stalled worker is announced here, ahead of the
          list, because this is the screen an operator starts their day on. */}
      {health.warnings.length > 0 && (
        <section
          aria-labelledby="automation-health"
          className={
            health.noLiveWorker
              ? 'rounded-lg border border-rose-200 bg-rose-50 px-4 py-3'
              : 'rounded-lg border border-amber-200 bg-amber-50 px-4 py-3'
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              id="automation-health"
              className={
                health.noLiveWorker
                  ? 'text-sm font-semibold text-rose-900'
                  : 'text-sm font-semibold text-amber-900'
              }
            >
              {health.noLiveWorker ? 'Automation is not running' : 'Automation needs attention'}
            </h2>
            <Link className="text-xs font-medium text-accent-600 hover:underline" href="/jobs">
              Worker screen →
            </Link>
          </div>
          <ul className="mt-2 space-y-1">
            {health.warnings.map((warning) => (
              <li key={warning.title} className="text-sm text-ink-800">
                <span className="font-medium">{warning.title}.</span> {warning.nextAction}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Open items" value={counts.total} href="/attention" />
        <StatTile
          label="High severity"
          value={counts.high}
          sub="Act on these first"
          href="/attention?severity=HIGH"
        />
        <StatTile
          label="Unassigned"
          value={counts.unassigned}
          sub="Nobody owns these yet"
          href="/attention?unassigned=true"
        />
        <StatTile label="Overdue" value={counts.overdue} sub="Past their due date" />
        <StatTile
          label="Automation failures"
          value={counts.automationFailures}
          sub="Engineering, not business"
          href="#automation"
        />
      </div>

      <section className="card overflow-hidden" aria-labelledby="blockers-heading">
        <header className="card-header items-center">
          <div>
            <h2 id="blockers-heading" className="section-title">
              Business blockers{' '}
              <span className="font-normal tabular-nums text-ink-500">({business.length})</span>
            </h2>
            <p className="mt-0.5 text-xs text-ink-500">
              Grouped by what is stuck. The most severe group comes first.
            </p>
          </div>
          <nav className="segmented" aria-label="Filters">
            <FilterLink
              href="/attention"
              active={!kind && !severity && !params.mine && !params.unassigned}
            >
              Everything
            </FilterLink>
            <FilterLink href="/attention?mine=true" active={params.mine === 'true'}>
              Mine
            </FilterLink>
            <FilterLink href="/attention?unassigned=true" active={params.unassigned === 'true'}>
              Unassigned
            </FilterLink>
            {SEVERITY_ORDER.map((value) => (
              <FilterLink
                key={value}
                href={`/attention?severity=${value}`}
                active={severity === value}
              >
                {value.charAt(0) + value.slice(1).toLowerCase()}
              </FilterLink>
            ))}
          </nav>
        </header>

        {business.length === 0 ? (
          <EmptyState
            glyph="✓"
            title="Nothing is blocked"
            hint="New items appear here automatically when something gets stuck."
          />
        ) : (
          groupByCategory(business).map((group) => (
            <div key={group.category} className="attn-group">
              <div className="attn-group-header">
                <h3 className="text-sm font-semibold text-ink-900">
                  {categoryLabel(group.category)}
                  <span className="ml-2 font-normal tabular-nums text-ink-500">
                    {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
                  </span>
                </h3>
                <Badge tone={severityTone(group.severity)}>
                  {group.severity.toLowerCase()} severity
                </Badge>
              </div>
              {/* Twenty-six rows with the same three sentences are one
                  explanation and twenty-six names. Say it once. */}
              {group.shared && (
                <div className="border-b border-ink-100 px-4 py-3">
                  <Facts item={group.items[0]!} />
                </div>
              )}
              <ul>
                {group.items.map((item) => {
                  const overdue = item.dueAt !== null && item.dueAt.getTime() <= now.getTime();
                  return (
                    <li
                      key={item.id}
                      className={clsx('attn-row', `attn-${item.severity.toLowerCase()}`)}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <h4 className="text-sm font-semibold text-ink-900">{item.title}</h4>
                          {overdue && <Badge tone="danger">overdue</Badge>}
                        </div>

                        {!group.shared && <Facts item={item} />}

                        <div
                          className={clsx(
                            'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs',
                            group.shared ? 'mt-1' : 'mt-2',
                          )}
                        >
                          <span
                            className={clsx('owner-chip', !item.owner && 'owner-chip-unassigned')}
                          >
                            {item.owner ? item.owner.name : 'Unassigned'}
                          </span>
                          <span
                            className={overdue ? 'font-semibold text-rose-700' : 'text-ink-500'}
                          >
                            {item.dueAt
                              ? `${overdue ? 'Overdue since' : 'Due'} ${formatRelative(item.dueAt)}`
                              : 'No due date'}
                          </span>
                          <span className="text-ink-500" title={formatDateTime(item.createdAt)}>
                            Raised {formatRelative(item.createdAt)}
                          </span>
                          {item.project && (
                            <Link
                              className="font-medium text-accent-700 hover:underline"
                              href={`/projects/${item.project.id}`}
                            >
                              {item.project.code}
                            </Link>
                          )}
                          {item.expert && (
                            <Link
                              className="font-medium text-accent-700 hover:underline"
                              href={`/experts/${item.expert.id}`}
                            >
                              {item.expert.fullName}
                            </Link>
                          )}
                          {item.candidate && (
                            <Link
                              className="font-medium text-accent-700 hover:underline"
                              href={`/candidates/${item.candidate.id}`}
                            >
                              {item.candidate.fullName}
                            </Link>
                          )}
                        </div>
                      </div>

                      {canManage && (
                        <AttentionActions
                          itemId={item.id}
                          currentOwnerId={item.ownerId}
                          operators={operators}
                          selfId={operator.id}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </section>

      <div id="automation" className="scroll-mt-20">
        <Card
          title={`Automation failures (${automation.length})`}
          description="Jobs that stopped retrying. These are engineering problems, not business blockers, and are listed separately for that reason."
        >
          {automation.length === 0 ? (
            <EmptyState
              glyph="✓"
              title="The automation is healthy"
              hint="No job has exhausted its retries."
            />
          ) : (
            <ul className="space-y-2">
              {automation.map((item) => (
                <li
                  key={item.id}
                  className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-rose-900">{item.title}</h3>
                      <p className="mt-1 text-sm text-rose-800">{item.blocker}</p>
                      <p className="mt-1 text-xs text-rose-700">{item.impact}</p>
                      <p className="mt-1 text-xs font-medium text-rose-900">{item.nextAction}</p>
                    </div>
                    <Link className="btn btn-secondary btn-sm" href="/jobs">
                      Open the worker screen
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * Items of one kind, together.
 *
 * Twenty-three "seat has no work assigned" cards in a row read as twenty-three
 * problems. Under one heading they read as one problem with twenty-three
 * instances, which is what they are and how an operator will work through them.
 */
interface FactsSource {
  category: string;
  severity: AttentionSeverity;
  blocker: string;
  impact: string;
  nextAction: string;
}

function Facts({ item }: { item: FactsSource }) {
  return (
    <>
      <dl className="attn-facts">
        <div className="flex gap-2">
          <dt className="attn-term w-14 shrink-0 pt-px">Blocker</dt>
          <dd className="text-ink-800">{item.blocker}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="attn-term w-14 shrink-0 pt-px">Impact</dt>
          <dd className="text-ink-600">{item.impact}</dd>
        </div>
      </dl>
      {/* Separated from the facts above: they explain the situation, this is
          the instruction. */}
      <p className="attn-next mt-2">
        <span className="attn-term mr-2 text-accent-600">Do next</span>
        {item.nextAction}
      </p>
    </>
  );
}

function groupByCategory<T extends FactsSource>(items: T[]) {
  const groups = new Map<
    string,
    { category: string; severity: AttentionSeverity; items: T[]; shared: boolean }
  >();
  for (const item of items) {
    const group = groups.get(item.category);
    if (group) {
      group.items.push(item);
      if (SEVERITY_ORDER.indexOf(item.severity) < SEVERITY_ORDER.indexOf(group.severity)) {
        group.severity = item.severity;
      }
    } else {
      groups.set(item.category, {
        category: item.category,
        severity: item.severity,
        items: [item],
        shared: false,
      });
    }
  }
  for (const group of groups.values()) {
    const [first, ...rest] = group.items;
    group.shared =
      first !== undefined &&
      rest.length > 0 &&
      rest.every(
        (item) =>
          item.blocker === first.blocker &&
          item.impact === first.impact &&
          item.nextAction === first.nextAction,
      );
  }
  return [...groups.values()].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.items.length - a.items.length,
  );
}

/** `delivery.no_work_assigned` → "Delivery · no work assigned". */
function categoryLabel(category: string): string {
  const [area = '', ...rest] = category.split('.');
  const detail = rest.join(' ').replace(/_/g, ' ');
  const head = area.replace(/_/g, ' ');
  const title = head.charAt(0).toUpperCase() + head.slice(1);
  return detail ? `${title} · ${detail}` : title;
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className="segmented-item">
      {children}
    </Link>
  );
}
