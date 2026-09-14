import { environmentLabel } from '@/lib/env';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <a className="skip-link" href="#portal-main">
        Skip to content
      </a>
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="brand">ExpertOps</span>
          <span className="text-xs text-ink-500">Expert portal</span>
        </div>
      </header>
      <main id="portal-main" className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        {children}
      </main>
      <footer className="mx-auto max-w-3xl px-4 pb-8 text-xs text-ink-500 sm:px-6">
        {environmentLabel()}. This portal is reached through a single-use link; no password is ever
        created for an expert account. Messages about it are written to an in-app outbox and are not
        emailed to anyone.
      </footer>
    </div>
  );
}
