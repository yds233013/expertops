import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { getBatch } from '@/server/services/outreach';
import { listActivity } from '@/server/services/activity';
import { OutreachBatchActions } from '@/components/outreach-actions';
import { Badge, Card, EmptyState, FieldRow, ProvenanceTag, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

const STATE_TONE: Record<string, 'muted' | 'success' | 'warning' | 'danger'> = {
  PENDING: 'muted',
  SENT: 'success',
  SKIPPED: 'warning',
  FAILED: 'danger',
};

/** One batch: who is in it, who approved it, and what dispatch actually did. */
export default async function OutreachBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const operator = await requireOperator();
  const { batchId } = await params;

  const [batch, activity] = await Promise.all([
    getBatch(prisma, batchId),
    listActivity(prisma, { entityType: 'outreach_batch', entityId: batchId, limit: 30 }),
  ]);

  const canWrite = roleHasCapability(operator.role, 'outreach:write');
  const canApprove = roleHasCapability(operator.role, 'outreach:approve');
  const retryable = batch.items.filter((item) =>
    ['PENDING', 'FAILED'].includes(item.dispatchState),
  ).length;
  const sent = batch.items.filter((item) => item.dispatchState === 'SENT').length;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-ink-900">{batch.reference}</h1>
            <StatusBadge status={batch.status} />
            <Badge tone={batch.kind === 'REPLACEMENT' ? 'info' : 'muted'}>
              {batch.kind.replace(/_/g, ' ').toLowerCase()}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-ink-600">
            {batch.items.length} recipient{batch.items.length === 1 ? '' : 's'} · {sent} invited
            {retryable > 0 && ` · ${retryable} outstanding`}
          </p>
        </div>
        <Link className="btn btn-secondary" href="/outreach">
          All batches
        </Link>
      </header>

      {batch.kind === 'REPLACEMENT' && (
        <p className="rounded-md border border-accent-100 bg-accent-50 px-3 py-2 text-sm text-accent-700">
          The worker assembled this batch after somebody withdrew. It still needs a human approval
          like any other: nothing was contacted when it was created.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Provenance">
          <dl>
            <FieldRow label="Project">
              {batch.project ? (
                <Link
                  className="text-accent-600 hover:underline"
                  href={`/projects/${batch.project.id}`}
                >
                  {batch.project.code} · {batch.project.title}
                </Link>
              ) : (
                'not attached to a project'
              )}
            </FieldRow>
            <FieldRow label="Assembled by">{batch.createdBy?.name ?? 'the worker'}</FieldRow>
            <FieldRow label="Approved by">{batch.approvedBy?.name ?? 'not yet approved'}</FieldRow>
            <FieldRow label="Approved at">
              {batch.approvedAt ? formatDateTime(batch.approvedAt) : '—'}
            </FieldRow>
            <FieldRow label="Dispatched at">
              {batch.dispatchedAt ? formatDateTime(batch.dispatchedAt) : '—'}
            </FieldRow>
          </dl>
          {batch.reason && <p className="mt-3 text-sm text-ink-600">{batch.reason}</p>}
          {batch.note && (
            <p className="mt-2 rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700">{batch.note}</p>
          )}
        </Card>

        <Card
          title="Decision"
          description="Approval and dispatch are separate steps, and dispatch needs the approval capability."
          className="lg:col-span-2"
          actions={<ProvenanceTag kind="operator" />}
        >
          <OutreachBatchActions
            batchId={batch.id}
            status={batch.status}
            retryable={retryable}
            canWrite={canWrite}
            canApprove={canApprove}
          />
        </Card>
      </div>

      <Card
        title="Recipients"
        description="A skipped recipient was refused by a business rule and will not be retried. A failed one hit an infrastructure fault and still can be."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="py-2 pr-3 font-semibold">Expert</th>
                <th className="py-2 pr-3 font-semibold">Why</th>
                <th className="py-2 pr-3 font-semibold">Score</th>
                <th className="py-2 pr-3 font-semibold">Attempts</th>
                <th className="py-2 pr-3 font-semibold">State</th>
                <th className="py-2 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {batch.items.map((item) => (
                <tr key={item.id} className="border-b border-ink-100 last:border-b-0">
                  <td className="py-2 pr-3">
                    {item.expert ? (
                      <Link
                        className="font-medium text-accent-600 hover:underline"
                        href={`/experts/${item.expert.id}`}
                      >
                        {item.expert.fullName}
                      </Link>
                    ) : (
                      '—'
                    )}
                    <div className="font-mono text-xs text-ink-500">
                      {item.expert?.reference ?? ''}
                    </div>
                  </td>
                  <td className="max-w-72 py-2 pr-3 text-xs text-ink-600">
                    {item.rationale || '—'}
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-ink-700">{item.matchScore ?? '—'}</td>
                  <td className="py-2 pr-3 tabular-nums text-ink-700">{item.attempts}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={STATE_TONE[item.dispatchState] ?? 'muted'}>
                      {item.dispatchState.toLowerCase()}
                    </Badge>
                  </td>
                  <td className="py-2 text-xs text-ink-700">
                    {item.invitationId && (
                      <span className="text-emerald-800">invitation created</span>
                    )}
                    {item.skippedReason && (
                      <span className="text-amber-900">{item.skippedReason}</span>
                    )}
                    {item.lastError && (
                      <span className="text-rose-800">retryable: {item.lastError}</span>
                    )}
                    {!item.invitationId && !item.skippedReason && !item.lastError && (
                      <span className="text-ink-500">not attempted yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="History">
        {activity.events.length === 0 ? (
          <EmptyState title="No history yet" />
        ) : (
          <ol className="space-y-2">
            {activity.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span
                  className="text-xs tabular-nums text-ink-400"
                  title={formatDateTime(event.createdAt)}
                >
                  {formatRelative(event.createdAt)}
                </span>
                <span className="text-ink-800">{event.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
