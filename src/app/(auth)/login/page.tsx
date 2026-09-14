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
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-12">
      {/* The sign-in screen is the first impression of the workspace, so it
          carries the same navy the rail does rather than floating a card on an
          empty field. */}
      <header className="auth-mark">
        <h1 className="text-xl font-semibold">ExpertOps</h1>
        <p className="mt-1 text-sm text-navy-100">
          Operator workspace for sourcing, onboarding and staffing expert engagements.
        </p>
      </header>

      <LoginForm />

      {showDemoHint && (
        <section className="card px-4 py-3 text-xs text-ink-600">
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
            <code>.env</code>. These accounts exist only in the local seed and are not available in
            a production build.
          </p>
        </section>
      )}

      <p className="text-xs text-ink-500">
        Experts do not have passwords. They enter through a single-use link that appears in the
        simulated outbox.
      </p>
    </main>
  );
}
