import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ExpertOps',
  description: 'Operator workspace for expert sourcing, onboarding and staffing.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Each layout owns its own skip link, because each owns the element it
            skips to. One here would be dead on every page but the operator's. */}
        {children}
      </body>
    </html>
  );
}
