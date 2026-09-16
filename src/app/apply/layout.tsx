import { environmentLabel } from '@/lib/env';
import { PublicShell } from '@/components/public-shell';

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return (
    <PublicShell
      audience="Applicants"
      mainId="apply-main"
      nav
      footer={
        <>
          {environmentLabel()}. No password is ever created for an applicant. Messages are written
          to an in-app outbox and are not emailed to anyone.
        </>
      }
    >
      {children}
    </PublicShell>
  );
}
