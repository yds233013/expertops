import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { listBatches } from '@/server/services/outreach';
import { getLatestMatchRun } from '@/server/services/matching';
import { OutreachBuilder, type RecipientOption } from '@/components/outreach-builder';
import { Badge, Card, EmptyState, ProvenanceTag, StatTile, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Bulk outreach.
 *
 * The whole point of a batch is that contacting twenty people is a different
 * decision from contacting one. Assembling a list is automatic; sending it is
 * an approval by a named human, and dispatch is a separate act after that.
 */
export default async function OutreachPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const operator = await requireOperator();
  const { projectId } = await searchParams;

  const [batches, projects] = await Promise.all([
    listBatches(prisma),
    prisma.project.findMany({
      where: { status: { in: ['MATCHING', 'INVITING', 'STAFFING'] } },
      select: { id: true, code: true, title: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  const canWrite = roleHasCapability(operator.role, 'outreach:write');
  const selectedProject = projectId ? projects.find((p) => p.id === projectId) : undefined;

  // Recipients come from the project's latest match run, so this screen never
  // becomes a second ranking implementation.
  const recipients: RecipientOption[] = [];
  if (selectedProject) {
    const [matchRun, invited] = await Promise.all([
      getLatestMatchRun(prisma, selectedProject.id),
      prisma.invitation.findMany({
        where: { projectId: selectedProject.id, status: { in: ['DRAFT', 'SENT', 'ACCEPTED'] } },
        select: { expertId: true },
      }),
    ]);
    const alreadyInvited = new Set(invited.map((row) => row.expertId));

    for (const candidate of matchRun?.candidates ?? []) {
      if (candidate.excluded) continue;
      const breakdown = candidate.breakdown as { notes?: string[] } | null;
      recipients.push({
        expertId: candidate.expertId,
        fullName: candidate.expert.fullName,
        reference: candidate.expert.reference,
        status: candidate.expert.status,
        rationale: (breakdown?.notes ?? []).join('; '),
        matchScore: candidate.score,
        // A readiness blocker stops staffing, not inviting, so the only thing
        // that genuinely blocks outreach is an invitation already in flight.
        blocker: alreadyInvited.has(candidate.expertId) ? 'already invited' : null,
      });
    }
  }

  const byStatus = (status: string) => batches.filter((batch) => batch.status === status).length;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">Bulk outreach</h1>
        <p className="mt-1 text-sm text-ink-600">
          The system assembles who is worth contacting. It never contacts them: a batch waits in
          approval until a named operator approves it, and dispatch is a separate, explicit step.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Drafts" value={byStatus('DRAFT')} />
        <StatTile
          label="Awaiting approval"
          value={byStatus('PENDING_APPROVAL')}
          tone="warning"
          hint="operator decision"
        />
        <StatTile
          label="Part dispatched"
          value={byStatus('PARTIALLY_DISPATCHED')}
          tone={byStatus('PARTIALLY_DISPATCHED') > 0 ? 'warning' : 'neutral'}
          hint={byStatus('PARTIALLY_DISPATCHED') > 0 ? 'retryable' : undefined}
        />
        <StatTile label="Dispatched" value={byStatus('DISPATCHED')} tone="success" />
      </div>

      {canWrite && (
        <Card
          title="Assemble a batch"
          description="Recipients come from the project's latest match run, so the ranking is the same one the project screen shows."
          actions={<ProvenanceTag kind="operator" />}
        >
          <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
            <div className="min-w-64">
              <label className="label" htmlFor="projectId">
                Project
              </label>
              <select
                id="projectId"
                name="projectId"
                className="select"
                defaultValue={projectId ?? ''}
              >
                <option value="">Choose a project…</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.code} · {project.title}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-secondary" type="submit">
              Load candidates
            </button>
          </form>

          {selectedProject ? (
            <OutreachBuilder
              projectId={selectedProject.id}
              projectLabel={`${selectedProject.code} · ${selectedProject.title}`}
              recipients={recipients}
            />
          ) : (
            <EmptyState
              title="Choose a project"
              hint="Outreach is always for a specific shortage, so recipients are drawn from that project's ranking."
            />
          )}
        </Card>
      )}

      <Card
        title={`Batches (${batches.length})`}
        description="Replacement batches assembled by the worker appear here too, and need the same approval."
      >
        {batches.length === 0 ? (
          <EmptyState title="No outreach batches yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3 font-semibold">Batch</th>
                  <th className="py-2 pr-3 font-semibold">Kind</th>
                  <th className="py-2 pr-3 font-semibold">Project</th>
                  <th className="py-2 pr-3 font-semibold">Recipients</th>
                  <th className="py-2 pr-3 font-semibold">Created by</th>
                  <th className="py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => {
                  const sent = batch.items.filter((item) => item.dispatchState === 'SENT').length;
                  const retryable = batch.items.filter((item) =>
                    ['PENDING', 'FAILED'].includes(item.dispatchState),
                  ).length;
                  return (
                    <tr key={batch.id} className="border-b border-ink-100 last:border-b-0">
                      <td className="py-2 pr-3">
                        <Link
                          className="font-mono text-xs text-accent-600 hover:underline"
                          href={`/outreach/${batch.id}`}
                        >
                          {batch.reference}
                        </Link>
                        <div className="text-xs text-ink-500">
                          {formatRelative(batch.createdAt)}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={batch.kind === 'REPLACEMENT' ? 'info' : 'muted'}>
                          {batch.kind.replace(/_/g, ' ').toLowerCase()}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-ink-700">{batch.project?.code ?? '—'}</td>
                      <td className="py-2 pr-3 tabular-nums text-ink-700">
                        {batch.items.length}
                        {sent > 0 && <span className="text-xs text-ink-500"> · {sent} sent</span>}
                        {retryable > 0 && batch.status === 'PARTIALLY_DISPATCHED' && (
                          <span className="text-xs text-amber-800"> · {retryable} to retry</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-ink-700">
                        {batch.createdBy?.name ?? 'the worker'}
                      </td>
                      <td className="py-2">
                        <StatusBadge status={batch.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
