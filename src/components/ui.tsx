import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/** Small presentational primitives shared by the operator workspace and portal. */

const TONE_CLASS = {
  neutral: 'bg-ink-100 text-ink-700 border-ink-200',
  info: 'bg-accent-50 text-accent-700 border-accent-100',
  success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  warning: 'bg-amber-50 text-amber-900 border-amber-200',
  danger: 'bg-rose-50 text-rose-800 border-rose-200',
  muted: 'bg-ink-50 text-ink-500 border-ink-200',
} as const;

export type Tone = keyof typeof TONE_CLASS;

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold',
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  // Expert
  PROSPECT: 'neutral',
  ONBOARDING: 'info',
  PENDING_VERIFICATION: 'warning',
  VERIFIED: 'success',
  REJECTED: 'danger',
  ARCHIVED: 'muted',
  // Project
  DRAFT: 'neutral',
  MATCHING: 'info',
  INVITING: 'info',
  STAFFING: 'warning',
  ACTIVE: 'success',
  CLOSED: 'muted',
  CANCELLED: 'muted',
  // Invitation
  SENT: 'info',
  ACCEPTED: 'success',
  DECLINED: 'danger',
  EXPIRED: 'muted',
  WITHDRAWN: 'muted',
  // Onboarding
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'info',
  SUBMITTED: 'warning',
  // Assignment
  PROPOSED: 'info',
  CONFIRMED: 'success',
  RELEASED: 'muted',
  COMPLETED: 'success',
  // Jobs / outbox
  PENDING: 'neutral',
  RUNNING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'warning',
  DEAD: 'danger',
  QUEUED: 'warning',
};

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'} title={title}>
      {status.replace(/_/g, ' ').toLowerCase()}
    </Badge>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-ink-900">{value}</span>
        {hint && <Badge tone={tone}>{hint}</Badge>}
      </div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 px-4 py-8 text-center">
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

/**
 * Marks an action as automated, human-confirmed, simulated or not yet built.
 * Used throughout the UI so the demo never implies more than the build does.
 */
export type ProvenanceKind = 'automated' | 'operator' | 'simulated' | 'planned';

const PROVENANCE: Record<ProvenanceKind, { label: string; tone: Tone; title: string }> = {
  automated: {
    label: 'Automated',
    tone: 'info',
    title: 'Performed by the background worker with no human in the loop.',
  },
  operator: {
    label: 'Operator confirms',
    tone: 'warning',
    title: 'Requires an explicit confirmation by a signed-in human operator.',
  },
  simulated: {
    label: 'Simulated email',
    tone: 'muted',
    title: 'Written to the in-app outbox. Nothing is sent to a real mail server.',
  },
  planned: {
    label: 'Not implemented',
    tone: 'danger',
    title: 'A future integration. Not part of this build.',
  },
};

export function ProvenanceTag({ kind }: { kind: ProvenanceKind }) {
  const meta = PROVENANCE[kind];
  return (
    <Badge tone={meta.tone} title={meta.title}>
      {meta.label}
    </Badge>
  );
}

export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-ink-100 py-2 last:border-b-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="text-sm text-ink-800">{children}</dd>
    </div>
  );
}

export function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-100">
        <div
          className="h-full rounded-full bg-accent-500"
          style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
        />
      </div>
      <span className="text-xs font-semibold tabular-nums text-ink-700">{score}</span>
    </div>
  );
}
