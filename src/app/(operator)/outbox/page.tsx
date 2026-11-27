import Link from 'next/link';
import { prisma } from '@/lib/db';
import { portalLinksVisible } from '@/lib/env';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireCapability } from '@/server/http/context';
import { listMessages, outboxCounts } from '@/server/services/outbox';
import { emailConfig } from '@/server/email/provider';
import { SimulatedDeliveryNote } from '@/components/delivery-note';
import {
  Badge,
  Card,
  EmptyState,
  ProvenanceTag,
  StatTile,
  StatusBadge,
  PageHeader,
  TableShell,
} from '@/components/ui';
import { type OutboxMessage, type OutboxStatus, type SuppressionReason } from '@prisma/client';

export const dynamic = 'force-dynamic';

const STATUSES: OutboxStatus[] = ['QUEUED', 'SENT', 'FAILED', 'SUPPRESSED', 'BOUNCED'];

const SUPPRESSION_LABEL: Record<SuppressionReason, string> = {
  BOUNCE: 'bounced',
  COMPLAINT: 'spam complaint',
  MANUAL: 'added by hand',
};

/** Who sent a message: the in-app outbox, or a real provider. */
function MessageProvider({ provider }: { provider: string }) {
  if (provider === 'resend') {
    return (
      <Badge tone="info" title="Handed to Resend for real delivery.">
        Resend
      </Badge>
    );
  }
  return (
    <Badge tone="muted" title="Stored in the outbox only. Nothing was emailed.">
      simulated
    </Badge>
  );
}

function statusTitle(message: OutboxMessage): string {
  switch (message.status) {
    case 'SENT':
      return message.provider === 'resend'
        ? `Accepted by Resend at ${formatDateTime(message.sentAt)}.`
        : `Marked delivered by the worker at ${formatDateTime(message.sentAt)}. Not actually emailed.`;
    case 'SUPPRESSED':
      return `Never sent: ${message.suppressedReason ?? 'the address is suppressed.'}`;
    case 'BOUNCED':
      return `Sent, then reported undeliverable at ${formatDateTime(message.bouncedAt)}.`;
    case 'FAILED':
      return message.lastError ?? 'Sending failed.';
    default:
      return 'Waiting for the worker to run outbox.dispatch.';
  }
}

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

  const [{ messages }, counts, suppressions, suppressionTotal] = await Promise.all([
    listMessages(prisma, { status, search: params.search, limit: 60 }),
    outboxCounts(prisma),
    prisma.emailSuppression.findMany({ orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.emailSuppression.count(),
  ]);
  const config = emailConfig();
  const live = config.provider === 'resend';

  const showLinks = portalLinksVisible();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="System"
        title="Outbox"
        meta={
          live ? (
            <ProvenanceTag
              kind="automated"
              label="Sending via Resend"
              title={`EMAIL_PROVIDER=resend${config.from ? `, from ${config.from}` : ''}. Reserved test domains and suppressed addresses are never sent to.`}
            />
          ) : (
            <ProvenanceTag kind="simulated" />
          )
        }
        description={
          live ? (
            <>
              Messages are sent through Resend{config.from ? ` from ${config.from}` : ''}.
              Suppressed addresses, reserved test domains
              {config.allowedDomains.length > 0 ? ' and domains outside the allow-list' : ''} are
              never sent to; bounces and complaints arrive by webhook and suppress the address.
            </>
          ) : (
            <>
              Every message below was rendered and stored locally. &ldquo;Marked delivered&rdquo;
              means the worker updated this row, and nothing more. Set{' '}
              <code className="text-xs">EMAIL_PROVIDER=resend</code> to send for real.
            </>
          )
        }
      />
      {!live && <SimulatedDeliveryNote className="alert alert-warning text-xs" />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Queued" value={counts.QUEUED} hint="worker picks up" tone="warning" />
        <StatTile
          label={live ? 'Sent' : 'Marked delivered (sandbox)'}
          value={counts.SENT}
          tone="muted"
        />
        <StatTile label="Failed" value={counts.FAILED} tone="danger" />
        <StatTile label="Suppressed" value={counts.SUPPRESSED} sub="Never sent, on purpose" />
        <StatTile
          label="Bounced"
          value={counts.BOUNCED}
          tone="danger"
          hint={counts.BOUNCED > 0 ? 'address suppressed' : undefined}
        />
      </div>

      <Card
        title={`Suppressed addresses (${suppressionTotal})`}
        description="Mail is never sent to these again. Bounces and complaints are added automatically from provider webhooks."
        flush
      >
        {suppressions.length === 0 ? (
          <EmptyState
            title="No suppressed addresses"
            hint="An address lands here after a hard bounce or a spam complaint."
          />
        ) : (
          <TableShell label="Suppressed addresses">
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Reason</th>
                <th scope="col">Source</th>
                <th scope="col">Added</th>
              </tr>
            </thead>
            <tbody>
              {suppressions.map((row) => (
                <tr key={row.id}>
                  <td className="font-mono text-xs text-ink-800 break-anywhere">{row.email}</td>
                  <td>
                    <Badge tone={row.reason === 'MANUAL' ? 'neutral' : 'danger'}>
                      {SUPPRESSION_LABEL[row.reason]}
                    </Badge>
                  </td>
                  <td className="max-w-[16rem] text-xs text-ink-600 break-anywhere">
                    {row.source || '—'}
                  </td>
                  <td
                    className="whitespace-nowrap text-xs text-ink-600"
                    title={formatDateTime(row.createdAt)}
                  >
                    {formatRelative(row.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

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
                <div className="flex flex-wrap items-center gap-2">
                  <MessageProvider provider={message.provider} />
                  <StatusBadge status={message.status} title={statusTitle(message)} />
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
              {(message.deliveredAt ||
                message.bouncedAt ||
                message.suppressedReason ||
                (message.status === 'FAILED' && message.lastError)) && (
                <div className="mb-3 space-y-1.5 text-xs">
                  {message.deliveredAt && (
                    <p className="text-ink-600">
                      Delivered {formatDateTime(message.deliveredAt)}, as reported by the provider.
                    </p>
                  )}
                  {message.bouncedAt && (
                    <p className="rounded-md bg-rose-50 px-2.5 py-1.5 text-rose-800">
                      Bounced {formatDateTime(message.bouncedAt)}
                      {message.lastError ? `: ${message.lastError}` : ''}. The address is now
                      suppressed.
                    </p>
                  )}
                  {message.suppressedReason && (
                    <p className="rounded-md bg-ink-100 px-2.5 py-1.5 text-ink-700">
                      <span className="font-semibold">Not sent.</span> {message.suppressedReason}
                    </p>
                  )}
                  {message.status === 'FAILED' && message.lastError && (
                    <p className="rounded-md bg-rose-50 px-2.5 py-1.5 text-rose-800 break-anywhere">
                      {message.lastError}
                    </p>
                  )}
                  {message.providerMessageId && (
                    <p className="text-ink-500">
                      Provider id{' '}
                      <span className="font-mono break-anywhere">{message.providerMessageId}</span>
                    </p>
                  )}
                </div>
              )}
              <pre className="scroll-x whitespace-pre-wrap rounded-md bg-ink-50 p-3 text-xs leading-relaxed text-ink-700">
                {message.bodyText}
              </pre>
              {showLinks && message.devPortalUrl && (
                <p className="mt-2 text-xs">
                  <span className="font-semibold text-amber-900">Portal link (dev only): </span>
                  <a
                    className="text-accent-600 underline break-anywhere"
                    href={message.devPortalUrl}
                  >
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
