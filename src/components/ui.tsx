import Link from 'next/link';
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
  // Candidates and screenings. Warm tones mean a person has something to do.
  DUPLICATE_HOLD: 'danger',
  SCREENING_INVITED: 'info',
  SCREENING_SUBMITTED: 'warning',
  IN_REVIEW: 'warning',
  REVISION_REQUESTED: 'info',
  QUALIFIED: 'success',
  INVITED: 'info',
  DECIDED: 'muted',
  // Applications and opportunities
  ACKNOWLEDGED: 'info',
  SCREENING_STARTED: 'info',
  CLOSED_QUALIFIED: 'success',
  CLOSED_REJECTED: 'muted',
  CLOSED_WITHDRAWN: 'muted',
  PUBLISHED: 'success',
  // Work, support and payments
  ASSIGNED: 'info',
  APPROVED: 'success',
  WAITING_ON_EXPERT: 'info',
  WAITING_ON_OPS: 'warning',
  OPEN: 'warning',
  RESOLVED: 'success',
  READY: 'info',
  IN_BATCH: 'info',
  PENDING_APPROVAL: 'warning',
  // Exported to a CSV for someone else to pay. Deliberately not "success":
  // nothing in this build means the money moved.
  EXPORTED: 'neutral',
  VOID: 'muted',
  DISPATCHED: 'success',
  PARTIALLY_DISPATCHED: 'warning',
  // Actors, on history rows
  OPERATOR: 'neutral',
  EXPERT: 'info',
  CANDIDATE: 'info',
  SYSTEM: 'muted',
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
  footer,
  children,
  className,
  flush = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A pagination row or a summary line, below the body and divided from it. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Drops the body padding. A table brings its own cell padding, so a padded
   * card around one leaves a double margin and a rule that stops short of the
   * card edge.
   */
  flush?: boolean;
}) {
  return (
    <section className={clsx('card', className)}>
      {(title || actions) && (
        <header className="card-header">
          <div className="min-w-0">
            {title && <h2 className="section-title">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx('card-body', flush && 'card-body-flush')}>{children}</div>
      {footer}
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  sub,
  href,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  /** A plain sentence under the number, where a badge would be too loud. */
  sub?: ReactNode;
  /** Where this number is explained. A tile that stands for a list should open it. */
  href?: string;
  tone?: Tone;
}) {
  const body = (
    <>
      <div className="eyebrow mb-0">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[1.75rem] font-semibold leading-none tabular-nums text-ink-900">
          {value}
        </span>
        {hint && <Badge tone={tone}>{hint}</Badge>}
      </div>
      {sub && <p className="mt-1.5 text-xs leading-snug text-ink-500">{sub}</p>}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="card block px-4 py-3.5 transition-shadow hover:border-ink-300 hover:shadow-sm"
      >
        {body}
      </Link>
    );
  }
  return <div className="card px-4 py-3.5">{body}</div>;
}

export function EmptyState({
  title,
  hint,
  action,
  glyph = '\u2014',
}: {
  title: string;
  hint?: string;
  /** The one thing to do next, when there is one. */
  action?: ReactNode;
  /** A single character. Decoration, so it is hidden from assistive tech. */
  glyph?: string;
}) {
  return (
    <div className="empty">
      <span className="empty-glyph" aria-hidden="true">
        {glyph}
      </span>
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-body">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
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

/**
 * One page heading, so every screen announces itself the same way.
 *
 * The pages each rolled their own `<h1>` with the same three utility classes,
 * which stayed consistent only as long as nobody typed a different number.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  eyebrow,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons or links, kept on the same line on wide screens. */
  actions?: ReactNode;
  /** Badges that qualify the title, such as a status or a provenance tag. */
  meta?: ReactNode;
  /** The section this page belongs to. Reference, not a link. */
  eyebrow?: ReactNode;
  /** A detail page should always say what it is a detail of. */
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-5">
      {back && (
        <Link
          href={back.href}
          className="mb-2 inline-flex items-center gap-1 text-xs font-semibold text-ink-500 hover:text-accent-700"
        >
          <span aria-hidden="true">&larr;</span> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="page-title">{title}</h1>
            {meta}
          </div>
          {description && <p className="page-subtitle">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export type AlertTone = 'success' | 'error' | 'warning' | 'info';

const ALERT_CLASS: Record<AlertTone, string> = {
  success: 'alert-success',
  error: 'alert-error',
  warning: 'alert-warning',
  info: 'alert-info',
};

/**
 * Feedback after an action.
 *
 * `role` differs on purpose: a failure interrupts a screen reader, a success
 * waits its turn. Getting that backwards is how an error goes unnoticed.
 */
export function Alert({
  tone,
  children,
  className,
}: {
  tone: AlertTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={clsx('alert', ALERT_CLASS[tone], className)}
    >
      {children}
    </p>
  );
}

/** A placeholder with the shape of what is loading, not a spinner. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={clsx('skeleton', className)} />;
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   List furniture.

   Every index page has a filter row, a table and a way to page through the
   results. They were each assembled by hand, which is why no two of them had
   the same spacing or the same wording for "nothing matched".
   --------------------------------------------------------------------------- */

/** The row above a table. Children are fields; `actions` sit at the far end. */
export function Toolbar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="toolbar">
      {children}
      {actions && (
        <>
          <span className="toolbar-spacer" />
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </>
      )}
    </div>
  );
}

/** A labelled control in a toolbar. The label is visible, never a placeholder. */
export function ToolbarField({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('toolbar-field', className)}>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * A filter that is currently narrowing the list.
 *
 * A filter you cannot see is a filter you forget you set, and then the list
 * looks empty for no reason. `clearHref` is a link rather than a button so it
 * works before hydration and can be opened in a new tab.
 */
export function FilterChip({ label, clearHref }: { label: ReactNode; clearHref?: string }) {
  return (
    <span className="filter-chip">
      {label}
      {clearHref && (
        <Link className="filter-chip-clear" href={clearHref} aria-label={`Clear filter`}>
          <span aria-hidden="true">&times;</span>
        </Link>
      )}
    </span>
  );
}

/**
 * Paging through a list.
 *
 * Says where you are before it says where you can go: "1–25 of 108" is the
 * part an operator actually reads. Links, not buttons, so the page number
 * lives in the URL and a result set can be shared or reloaded.
 */
export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
  unit = 'results',
}: {
  /** One-based. */
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (page: number) => string;
  unit?: string;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="pagination-count">
        {total === 0 ? `No ${unit}` : `${first}–${last} of ${total} ${unit}`}
      </span>
      {lastPage > 1 && (
        <span className="flex items-center gap-2">
          {page > 1 ? (
            <Link className="btn btn-secondary btn-sm" href={hrefFor(page - 1)} rel="prev">
              Previous
            </Link>
          ) : (
            <span className="btn btn-secondary btn-sm" aria-disabled="true">
              Previous
            </span>
          )}
          <span className="pagination-count">
            Page {page} of {lastPage}
          </span>
          {page < lastPage ? (
            <Link className="btn btn-secondary btn-sm" href={hrefFor(page + 1)} rel="next">
              Next
            </Link>
          ) : (
            <span className="btn btn-secondary btn-sm" aria-disabled="true">
              Next
            </span>
          )}
        </span>
      )}
    </nav>
  );
}

/** A table that scrolls inside its own box rather than widening the page. */
export function TableShell({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="scroll-x">
      <table className="data" {...(label ? { 'aria-label': label } : {})}>
        {children}
      </table>
    </div>
  );
}

/**
 * The name of the thing a row is about, with its identifier underneath.
 *
 * Reference codes were taking a column of their own on every table, which is a
 * lot of width for something nobody scans. Under the name they stay findable
 * and stop pushing the useful columns off the edge.
 */
export function CellPrimary({
  children,
  meta,
  href,
}: {
  children: ReactNode;
  meta?: ReactNode;
  href?: string;
}) {
  return (
    <>
      {href ? (
        <Link className="cell-primary hover:text-accent-700 hover:underline" href={href}>
          {children}
        </Link>
      ) : (
        <span className="cell-primary">{children}</span>
      )}
      {meta && <span className="cell-meta truncate">{meta}</span>}
    </>
  );
}

/* ---------------------------------------------------------------------------
   Detail pages.
   --------------------------------------------------------------------------- */

/** Key-value pairs. Collapses to stacked rows on a narrow screen. */
export function KeyValue({ children }: { children: ReactNode }) {
  return <dl className="kv">{children}</dl>;
}

export function KeyValueRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * The decision this page is waiting on.
 *
 * A detail page is a wall of fields, and the thing an operator came to do was
 * one control somewhere in it. This puts that control above the wall and says
 * what it is for.
 */
export function NextAction({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="next-action">
      <span className="next-action-label">Next step</span>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900">{title}</p>
          {children && <div className="mt-0.5 text-sm text-ink-700">{children}</div>}
        </div>
        {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
      </div>
    </div>
  );
}

/** Sub-navigation within a section or a record. */
export function Tabs({
  items,
  current,
}: {
  items: { href: string; label: ReactNode; count?: number }[];
  /** The href of the tab that is open. */
  current: string;
}) {
  return (
    <nav className="tabs" aria-label="Views">
      {items.map((item) => {
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={clsx('tab', active && 'tab-active')}
          >
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span className="ml-1.5 tabular-nums text-ink-400">{item.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * One discreet mark on a surface reading from the seeded fixtures.
 *
 * The sample network is deliberately indistinguishable from a real one in
 * shape, which is the point of a demo and also the risk: somebody has to be
 * able to tell at a glance that nobody on it exists.
 */
export function SampleDataBadge({ title }: { title?: string }) {
  return (
    <span
      className="sample-badge"
      title={
        title ??
        'Every record here was generated by a seeding script. No person, client or payment is real.'
      }
    >
      Demo workspace · Sample data
    </span>
  );
}

/**
 * Paging through a cursor-based list.
 *
 * Cursor pages cannot say "page 3 of 7", only "here is the next lot", so this
 * says how many are on screen out of how many match, and offers the two moves
 * that exist: back to the start, and onward.
 */
export function CursorPagination({
  shown,
  total,
  unit,
  firstHref,
  nextHref,
  nextLabel,
}: {
  shown: number;
  total: number;
  unit: string;
  /** Present only when this is not already the first page. */
  firstHref?: string | null;
  nextHref?: string | null;
  nextLabel: string;
}) {
  if (!firstHref && !nextHref && shown === total) {
    return (
      <div className="pagination">
        <span className="pagination-count">
          {total} {unit}
        </span>
      </div>
    );
  }
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="pagination-count">
        Showing {shown} of {total} {unit}
      </span>
      <span className="flex items-center gap-2">
        {firstHref && (
          <Link className="btn btn-secondary btn-sm" href={firstHref}>
            Back to the start
          </Link>
        )}
        {nextHref && (
          <Link className="btn btn-secondary btn-sm" href={nextHref} rel="next">
            {nextLabel}
          </Link>
        )}
      </span>
    </nav>
  );
}

/**
 * Where something is in a fixed sequence of steps.
 *
 * For people outside the workspace, who do not know the stage names and should
 * not need to: "step 2 of 4, screening" answers the question they actually have,
 * which is how far along they are.
 */
export function ProgressSteps({
  steps,
  current,
  label,
}: {
  steps: string[];
  /** Zero-based index of the step in progress. Equal to `steps.length` when done. */
  current: number;
  label: string;
}) {
  return (
    <ol className="progress-steps" aria-label={label}>
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'todo';
        return (
          <li
            key={step}
            className={clsx('progress-step', `progress-step-${state}`)}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="progress-dot" aria-hidden="true">
              {state === 'done' ? '✓' : index + 1}
            </span>
            <span className="progress-label">
              {step}
              <span className="sr-only">
                {state === 'done' ? ' (done)' : state === 'current' ? ' (in progress)' : ''}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
