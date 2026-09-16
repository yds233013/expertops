import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentOperator } from '@/server/http/context';
import { getEnv } from '@/lib/env';
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const operator = await currentOperator();
  if (operator) redirect('/dashboard');

  // The demo hint is shown only outside production, and only lists the seeded
  // accounts by email - never a password from a real environment.
  const showDemoHint = getEnv().NODE_ENV !== 'production';

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* The rail's navy, so the first screen looks like the product rather than
          a form floating on an empty field. Hidden on a phone, where the form
          is the only thing worth the space. */}
      <aside className="auth-panel hidden lg:flex">
        <span className="brand text-white">
          <span className="brand-mark" aria-hidden="true">
            EO
          </span>
          ExpertOps
        </span>
        <div className="max-w-md">
          <p className="text-2xl font-semibold leading-snug tracking-tight text-white">
            One workspace for recruiting, screening, onboarding and staffing expert contributors.
          </p>
          <ul className="mt-6 space-y-3 text-sm text-navy-100">
            <li className="flex gap-3">
              <span className="auth-tick" aria-hidden="true" />A person makes every qualification,
              verification and staffing decision.
            </li>
            <li className="flex gap-3">
              <span className="auth-tick" aria-hidden="true" />
              Outreach and payment batches need a second operator’s approval.
            </li>
            <li className="flex gap-3">
              <span className="auth-tick" aria-hidden="true" />
              Every change is attributed and kept in an append-only history.
            </li>
          </ul>
        </div>
        <p className="text-xs text-navy-100">
          Email is simulated and payments are exported, never executed.
        </p>
      </aside>

      <main className="flex flex-col justify-center px-6 py-12 sm:px-10">
        <div className="mx-auto w-full max-w-sm space-y-6">
          <header>
            <span className="brand lg:hidden">
              <span className="brand-mark" aria-hidden="true">
                EO
              </span>
              ExpertOps
            </span>
            <h1 className="page-title mt-6 lg:mt-0">Sign in to ExpertOps</h1>
            <p className="page-subtitle">
              For operators. Experts and applicants use a private link.
            </p>
          </header>

          <LoginForm />

          {showDemoHint && (
            <section className="rounded-lg border border-dashed border-ink-300 px-4 py-3 text-xs text-ink-600">
              <p className="font-semibold text-ink-800">Development-only demo accounts</p>
              <ul className="mt-2 space-y-1">
                <li>
                  <code>admin@expertops.test</code> — full access including job administration
                </li>
                <li>
                  <code>operator@expertops.test</code> — day-to-day staffing operations
                </li>
                <li>
                  <code>viewer@expertops.test</code> — read-only
                </li>
              </ul>
              <p className="mt-2">
                All three use the password from <code>SEED_DEMO_PASSWORD</code> in your{' '}
                <code>.env</code>. These accounts exist only in the local seed and are not available
                in a production build.
              </p>
            </section>
          )}

          {/* The way in for somebody with no account. Below the form and clearly
              labelled, so nobody mistakes it for a way to sign in. */}
          <section className="border-t border-ink-200 pt-5">
            <h2 className="text-sm font-semibold text-ink-900">No account?</h2>
            <p className="mt-1 text-sm text-ink-600">
              Look around a read-only demo workspace running on sample data, or see the practice
              listings applicants use. Neither needs a sign-in.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link className="btn btn-secondary btn-sm" href="/demo">
                Explore the demo
              </Link>
              <Link className="btn btn-secondary btn-sm" href="/apply/opportunities">
                Practice opportunities
              </Link>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
