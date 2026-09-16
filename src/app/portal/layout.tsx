import { environmentLabel } from '@/lib/env';
import { PublicShell } from '@/components/public-shell';

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <PublicShell
      audience="Expert portal"
      mainId="portal-main"
      footer={
        <>
          {environmentLabel()}. This portal is reached through a single-use link; no password is
          ever created for an expert account. Messages about it are written to an in-app outbox and
          are not emailed to anyone.
        </>
      }
    >
      {children}
    </PublicShell>
  );
}
