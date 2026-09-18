'use client';

import { useState } from 'react';
import { apiGet } from '@/lib/api-client';
import { centsToRateDisplay } from '@/lib/money';
import { InviteButton } from '@/components/invite-button';
import { Badge, EmptyState, StatusBadge } from '@/components/ui';

/**
 * Find anyone in the network for this project, not just the ranked few.
 *
 * A match run keeps a fixed number of candidates, so an eligible expert who
 * scores below the cut cannot be invited from the ranking — including somebody
 * qualified for this very project an hour earlier. This searches the whole
 * network, scored against the same brief by the same engine, and says plainly
 * why anybody who cannot be invited cannot be.
 *
 * It grants nothing on its own: the invitation endpoint re-checks project
 * status, remaining seats, archived experts and existing invitations.
 */
interface Match {
  expertId: string;
  fullName: string;
  email: string;
  reference: string;
  status: string;
  headline: string;
  hourlyRateCents: number;
  currency: string;
  score: number;
  rank: number;
  excluded: boolean;
  exclusionReason: string | null;
  inLatestRun: boolean;
}

export function ExpertSearchInvite({
  projectId,
  seatsLeft,
  canInvite,
}: {
  projectId: string;
  seatsLeft: number;
  canInvite: boolean;
}) {
  const [term, setTerm] = useState('');
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (term.trim().length < 2) {
      setError('Type at least two characters of a name, address or reference.');
      return;
    }
    setPending(true);
    setError(null);
    const result = await apiGet<{ matches: Match[] }>(
      `/api/projects/${projectId}/candidates?search=${encodeURIComponent(term.trim())}`,
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error?.message ?? 'That search could not be run.');
      return;
    }
    setMatches(result.data?.matches ?? []);
  }

  return (
    <div className="border-t border-ink-100 px-4 py-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={search}>
        <div className="toolbar-field min-w-56 flex-1">
          <label className="label" htmlFor={`invite-search-${projectId}`}>
            Invite someone not in the ranking
          </label>
          <input
            id={`invite-search-${projectId}`}
            className="input"
            type="search"
            value={term}
            placeholder="Name, email or reference"
            onChange={(event) => setTerm(event.target.value)}
          />
        </div>
        <button className="btn btn-secondary" type="submit" disabled={pending}>
          {pending ? 'Searching…' : 'Search the network'}
        </button>
      </form>
      <p className="field-hint mt-1">
        Scored against this brief by the same rules as the ranking above. Everyone is checked again
        on the server when the invitation is created.
      </p>

      {error && (
        <p role="alert" className="alert alert-error mt-3">
          {error}
        </p>
      )}

      {matches !== null && matches.length === 0 && !error && (
        <EmptyState
          glyph="⌕"
          title="Nobody matches that search"
          hint="Try a reference such as EXP-0110, or part of an address."
        />
      )}

      {matches !== null && matches.length > 0 && (
        <ul className="mt-3 divide-y divide-ink-100 rounded-lg border border-ink-200">
          {matches.map((match) => (
            <li
              key={match.expertId}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="cell-primary">{match.fullName}</span>
                  <StatusBadge status={match.status} />
                  {match.inLatestRun && <Badge tone="info">already ranked above</Badge>}
                </span>
                <span className="cell-meta">
                  <span className="font-mono">{match.reference}</span> · {match.email} ·{' '}
                  {centsToRateDisplay(match.hourlyRateCents, match.currency)}
                </span>
                <span className="cell-meta">
                  {match.excluded
                    ? `Excluded by a hard filter: ${match.exclusionReason}`
                    : `Score ${match.score} · ranks #${match.rank} against this brief`}
                </span>
              </span>
              {match.excluded ? (
                <span className="text-xs text-ink-400">Cannot be invited</span>
              ) : canInvite ? (
                <InviteButton
                  projectId={projectId}
                  expertId={match.expertId}
                  expertName={match.fullName}
                  disabled={seatsLeft <= 0}
                  disabledReason="All seats filled"
                />
              ) : (
                <span className="text-xs text-ink-400">No permission</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
