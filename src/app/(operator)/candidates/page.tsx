import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate, formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import {
  candidateCountsByStage,
  listCandidates,
  listOpenDuplicates,
} from '@/server/services/candidates';
import { listCampaigns, sourceChannelEffectiveness } from '@/server/services/sourcing';
import { CandidateForm } from '@/components/candidate-form';
import { ResolveDuplicate } from '@/components/resolve-duplicate';
import { Badge, Card, EmptyState, StatTile, StatusBadge } from '@/components/ui';
import { type CandidateStage } from '@prisma/client';

export const dynamic = 'force-dynamic';

const STAGES: CandidateStage[] = [
  'NEW',
  'DUPLICATE_HOLD',
  'SCREENING_INVITED',
  'SCREENING_SUBMITTED',
  'IN_REVIEW',
  'REVISION_REQUESTED',
  'QUALIFIED',
  'REJECTED',
  'WITHDRAWN',
];

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; search?: string; due?: string }>;
}) {
  const operator = await requireOperator();
  const params = await searchParams;
  const stage = STAGES.includes(params.stage as CandidateStage)
    ? (params.stage as CandidateStage)
    : undefined;

  const [candidates, counts, duplicates, channels, openCampaigns, operators] = await Promise.all([
    listCandidates(prisma, {
      stage,
      search: params.search,
      dueOnly: params.due === 'true',
      limit: 100,
    }),
    candidateCountsByStage(prisma),
    listOpenDuplicates(prisma, 20),
    sourceChannelEffectiveness(prisma),
    listCampaigns(prisma, { status: 'ACTIVE' }),
    prisma.user.findMany({
      where: { isActive: true, role: { in: ['OPERATOR', 'ADMIN'] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const canWrite = roleHasCapability(operator.role, 'candidate:write');

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">Candidate pipeline</h1>
        <p className="mt-1 text-sm text-ink-600">
          People being assessed for the network. A candidate becomes an expert only after a human
          qualification decision.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="In the funnel"
          value={
            counts.NEW +
            counts.SCREENING_INVITED +
            counts.SCREENING_SUBMITTED +
            counts.IN_REVIEW +
            counts.REVISION_REQUESTED
          }
        />
        <StatTile
          label="Awaiting review"
          value={counts.SCREENING_SUBMITTED + counts.IN_REVIEW}
          tone="warning"
          hint="operator action"
        />
        <StatTile
          label="Duplicate holds"
          value={counts.DUPLICATE_HOLD}
          tone={counts.DUPLICATE_HOLD > 0 ? 'danger' : 'neutral'}
          hint="you decide"
        />
        <StatTile label="Qualified" value={counts.QUALIFIED} tone="success" />
      </div>

      {duplicates.length > 0 && (
        <Card
          title={`Possible duplicate people (${duplicates.length})`}
          description="Raised automatically, resolved only by a human. Nothing is ever merged on its own, because a wrong merge destroys history that cannot be recovered."
        >
          <ul className="space-y-3">
            {duplicates.map((flag) => (
              <li
                key={flag.id}
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={flag.score >= 90 ? 'danger' : 'warning'}>
                        {flag.score}% confidence
                      </Badge>
                      <span className="text-sm font-semibold text-ink-900">
                        {flag.candidate.fullName}
                      </span>
                      <span className="text-xs text-ink-500">{flag.candidate.email}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink-700">{flag.reason}</p>
                    <p className="mt-1 text-xs text-ink-600">
                      Matched against{' '}
                      {flag.matchedExpert ? (
                        <Link
                          className="text-accent-600 hover:underline"
                          href={`/experts/${flag.matchedExpert.id}`}
                        >
                          expert {flag.matchedExpert.reference} ({flag.matchedExpert.email})
                        </Link>
                      ) : flag.matchedCandidate ? (
                        <Link
                          className="text-accent-600 hover:underline"
                          href={`/candidates/${flag.matchedCandidate.id}`}
                        >
                          candidate {flag.matchedCandidate.reference} ({flag.matchedCandidate.email}
                          )
                        </Link>
                      ) : (
                        'an unknown record'
                      )}
                    </p>
                  </div>
                  {canWrite && <ResolveDuplicate flagId={flag.id} name={flag.candidate.fullName} />}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {canWrite && (
        <Card
          title="Add a candidate"
          description="Duplicate detection runs on save. A possible duplicate goes on hold for a human decision; nothing is merged."
        >
          <CandidateForm
            channels={channels.map((channel) => ({ id: channel.id, name: channel.name }))}
            campaigns={openCampaigns.map((campaign) => ({
              id: campaign.id,
              label: `${campaign.code} · ${campaign.name}`,
            }))}
            owners={operators}
          />
        </Card>
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
            placeholder="Name, email or reference"
          />
        </div>
        <div className="w-56">
          <label className="label" htmlFor="stage">
            Stage
          </label>
          <select id="stage" name="stage" className="select" defaultValue={stage ?? ''}>
            <option value="">All stages</option>
            {STAGES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ').toLowerCase()} ({counts[value]})
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-ink-700">
          <input type="checkbox" name="due" value="true" defaultChecked={params.due === 'true'} />
          Next action due
        </label>
        <button className="btn btn-secondary" type="submit">
          Apply
        </button>
      </form>

      <Card title={`${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`}>
        {candidates.length === 0 ? (
          <EmptyState
            title="No candidates match that filter"
            hint="Candidates arrive through applications or a sourcing campaign."
          />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <caption className="sr-only">Candidates in the intake pipeline</caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Name</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Source</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Next action</th>
                  <th scope="col">Screening</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.id}>
                    <td>
                      <Link
                        className="font-mono text-xs text-accent-600 hover:underline"
                        href={`/candidates/${candidate.id}`}
                      >
                        {candidate.reference}
                      </Link>
                    </td>
                    <td>
                      <Link
                        className="font-medium text-ink-900 hover:underline"
                        href={`/candidates/${candidate.id}`}
                      >
                        {candidate.fullName}
                      </Link>
                      <div className="text-xs text-ink-500">{candidate.email}</div>
                      {candidate.contactOptOutAt && (
                        <Badge tone="muted" title="Will not be contacted again">
                          opted out
                        </Badge>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={candidate.stage} />
                      {candidate.duplicateFlags.length > 0 && (
                        <div className="mt-1">
                          <Badge tone="danger">
                            {candidate.duplicateFlags.length} duplicate flag
                          </Badge>
                        </div>
                      )}
                    </td>
                    <td className="text-ink-600">{candidate.sourceChannel?.name ?? '—'}</td>
                    <td className="text-ink-600">{candidate.relationshipOwner?.name ?? '—'}</td>
                    <td className="text-ink-600">
                      {candidate.nextActionAt ? (
                        <>
                          <div>{formatDate(candidate.nextActionAt)}</div>
                          <div className="text-xs text-ink-500">{candidate.nextActionNote}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="text-xs text-ink-600">
                      {candidate.screenings[0] ? (
                        <>
                          <StatusBadge status={candidate.screenings[0].status} />
                          <div className="mt-0.5">
                            due {formatRelative(candidate.screenings[0].dueAt)}
                          </div>
                        </>
                      ) : (
                        'none'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Where qualified experts actually come from"
        description="Counted on qualified outcomes rather than raw volume, so effort goes where it works."
      >
        {channels.length === 0 ? (
          <EmptyState title="No source channels recorded yet" />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Total</th>
                  <th scope="col">Qualified</th>
                  <th scope="col">In flight</th>
                  <th scope="col">Qualified rate</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((channel) => (
                  <tr key={channel.id}>
                    <td className="font-medium text-ink-900">{channel.name}</td>
                    <td className="text-ink-600">
                      {channel.kind.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td className="tabular-nums">{channel.total}</td>
                    <td className="tabular-nums">{channel.qualified}</td>
                    <td className="tabular-nums">{channel.inFlight}</td>
                    <td className="tabular-nums">
                      {channel.qualifiedRate === null ? (
                        <span className="text-ink-400" title="Nothing has been decided yet">
                          not yet
                        </span>
                      ) : (
                        `${channel.qualifiedRate}%`
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
