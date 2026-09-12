/**
 * What a finished job actually did, as opposed to whether it ran.
 *
 * A scheduled scan that finds nothing to do succeeds. On a screen that shows
 * only a green "succeeded" badge and a JSON blob, that is indistinguishable
 * from a scan that delivered twenty emails — and `{"attempted":0,"delivered":0}`
 * next to a success badge reads, at a glance, as though mail went out. Nothing
 * here changes what the worker does; it changes what the operator is told.
 *
 * Everything remains simulated: "delivered" means the worker marked a row in
 * the in-app outbox, never that a message left this machine.
 */
export type JobEffect = 'no-effect' | 'effect' | 'unknown';

/**
 * Count fields whose value says whether a run changed anything.
 *
 * Names are matched rather than enumerated per job type, because a handler
 * returning a new counter should be described correctly without anyone
 * remembering to update a table here. Anything unrecognised reports `unknown`
 * rather than guessing.
 */
const EFFECT_KEYS = [
  'delivered',
  'sent',
  'created',
  'enqueued',
  'reminded',
  'expired',
  'assigned',
  'resolved',
  'raised',
  'opened',
  'updated',
  'flagged',
  'drafted',
  'escalated',
  'nudged',
  'released',
  'prunedJobs',
  'tasksCreated',
  'dispatched',
  'purgedSessions',
  'recovered',
];

export interface JobOutcome {
  effect: JobEffect;
  /** A short sentence for the operator, or null when nothing can be said. */
  summary: string | null;
}

export function describeJobOutcome(result: unknown): JobOutcome {
  if (result === null || typeof result !== 'object') return { effect: 'unknown', summary: null };

  const record = result as Record<string, unknown>;
  const counters: Array<[string, number]> = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'number') continue;
    if (!EFFECT_KEYS.includes(key)) continue;
    counters.push([key, value]);
  }

  // A handler that reports it skipped is telling us plainly.
  if (typeof record.skipped === 'string') {
    return { effect: 'no-effect', summary: `nothing to do: ${record.skipped}` };
  }

  if (counters.length === 0) return { effect: 'unknown', summary: null };

  const changed = counters.filter(([, value]) => value > 0);
  if (changed.length === 0) {
    return { effect: 'no-effect', summary: 'ran, nothing to do' };
  }

  return {
    effect: 'effect',
    summary: changed
      .map(([key, value]) => `${value} ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
      .join(', '),
  };
}
