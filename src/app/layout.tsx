import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ExpertOps',
  description: 'Local-only operator workspace for expert sourcing, onboarding and staffing.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
