import { formatDateTime, formatRelative } from '@/lib/time';

/**
 * An append-only history, read most recent first.
 *
 * Every record page had its own copy of this list with its own spacing. The
 * newest few are what an operator reads; the rest are one click away rather
 * than a thousand pixels of scroll.
 */
export interface ActivityListEvent {
  id: string;
  createdAt: Date;
  summary: string;
  actorType: string;
}

export function ActivityList({
  events,
  visible = 12,
}: {
  events: ActivityListEvent[];
  /** How many to show before folding the rest away. */
  visible?: number;
}) {
  const recent = events.slice(0, visible);
  const older = events.slice(visible);
  return (
    <>
      <Rows events={recent} />
      {older.length > 0 && (
        <details className="mt-3 border-t border-ink-100 pt-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-700">
            {older.length} earlier {older.length === 1 ? 'event' : 'events'}
          </summary>
          <div className="mt-3">
            <Rows events={older} />
          </div>
        </details>
      )}
    </>
  );
}

function Rows({ events }: { events: ActivityListEvent[] }) {
  return (
    <ol className="space-y-2">
      {events.map((event) => (
        <li key={event.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 text-sm">
          <time
            className="pt-px text-xs tabular-nums text-ink-500"
            dateTime={event.createdAt.toISOString()}
            title={formatDateTime(event.createdAt)}
          >
            {formatRelative(event.createdAt)}
          </time>
          <span className="min-w-0 text-ink-800">
            {event.summary}{' '}
            <span className="whitespace-nowrap text-xs text-ink-400">
              · {event.actorType.toLowerCase()}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
