import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireCapability } from '@/server/http/context';
import { listActivity } from '@/server/services/activity';
import { Card, EmptyState, StatusBadge } from '@/components/ui';
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
      <header>
        <h1 className="page-title">Activity history</h1>
        <p className="mt-1 text-sm text-ink-600">
          Append-only. Each entry names who acted: a human operator, an expert in their portal, or
          the background worker.
        </p>
      </header>

      <form className="card flex flex-wrap items-end gap-3 px-4 py-3" method="get">
        <div className="w-48">
          <label className="label" htmlFor="actorType">
            Actor
          </label>
          <select id="actorType" name="actorType" className="select" defaultValue={actorType ?? ''}>
            <option value="">Anyone</option>
            {ACTOR_TYPES.map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="w-48">
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
        <button className="btn btn-secondary" type="submit">
          Apply
        </button>
      </form>

      <Card title={`${events.length} event${events.length === 1 ? '' : 's'}`}>
        {events.length === 0 ? (
          <EmptyState title="No activity matches that filter" />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Summary</th>
                  <th>Links</th>
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
                    <td>
                      <StatusBadge status={event.actorType} />
                      <div className="mt-0.5 text-xs text-ink-500">{event.actorLabel}</div>
                    </td>
                    <td>
                      <code className="text-xs">{event.action}</code>
                    </td>
                    <td className="text-ink-800">{event.summary}</td>
                    <td className="whitespace-nowrap text-xs">
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
      </Card>
    </div>
  );
}
