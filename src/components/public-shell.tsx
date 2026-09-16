import Link from 'next/link';
import { type ReactNode } from 'react';
import { SampleDataBadge } from '@/components/ui';

/**
 * The frame around every page outside the operator workspace.
 *
 * The public listing, the demo, the applicant's status page and the expert
 * portal each drew their own header, with the brand in a different weight and
 * a different sentence underneath. Somebody moving from a listing to their own
 * status page should recognise it as the same product.
 */
export function PublicShell({
  audience,
  width = 'narrow',
  nav = false,
  mainId,
  footer,
  children,
}: {
  /** Who this page is for, said once in the header. */
  audience: string;
  width?: 'narrow' | 'wide';
  /** Links between the public pages. Off inside a signed-in portal. */
  nav?: boolean;
  /** The skip link's target, unique per layout. */
  mainId: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  const container = width === 'wide' ? 'max-w-5xl' : 'max-w-3xl';
  return (
    <div className="flex min-h-screen flex-col">
      <a className="skip-link" href={`#${mainId}`}>
        Skip to content
      </a>
      <header className="border-b border-ink-200 bg-white">
        <div
          className={`mx-auto flex ${container} flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6`}
        >
          <span className="flex items-center gap-3">
            <span className="brand">
              <span className="brand-mark" aria-hidden="true">
                EO
              </span>
              ExpertOps
            </span>
            <span className="hidden h-4 w-px bg-ink-200 sm:block" aria-hidden="true" />
            <span className="text-sm text-ink-500">{audience}</span>
          </span>
          {nav ? (
            <nav aria-label="Public pages" className="flex flex-wrap items-center gap-1 text-sm">
              <Link className="public-nav-link" href="/apply/opportunities">
                Opportunities
              </Link>
              <Link className="public-nav-link" href="/demo">
                Demo
              </Link>
              <Link className="public-nav-link" href="/login">
                Operator sign-in
              </Link>
            </nav>
          ) : (
            <SampleDataBadge />
          )}
        </div>
      </header>
      <main id={mainId} className={`mx-auto w-full ${container} flex-1 px-4 py-7 sm:px-6`}>
        {children}
      </main>
      <footer className="border-t border-ink-200 bg-white/60">
        <div
          className={`mx-auto flex ${container} flex-wrap items-start justify-between gap-3 px-4 py-4 text-xs text-ink-500 sm:px-6`}
        >
          <p className="max-w-prose">{footer}</p>
          {nav && <SampleDataBadge />}
        </div>
      </footer>
    </div>
  );
}
