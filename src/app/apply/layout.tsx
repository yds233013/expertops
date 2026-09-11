export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <a
        href="#apply-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Skip to content
      </a>
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="text-sm font-bold tracking-tight text-ink-900">ExpertOps</span>
          <span className="text-xs text-ink-500">Screening</span>
        </div>
      </header>
      <main id="apply-main" className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        {children}
      </main>
      <footer className="mx-auto max-w-3xl px-4 pb-8 text-xs text-ink-500 sm:px-6">
        Local development build. This screening is reached through a single-use link; no password is
        ever created for an applicant.
      </footer>
    </div>
  );
}
