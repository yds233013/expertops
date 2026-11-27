'use client';

import type { AccessGrantStatus, AccessSystem } from '@prisma/client';
import { clsx } from 'clsx';
import { expertStatusText, SYSTEM_LABEL } from '@/lib/access-format';
import { GithubUsernameForm } from '@/components/access-actions';
import { Badge, Card } from '@/components/ui';

export interface PortalAccessItem {
  id: string;
  system: AccessSystem;
  /** "owner/repo" or the channel's label. */
  name: string;
  projectCode: string;
  status: AccessGrantStatus;
  invitationPending: boolean;
  simulated: boolean;
}

const STATUS_TONE: Record<AccessGrantStatus, 'success' | 'warning' | 'neutral' | 'muted'> = {
  ACTIVE: 'success',
  PENDING: 'neutral',
  GRANT_FAILED: 'warning',
  REVOKING: 'neutral',
  REVOKE_FAILED: 'neutral',
  REVOKED: 'muted',
};

/**
 * The expert's own access to client systems: which GitHub account to use, and
 * what they have. Status only, in plain words; error details are for the team.
 */
export function AccessPanel({
  githubUsername,
  items,
}: {
  githubUsername: string | null;
  items: PortalAccessItem[];
}) {
  return (
    <Card
      title="Your access"
      description="Repositories and channels for the projects you are staffed on. You get them when your seat is confirmed and lose them when it ends."
    >
      <div className="space-y-4">
        <GithubUsernameForm
          url="/api/portal/github"
          initial={githubUsername}
          hint="The account we add to project repositories. Slack uses the email address we have for you."
        />

        {items.length === 0 ? (
          <p className="text-sm text-ink-500">
            Nothing yet. Access is set up when you are confirmed on a project that needs it.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100 border-t border-ink-100">
            {items.map((item) => {
              const needsUsername =
                item.system === 'GITHUB' && item.status === 'GRANT_FAILED' && !githubUsername;
              return (
                <li
                  key={item.id}
                  className={clsx(
                    'flex flex-wrap items-start justify-between gap-2 py-2',
                    item.status === 'REVOKED' && 'opacity-70',
                  )}
                >
                  <div className="min-w-0">
                    <p className="text-sm text-ink-900 break-anywhere">
                      <span className="text-ink-500">{SYSTEM_LABEL[item.system]} · </span>
                      {item.name}
                    </p>
                    <p className="font-mono text-xs text-ink-500">{item.projectCode}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    <Badge tone={needsUsername ? 'warning' : STATUS_TONE[item.status]}>
                      {needsUsername
                        ? 'Needs your GitHub username'
                        : expertStatusText(item.status, item.invitationPending)}
                    </Badge>
                    {item.simulated && (
                      <Badge
                        tone="muted"
                        title="This workspace is a demo. No real GitHub or Slack access was given."
                      >
                        Simulated
                      </Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
