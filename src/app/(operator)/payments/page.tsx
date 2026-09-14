import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate, formatRelative } from '@/lib/time';
import { minorToPlainDecimal } from '@/lib/decimal';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { listBatches, listPaymentItems, paymentCounts } from '@/server/services/payments';
import { ResolveDiscrepancy } from '@/components/resolve-discrepancy';
import { CreateBatchPanel } from '@/components/create-batch-panel';
import { PaymentBatchActions } from '@/components/payment-batch-actions';
import { Badge, Card, EmptyState, ProvenanceTag, StatTile, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface Discrepancy {
  code: string;
  message: string;
}

export default async function PaymentsPage() {
  const operator = await requireOperator();

  const [items, batches, counts] = await Promise.all([
    listPaymentItems(prisma, { limit: 100 }),
    listBatches(prisma, { limit: 25 }),
    paymentCounts(prisma),
  ]);

  const canWrite = roleHasCapability(operator.role, 'payment:write');
  const canApprove = roleHasCapability(operator.role, 'payment:approve');

  const readyItems = items.filter((item) => item.status === 'READY');
  const flagged = items.filter((item) => item.status === 'DRAFT');

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">Payment preparation</h1>
        <p className="mt-1 text-sm text-ink-600">
          Prepares an approved file for a finance process that lives elsewhere. Nothing here moves
          money, and <strong>exported is not paid</strong>. There is deliberately no action that
          marks an expert as paid.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Needs explanation"
          value={counts.withOpenDiscrepancies}
          tone={counts.withOpenDiscrepancies > 0 ? 'warning' : 'neutral'}
          hint="operator action"
        />
        <StatTile label="Ready to batch" value={counts.byStatus.READY?.count ?? 0} />
        <StatTile label="In a batch" value={counts.byStatus.IN_BATCH?.count ?? 0} />
        <StatTile
          label="Exported"
          value={counts.byStatus.EXPORTED?.count ?? 0}
          hint="not paid"
          tone="muted"
        />
      </div>

      <Card
        title={`Items needing an explanation (${flagged.length})`}
        description="A flagged item cannot enter a batch until someone records why the figures differ."
        actions={<ProvenanceTag kind="operator" />}
      >
        {flagged.length === 0 ? (
          <EmptyState
            title="Nothing flagged"
            hint="Drafts with no discrepancy go straight to ready."
          />
        ) : (
          <ul className="space-y-3">
            {flagged.map((item) => {
              const flags = (item.discrepancies as unknown as Discrepancy[]) ?? [];
              return (
                <li
                  key={item.id}
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{item.reference}</span>
                        <strong className="text-sm text-ink-900">
                          {minorToPlainDecimal(item.amountMinor)} {item.currency}
                        </strong>
                        <Link
                          className="text-xs text-accent-600 hover:underline"
                          href={`/experts/${item.expert.id}`}
                        >
                          {item.expert.fullName}
                        </Link>
                      </div>
                      <p className="mt-1 text-xs text-ink-600">
                        {item.quantity.toString()} × {minorToPlainDecimal(item.rateMinor)}
                        {item.workItem ? ` · ${item.workItem.reference}` : ''}
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {flags.map((flag) => (
                          <li key={flag.code} className="text-xs text-amber-900">
                            <Badge tone="warning">
                              {flag.code.replace(/_/g, ' ').toLowerCase()}
                            </Badge>{' '}
                            {flag.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {canWrite && (
                      <ResolveDiscrepancy paymentItemId={item.id} reference={item.reference} />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title={`Ready to batch (${readyItems.length})`}
        description="Cleared items waiting to be gathered into a batch for approval."
      >
        {readyItems.length === 0 ? (
          <EmptyState title="Nothing ready" />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Expert</th>
                  <th scope="col">Project</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Rate</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {readyItems.map((item) => (
                  <tr key={item.id}>
                    <td className="font-mono text-xs">{item.reference}</td>
                    <td>
                      <Link
                        className="text-accent-600 hover:underline"
                        href={`/experts/${item.expert.id}`}
                      >
                        {item.expert.fullName}
                      </Link>
                    </td>
                    <td>
                      <Link
                        className="text-accent-600 hover:underline"
                        href={`/projects/${item.project.id}`}
                      >
                        {item.project.code}
                      </Link>
                    </td>
                    <td className="tabular-nums">{item.quantity.toString()}</td>
                    <td className="tabular-nums">{minorToPlainDecimal(item.rateMinor)}</td>
                    <td className="tabular-nums font-semibold">
                      {minorToPlainDecimal(item.amountMinor)} {item.currency}
                    </td>
                    <td className="text-xs text-ink-500">{formatRelative(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canWrite && (
          <CreateBatchPanel
            items={readyItems.map((item) => ({
              id: item.id,
              reference: item.reference,
              label: `${item.expert.fullName} · ${item.project.code}`,
              amount: `${minorToPlainDecimal(item.amountMinor)} ${item.currency}`,
            }))}
          />
        )}
      </Card>

      <Card
        title={`Batches (${batches.length})`}
        description="A batch must be approved by someone other than the operator who created it."
        actions={<ProvenanceTag kind="operator" />}
      >
        {batches.length === 0 ? (
          <EmptyState title="No batches yet" />
        ) : (
          <div className="space-y-2">
            {batches.map((batch) => (
              <div key={batch.id} className="rounded-lg border border-ink-200 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{batch.reference}</span>
                      <StatusBadge status={batch.status} />
                      <strong className="text-sm text-ink-900">
                        {minorToPlainDecimal(batch.totalMinor)} {batch.currency}
                      </strong>
                      <span className="text-xs text-ink-500">{batch._count.items} item(s)</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-600">
                      {formatDate(batch.periodStart)} → {formatDate(batch.periodEnd)}
                      {batch.createdBy ? ` · created by ${batch.createdBy.name}` : ''}
                      {batch.approvedBy ? ` · approved by ${batch.approvedBy.name}` : ''}
                    </p>
                    {batch.status === 'EXPORTED' && (
                      <p className="mt-1 text-xs text-ink-500">
                        Exported {formatRelative(batch.exportedAt)}. This records that a file was
                        produced, not that anyone was paid.
                      </p>
                    )}
                  </div>
                  <PaymentBatchActions
                    batchId={batch.id}
                    reference={batch.reference}
                    status={batch.status}
                    canApprove={canApprove}
                    canWrite={canWrite}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
