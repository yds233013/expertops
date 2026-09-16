import Link from 'next/link';
import { prisma } from '@/lib/db';
import { centsToRateDisplay } from '@/lib/money';
import { roleHasCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { buildExpertWhere, expertCountsByStatus, listExperts } from '@/server/services/experts';
import {
  Badge,
  CellPrimary,
  CursorPagination,
  EmptyState,
  PageHeader,
  StatusBadge,
  TableShell,
  ToolbarField,
} from '@/components/ui';
import { type ExpertStatus } from '@prisma/client';

export const dynamic = 'force-dynamic';

/** One page of the network. The service caps a page at 100 regardless. */
const PAGE_SIZE = 50;

const STATUSES: ExpertStatus[] = [
  'PROSPECT',
  'ONBOARDING',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
  'ARCHIVED',
];

function statusLabel(status: string): string {
  const words = status.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default async function ExpertsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string; cursor?: string }>;
}) {
  const operator = await requireOperator();
  const params = await searchParams;
  const status = STATUSES.includes(params.status as ExpertStatus)
    ? (params.status as ExpertStatus)
    : undefined;

  const [{ experts, nextCursor }, counts, matching] = await Promise.all([
    listExperts(prisma, {
      status,
      search: params.search,
      cursor: params.cursor,
      limit: PAGE_SIZE,
    }),
    expertCountsByStatus(prisma),
    // What the filter actually matches, which is not the same as what fits on
    // one page. A list that says "100 experts" beside a filter that says 101 is
    // not a rounding difference; it is two records nobody can reach.
    prisma.expert.count({ where: buildExpertWhere({ status, search: params.search }) }),
  ]);

  const shown = experts.length;
  const pageHref = (cursor: string | null) => {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (status) query.set('status', status);
    if (cursor) query.set('cursor', cursor);
    const text = query.toString();
    return text ? `/experts?${text}` : '/experts';
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const filtered = Boolean(status || params.search);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Staffing"
        title="Expert network"
        description="Professional records only. No protected personal attributes are collected or stored."
        actions={
          roleHasCapability(operator.role, 'expert:write') && (
            <Link className="btn btn-primary" href="/experts/new">
              Add expert
            </Link>
          )
        }
      />

      <section className="card overflow-hidden">
        <form method="get" className="toolbar">
          <ToolbarField label="Search" htmlFor="search" className="min-w-56 flex-1">
            <input
              id="search"
              name="search"
              type="search"
              className="input"
              defaultValue={params.search ?? ''}
              placeholder="Name, email, reference or headline"
            />
          </ToolbarField>
          <ToolbarField label="Status" htmlFor="status" className="w-full sm:w-56">
            <select id="status" name="status" className="select" defaultValue={status ?? ''}>
              <option value="">All ({total})</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {`${statusLabel(value)} (${counts[value]})`}
                </option>
              ))}
            </select>
          </ToolbarField>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary" type="submit">
              Apply
            </button>
            {filtered && (
              <Link className="btn btn-secondary" href="/experts">
                Clear
              </Link>
            )}
          </div>
        </form>

        <header className="card-header items-center">
          <h2 className="section-title">
            {matching > shown || params.cursor
              ? `${shown} of ${matching} experts`
              : `${shown} expert${shown === 1 ? '' : 's'}`}
          </h2>
          {matching > PAGE_SIZE && (
            <p className="text-xs text-ink-500">
              {PAGE_SIZE} at a time. Search or filter to narrow it.
            </p>
          )}
        </header>

        {experts.length === 0 ? (
          <EmptyState
            glyph="⌕"
            title="No experts match that filter"
            hint="Clear the search or pick another status."
            action={
              filtered ? (
                <Link className="btn btn-secondary btn-sm" href="/experts">
                  Clear filters
                </Link>
              ) : undefined
            }
          />
        ) : (
          <TableShell label="Experts">
            <thead>
              <tr>
                <th>Expert</th>
                <th>Status</th>
                <th>Focus</th>
                <th>Skills</th>
                <th className="text-right">Experience</th>
                <th className="text-right">Rate</th>
                <th>Timezone</th>
              </tr>
            </thead>
            <tbody>
              {experts.map((expert) => (
                <tr key={expert.id}>
                  <td className="min-w-52 max-w-80">
                    <CellPrimary
                      href={`/experts/${expert.id}`}
                      meta={
                        <>
                          <span className="font-mono" data-reference>
                            {expert.reference}
                          </span>{' '}
                          · {expert.email}
                        </>
                      }
                    >
                      {expert.fullName}
                    </CellPrimary>
                  </td>
                  <td>
                    <StatusBadge status={expert.status} />
                  </td>
                  <td className="max-w-60">
                    <span className="line-clamp-2 text-ink-600" title={expert.headline}>
                      {expert.headline}
                    </span>
                  </td>
                  <td className="min-w-44">
                    {expert.skills.length === 0 ? (
                      <span className="text-xs text-ink-400">None on file</span>
                    ) : (
                      <span className="flex items-center gap-1.5 whitespace-nowrap">
                        {expert.skills.slice(0, 1).map((link) => (
                          <Badge
                            key={link.id}
                            tone="muted"
                            title={`Proficiency ${link.proficiency}/5`}
                          >
                            {link.skill.name}
                          </Badge>
                        ))}
                        {expert.skills.length > 1 && (
                          <span
                            className="text-xs text-ink-500"
                            title={expert.skills
                              .slice(1)
                              .map((link) => link.skill.name)
                              .join(', ')}
                          >
                            +{expert.skills.length - 1} more
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {expert.yearsExperience} {expert.yearsExperience === 1 ? 'yr' : 'yrs'}
                  </td>
                  <td className="text-right tabular-nums">
                    {centsToRateDisplay(expert.hourlyRateCents, expert.currency)}
                  </td>
                  <td className="whitespace-nowrap text-ink-600">{expert.timezone}</td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}

        {experts.length > 0 && (
          <CursorPagination
            shown={shown}
            total={matching}
            unit="experts"
            firstHref={params.cursor ? pageHref(null) : null}
            nextHref={nextCursor ? pageHref(nextCursor) : null}
            nextLabel={`Next ${PAGE_SIZE}`}
          />
        )}
      </section>
    </div>
  );
}
