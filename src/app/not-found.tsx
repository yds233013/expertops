import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-6">
      <h1 className="text-lg font-semibold text-ink-900">Page not found</h1>
      <p className="text-sm text-ink-600">The page you asked for does not exist in this build.</p>
      <Link className="btn btn-secondary w-fit" href="/dashboard">
        Back to the workspace
      </Link>
    </main>
  );
}
