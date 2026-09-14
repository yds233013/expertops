import Link from 'next/link';
import { prisma } from '@/lib/db';
import { centsToRateDisplay } from '@/lib/money';
import { roleHasCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { buildExpertWhere, expertCountsByStatus, listExperts } from '@/server/services/experts';
import { Badge, Card, EmptyState, StatusBadge } from '@/components/ui';
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

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Expert network</h1>
          <p className="mt-1 text-sm text-ink-600">
            Professional records only. No protected personal attributes are collected or stored.
          </p>
        </div>
        {roleHasCapability(operator.role, 'expert:write') && (
          <Link className="btn btn-primary" href="/experts/new">
            Add expert
          </Link>
        )}
      </header>

      <form className="card flex flex-wrap items-end gap-3 px-4 py-3" method="get">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="search">
            Search
          </label>
          <input
            id="search"
            name="search"
            className="input"
            defaultValue={params.search ?? ''}
            placeholder="Name, email, reference or headline"
          />
        </div>
        <div className="w-56">
          <label className="label" htmlFor="status">
            Status
          </label>
          <select id="status" name="status" className="select" defaultValue={status ?? ''}>
            <option value="">All ({Object.values(counts).reduce((a, b) => a + b, 0)})</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ').toLowerCase()} ({counts[value]})
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-secondary" type="submit">
          Apply
        </button>
      </form>

      <Card
        title={
          matching > shown || params.cursor
            ? `${shown} of ${matching} experts`
            : `${shown} expert${shown === 1 ? '' : 's'}`
        }
        description={
          matching > PAGE_SIZE
            ? `Shown ${PAGE_SIZE} at a time. Search or filter to narrow it.`
            : undefined
        }
      >
        {experts.length === 0 ? (
          <EmptyState
            title="No experts match that filter"
            hint="Clear the search or pick another status."
          />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Headline</th>
                  <th>Skills</th>
                  <th>Experience</th>
                  <th>Rate</th>
                  <th>Timezone</th>
                </tr>
              </thead>
              <tbody>
                {experts.map((expert) => (
                  <tr key={expert.id}>
                    <td>
                      <Link
                        className="font-mono text-xs text-accent-600 hover:underline"
                        href={`/experts/${expert.id}`}
                      >
                        {expert.reference}
                      </Link>
                    </td>
                    <td>
                      <Link
                        className="font-medium text-ink-900 hover:underline"
                        href={`/experts/${expert.id}`}
                      >
                        {expert.fullName}
                      </Link>
                      <div className="text-xs text-ink-500">{expert.email}</div>
                    </td>
                    <td>
                      <StatusBadge status={expert.status} />
                    </td>
                    <td className="max-w-64 text-ink-600">{expert.headline}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {expert.skills.slice(0, 3).map((link) => (
                          <Badge
                            key={link.id}
                            tone="muted"
                            title={`Proficiency ${link.proficiency}/5`}
                          >
                            {link.skill.name}
                          </Badge>
                        ))}
                        {expert.skills.length > 3 && (
                          <Badge tone="muted">+{expert.skills.length - 3}</Badge>
                        )}
                      </div>
                    </td>
                    <td className="tabular-nums">{expert.yearsExperience}y</td>
                    <td className="tabular-nums">
                      {centsToRateDisplay(expert.hourlyRateCents, expert.currency)}
                    </td>
                    <td className="text-ink-600">{expert.timezone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(nextCursor || params.cursor) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {params.cursor && (
              <Link className="btn btn-secondary btn-sm" href={pageHref(null)}>
                Back to the start
              </Link>
            )}
            {nextCursor && (
              <Link className="btn btn-secondary btn-sm" href={pageHref(nextCursor)}>
                Next {PAGE_SIZE}
              </Link>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
