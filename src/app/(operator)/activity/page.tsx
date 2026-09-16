import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireCapability } from '@/server/http/context';
import { listActivity } from '@/server/services/activity';
import { EmptyState, PageHeader } from '@/components/ui';
import { type ActorType } from '@prisma/client';

export const dynamic = 'force-dynamic';

const ACTOR_TYPES: ActorType[] = ['OPERATOR', 'EXPERT', 'SYSTEM'];

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ actorType?: string; entityType?: string }>;
}) {
  await requireCapability('activity:read');
  const params = await searchParams;
  const actorType = ACTOR_TYPES.includes(params.actorType as ActorType)
    ? (params.actorType as ActorType)
    : undefined;

  const { events } = await listActivity(prisma, {
    actorType,
    entityType: params.entityType || undefined,
    limit: 150,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="System"
        title="Activity history"
        description="Append-only. Each entry names who acted: a human operator, an expert in their portal, or the background worker."
      />

      <section className="card overflow-hidden">
        <form className="toolbar" method="get">
          <div className="toolbar-field w-full sm:w-48">
            <label className="label" htmlFor="actorType">
              Actor
            </label>
            <select
              id="actorType"
              name="actorType"
              className="select"
              defaultValue={actorType ?? ''}
            >
              <option value="">Anyone</option>
              {ACTOR_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value.charAt(0) + value.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="toolbar-field w-full sm:w-48">
            <label className="label" htmlFor="entityType">
              Entity
            </label>
            <select
              id="entityType"
              name="entityType"
              className="select"
              defaultValue={params.entityType ?? ''}
            >
              <option value="">Anything</option>
              {[
                'project',
                'expert',
                'invitation',
                'onboarding',
                'assignment',
                'availability',
                'user',
              ].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" type="submit">
            Apply
          </button>
        </form>
        <header className="card-header items-center">
          <h2 className="section-title">
            {events.length} event{events.length === 1 ? '' : 's'}
          </h2>
          {events.length >= 150 && (
            <p className="text-xs text-ink-500">The most recent 150. Filter to narrow it.</p>
          )}
        </header>
        {events.length === 0 ? (
          <EmptyState title="No activity matches that filter" />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>What happened</th>
                  <th>Who</th>
                  <th className="row-actions">Open</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td
                      className="whitespace-nowrap text-xs text-ink-500"
                      title={formatDateTime(event.createdAt)}
                    >
                      {formatRelative(event.createdAt)}
                    </td>
                    <td className="min-w-72 text-ink-800">
                      {event.summary}
                      <code className="cell-meta">{event.action}</code>
                    </td>
                    <td className="max-w-56">
                      <span
                        className="block truncate text-xs text-ink-700"
                        title={event.actorLabel}
                      >
                        {event.actorLabel.replace(/\s*<[^>]+>$/, '')}
                      </span>
                      <span className="cell-meta">{event.actorType.toLowerCase()}</span>
                    </td>
                    <td className="row-actions text-xs">
                      {event.projectId && (
                        <Link
                          className="mr-2 text-accent-600 hover:underline"
                          href={`/projects/${event.projectId}`}
                        >
                          project
                        </Link>
                      )}
                      {event.expertId && (
                        <Link
                          className="text-accent-600 hover:underline"
                          href={`/experts/${event.expertId}`}
                        >
                          expert
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
