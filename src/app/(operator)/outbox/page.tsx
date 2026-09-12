import Link from 'next/link';
import { prisma } from '@/lib/db';
import { portalLinksVisible } from '@/lib/env';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireCapability } from '@/server/http/context';
import { listMessages, outboxCounts } from '@/server/services/outbox';
import { SimulatedDeliveryNote } from '@/components/delivery-note';
import { Card, EmptyState, ProvenanceTag, StatTile, StatusBadge } from '@/components/ui';
import { type OutboxStatus } from '@prisma/client';

export const dynamic = 'force-dynamic';

const STATUSES: OutboxStatus[] = ['QUEUED', 'SENT', 'FAILED'];

export default async function OutboxPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string }>;
}) {
  await requireCapability('outbox:read');
  const params = await searchParams;
  const status = STATUSES.includes(params.status as OutboxStatus)
    ? (params.status as OutboxStatus)
    : undefined;

  const [{ messages }, counts] = await Promise.all([
    listMessages(prisma, { status, search: params.search, limit: 60 }),
    outboxCounts(prisma),
  ]);

  const showLinks = portalLinksVisible();

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-ink-900">Simulated outbox</h1>
          <ProvenanceTag kind="simulated" />
        </div>
        <p className="mt-1 text-sm text-ink-600">
          Every message below was rendered and stored locally. &ldquo;Marked delivered&rdquo; means
          the worker updated this row, and nothing more.
        </p>
        <SimulatedDeliveryNote className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900" />
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Queued" value={counts.QUEUED} hint="worker picks up" tone="warning" />
        <StatTile label="Marked delivered (simulated)" value={counts.SENT} tone="muted" />
        <StatTile label="Failed" value={counts.FAILED} tone="danger" />
      </div>

      {showLinks && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <strong>Development-only:</strong> expert portal links are shown in full below so the
          whole workflow can be demonstrated without email. This is controlled by
          <code className="mx-1">EXPOSE_PORTAL_LINKS_IN_UI</code>
          and is forced off in a production build.
        </div>
      )}

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
            placeholder="Subject, recipient or body"
          />
        </div>
        <div className="w-48">
          <label className="label" htmlFor="status">
            Status
          </label>
          <select id="status" name="status" className="select" defaultValue={status ?? ''}>
            <option value="">All</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase()} ({counts[value]})
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-secondary" type="submit">
          Apply
        </button>
      </form>

      {messages.length === 0 ? (
        <EmptyState title="No messages" hint="Invite an expert to generate one." />
      ) : (
        <div className="space-y-3">
          {messages.map((message) => (
            <Card
              key={message.id}
              title={message.subject}
              description={`to ${message.toName || message.toEmail} <${message.toEmail}> · template ${message.template} · ${formatRelative(message.createdAt)}`}
              actions={
                <div className="flex items-center gap-2">
                  <StatusBadge
                    status={message.status}
                    title={
                      message.status === 'SENT'
                        ? `Marked delivered by the worker at ${formatDateTime(message.sentAt)}. Not actually emailed.`
                        : 'Waiting for the worker to run outbox.dispatch.'
                    }
                  />
                  {message.expertId && (
                    <Link
                      className="btn btn-secondary btn-sm"
                      href={`/experts/${message.expertId}`}
                    >
                      Expert
                    </Link>
                  )}
                  {message.projectId && (
                    <Link
                      className="btn btn-secondary btn-sm"
                      href={`/projects/${message.projectId}`}
                    >
                      Project
                    </Link>
                  )}
                </div>
              }
            >
              <pre className="scroll-x whitespace-pre-wrap rounded-md bg-ink-50 p-3 text-xs leading-relaxed text-ink-700">
                {message.bodyText}
              </pre>
              {showLinks && message.devPortalUrl && (
                <p className="mt-2 text-xs">
                  <span className="font-semibold text-amber-900">Portal link (dev only): </span>
                  <a className="text-accent-600 underline" href={message.devPortalUrl}>
                    {message.devPortalUrl}
                  </a>
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
