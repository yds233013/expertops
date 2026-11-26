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
import { stripeConfig } from '@/server/integrations/stripe';
import { formatDateTime } from '@/lib/time';
import {
  Badge,
  Card,
  EmptyState,
  ProvenanceTag,
  StatTile,
  StatusBadge,
  PageHeader,
} from '@/components/ui';

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

  const canPay = roleHasCapability(operator.role, 'payment:payout');

  // Stripe is optional. A missing key means "export only"; a live key is
  // refused by the config itself, and that refusal is shown, not thrown.
  let stripeUnavailable: string | null = null;
  try {
    if (!stripeConfig().secretKey) {
      stripeUnavailable =
        'Stripe is not configured (no STRIPE_SECRET_KEY). Export the batch instead.';
    }
  } catch (error) {
    stripeUnavailable = error instanceof Error ? error.message : 'Stripe is misconfigured.';
  }

  // Items for the listed batches, with each expert's payout readiness.
  const batchItems = await prisma.paymentItem.findMany({
    where: { batchId: { in: batches.map((batch) => batch.id) } },
    orderBy: { reference: 'asc' },
    include: {
      expert: {
        select: { id: true, fullName: true, stripeAccountId: true, payoutsEnabled: true },
      },
    },
  });
  const payers = await prisma.user.findMany({
    where: { id: { in: batches.flatMap((batch) => (batch.paidById ? [batch.paidById] : [])) } },
    select: { id: true, name: true },
  });
  const payerName = new Map(payers.map((user) => [user.id, user.name]));

  function payoutReadiness(batchId: string) {
    const experts = new Map<string, { name: string; ready: boolean }>();
    for (const item of batchItems) {
      if (item.batchId !== batchId || (item.status !== 'IN_BATCH' && item.status !== 'PAID')) {
        continue;
      }
      experts.set(item.expert.id, {
        name: item.expert.fullName,
        ready: item.expert.payoutsEnabled && item.expert.stripeAccountId !== null,
      });
    }
    const all = [...experts.values()];
    return {
      total: all.length,
      ready: all.filter((expert) => expert.ready).length,
      notReady: all.filter((expert) => !expert.ready).map((expert) => expert.name),
    };
  }

  const readyItems = items.filter((item) => item.status === 'READY');
  const flagged = items.filter((item) => item.status === 'DRAFT');

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Delivery"
        title="Payment preparation"
        description={
          <>
            An approved batch ends one of two ways: exported as a file for a finance process that
            lives elsewhere (<strong>exported is not paid</strong>), or paid by Stripe transfer in
            test mode, which only an admin can start. Only a completed transfer marks an item paid.
          </>
        }
        meta={
          stripeUnavailable ? (
            <Badge tone="muted" title={stripeUnavailable}>
              Stripe off · export only
            </Badge>
          ) : (
            <Badge
              tone="info"
              title="Transfers go to Stripe's test environment. No real money moves."
            >
              Stripe test mode
            </Badge>
          )
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
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
        <StatTile
          label="Paid by transfer"
          value={counts.byStatus.PAID?.count ?? 0}
          hint="test mode"
          tone="success"
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
            {batches.map((batch) => {
              const itemsInBatch = batchItems.filter((item) => item.batchId === batch.id);
              const readiness = payoutReadiness(batch.id);
              const payable = batch.status === 'APPROVED' || batch.status === 'PAYING';
              const withErrors = itemsInBatch.filter((item) => item.payoutError).length;
              return (
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
                      {batch.status === 'PAID' && (
                        <p className="mt-1 text-xs text-emerald-800">
                          Paid by Stripe transfer (test mode) {formatRelative(batch.paidAt)}
                          {batch.paidById
                            ? ` · started by ${payerName.get(batch.paidById) ?? 'an admin'}`
                            : ''}
                          .
                        </p>
                      )}
                      {batch.status === 'PAYING' && (
                        <p className="mt-1 text-xs text-ink-600">
                          Transfers are part-way through
                          {withErrors > 0
                            ? `; ${withErrors} item${withErrors === 1 ? '' : 's'} failed and will be retried on resume`
                            : ''}
                          . The batch can only finish, not be exported or cancelled.
                        </p>
                      )}
                      {payable && readiness.total > 0 && (
                        <p
                          className={
                            readiness.notReady.length > 0
                              ? 'mt-1.5 inline-flex flex-wrap items-center gap-x-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900'
                              : 'mt-1.5 text-xs text-ink-600'
                          }
                        >
                          <span className="font-semibold">
                            {readiness.ready} of {readiness.total} expert
                            {readiness.total === 1 ? '' : 's'} can receive payouts
                          </span>
                          {readiness.notReady.length > 0 && (
                            <span>· not yet: {readiness.notReady.join(', ')}</span>
                          )}
                        </p>
                      )}
                    </div>
                    <PaymentBatchActions
                      batchId={batch.id}
                      reference={batch.reference}
                      status={batch.status}
                      canApprove={canApprove}
                      canWrite={canWrite}
                      payout={{
                        allowed: canPay,
                        unavailableReason: stripeUnavailable,
                        notReady: readiness.notReady,
                        totalLabel: `${minorToPlainDecimal(batch.totalMinor)} ${batch.currency}`,
                        itemCount: itemsInBatch.filter(
                          (item) => item.status === 'IN_BATCH' || item.status === 'PAID',
                        ).length,
                      }}
                    />
                  </div>

                  {itemsInBatch.length > 0 && (
                    <details
                      className="group mt-3 border-t border-ink-100 pt-2"
                      open={batch.status === 'PAYING' || withErrors > 0}
                    >
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-xs font-semibold text-ink-700">
                        <span
                          aria-hidden="true"
                          className="text-ink-400 transition-transform group-open:rotate-90"
                        >
                          &rsaquo;
                        </span>
                        Items ({itemsInBatch.length})
                        {withErrors > 0 && <Badge tone="danger">{withErrors} failed</Badge>}
                      </summary>
                      <div className="scroll-x mt-2 rounded-md border border-ink-200">
                        <table className="data">
                          <thead>
                            <tr>
                              <th scope="col">Item</th>
                              <th scope="col">Expert</th>
                              <th scope="col" className="text-right">
                                Amount
                              </th>
                              <th scope="col">Status</th>
                              <th scope="col">Stripe transfer</th>
                            </tr>
                          </thead>
                          <tbody>
                            {itemsInBatch.map((item) => {
                              const ready =
                                item.expert.payoutsEnabled && item.expert.stripeAccountId !== null;
                              return (
                                <tr key={item.id}>
                                  <td className="whitespace-nowrap font-mono text-xs">
                                    {item.reference}
                                  </td>
                                  <td className="whitespace-nowrap">
                                    <Link
                                      className="text-accent-600 hover:underline"
                                      href={`/experts/${item.expert.id}`}
                                    >
                                      {item.expert.fullName}
                                    </Link>
                                    {payable && !ready && (
                                      <span className="ml-1.5">
                                        <Badge tone="warning">payouts not set up</Badge>
                                      </span>
                                    )}
                                  </td>
                                  <td className="whitespace-nowrap text-right tabular-nums">
                                    {minorToPlainDecimal(item.amountMinor)} {item.currency}
                                  </td>
                                  <td>
                                    <StatusBadge status={item.status} />
                                  </td>
                                  <td className="min-w-[12rem] text-xs">
                                    {item.stripeTransferId ? (
                                      <span className="block">
                                        <span className="font-mono text-ink-800 break-anywhere">
                                          {item.stripeTransferId}
                                        </span>
                                        <span
                                          className="block text-ink-500"
                                          title={formatDateTime(item.paidAt)}
                                        >
                                          paid {formatRelative(item.paidAt)}
                                        </span>
                                      </span>
                                    ) : item.payoutError ? null : (
                                      <span className="text-ink-400">—</span>
                                    )}
                                    {item.payoutError && (
                                      <span className="block rounded bg-rose-50 px-1.5 py-0.5 text-rose-800 break-anywhere">
                                        {item.payoutError}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
