import Link from 'next/link';
import { clsx } from 'clsx';
import type { listExpertAccess } from '@/server/services/access';
import { byStatusThenRecent, resourceName, STATUS_HELP, SYSTEM_LABEL } from '@/lib/access-format';
import { GithubUsernameForm } from '@/components/access-actions';
import { GrantDetails } from '@/components/project-access';
import { Badge, Card, StatusBadge } from '@/components/ui';

type Grant = Awaited<ReturnType<typeof listExpertAccess>>[number];

/** An expert's GitHub account and every client system they hold or held. */
export function ExpertAccessCard({
  expertId,
  githubUsername,
  grants,
  canManage,
}: {
  expertId: string;
  githubUsername: string | null;
  grants: Grant[];
  canManage: boolean;
}) {
  const rows = [...grants].sort(byStatusThenRecent);
  return (
    <Card
      title="Client system access"
      description="Granted while they hold a confirmed seat, removed when it ends."
    >
      <div className="space-y-4">
        {canManage ? (
          <GithubUsernameForm
            url={`/api/experts/${expertId}/access`}
            initial={githubUsername}
            hint="Changing it removes access from the old account and grants it to the new one."
          />
        ) : (
          <dl>
            <dt className="label">GitHub username</dt>
            <dd className="font-mono text-sm text-ink-800">
              {githubUsername ?? <span className="font-sans text-ink-400">Not set</span>}
            </dd>
          </dl>
        )}

        {rows.length === 0 ? (
          <p className="text-sm text-ink-500">
            No access yet. It is granted when they take a confirmed seat on a project with
            repositories or channels.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100 border-t border-ink-100">
            {rows.map((grant) => (
              <li
                key={grant.id}
                className={clsx('py-2', grant.status === 'REVOKED' && 'opacity-70')}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-ink-900 break-anywhere">
                      <span className="text-ink-500">{SYSTEM_LABEL[grant.system]} · </span>
                      {resourceName(grant.resource)}
                    </p>
                    <Link
                      className="text-xs text-accent-700 hover:underline"
                      href={`/projects/${grant.project.id}#access`}
                    >
                      {grant.project.code}
                    </Link>
                    {grant.subject && (
                      <span className="font-mono text-xs text-ink-500"> · {grant.subject}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusBadge status={grant.status} title={STATUS_HELP[grant.status]} />
                    {grant.provider === 'simulated' && (
                      <Badge
                        tone="muted"
                        title="Recorded here only. No real access was given or removed."
                      >
                        Simulated
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="mt-1 text-xs">
                  <GrantDetails grant={grant} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
