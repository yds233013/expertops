export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
          <span className="text-sm font-bold tracking-tight text-ink-900">ExpertOps</span>
          <span className="text-xs text-ink-500">Expert portal</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-6">{children}</main>
      <footer className="mx-auto max-w-3xl px-6 pb-8 text-xs text-ink-500">
        Local development build. This portal is reached through a single-use link; no password is
        ever created for an expert account. Messages about it are written to an in-app outbox and
        are not emailed to anyone.
      </footer>
    </div>
  );
}
