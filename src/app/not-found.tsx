import Link from 'next/link';

/**
 * Reached by two different audiences now.
 *
 * An applicant who follows a stale or unpublished opportunity link lands here,
 * and the only way out used to be the operator workspace — a sign-in page they
 * have no account for. Both doors are offered instead of guessing.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-6">
      <h1 className="page-title">Page not found</h1>
      <p className="text-sm text-ink-600">
        The page you asked for does not exist in this build. If you followed a link to an
        opportunity, it may not be open any more.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link className="btn btn-secondary w-fit" href="/apply/opportunities">
          Open opportunities
        </Link>
        <Link className="btn btn-secondary w-fit" href="/dashboard">
          Back to the workspace
        </Link>
      </div>
    </main>
  );
}
