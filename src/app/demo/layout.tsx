import { PublicShell } from '@/components/public-shell';

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return (
    <PublicShell
      audience="Read-only demo"
      mainId="demo-main"
      width="wide"
      nav
      footer="Read-only. Nothing on these pages can be changed from here, and no form on them submits anything. This is an independent project and is not affiliated with any company."
    >
      {children}
    </PublicShell>
  );
}
