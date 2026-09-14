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
        {/* The first stop for a keyboard, so the nav can be skipped. */}
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
