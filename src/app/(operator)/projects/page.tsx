import Link from 'next/link';
import { prisma } from '@/lib/db';
import { centsToRateDisplay } from '@/lib/money';
import { formatDate } from '@/lib/time';
import { roleHasCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { listProjects, projectCountsByStatus } from '@/server/services/projects';
import { Badge, Card, EmptyState, StatusBadge, PageHeader } from '@/components/ui';
import { type ProjectStatus } from '@prisma/client';

export const dynamic = 'force-dynamic';

const STATUSES: ProjectStatus[] = [
  'DRAFT',
  'MATCHING',
  'INVITING',
  'STAFFING',
  'ACTIVE',
  'CLOSED',
  'CANCELLED',
];

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string }>;
}) {
  const operator = await requireOperator();
  const params = await searchParams;
  const status = STATUSES.includes(params.status as ProjectStatus)
    ? (params.status as ProjectStatus)
    : undefined;

  const [{ projects }, counts] = await Promise.all([
    listProjects(prisma, { status, search: params.search, limit: 100 }),
    projectCountsByStatus(prisma),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Staffing"
        title="Projects"
        description="Each project moves draft → matching → inviting → staffing → active."
        actions={
          roleHasCapability(operator.role, 'project:write') && (
            <Link className="btn btn-primary" href="/projects/new">
              New project
            </Link>
          )
        }
      />

      <form className="card flex flex-wrap items-end gap-3 px-4 py-3" method="get">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="search">
            Search
          </label>
          <input
            id="search"
            name="search"
            className="input"
            defaultValue={params.search ?? ''}
            placeholder="Title, client or code"
          />
        </div>
        <div className="w-56">
          <label className="label" htmlFor="status">
            Status
          </label>
          <select id="status" name="status" className="select" defaultValue={status ?? ''}>
            <option value="">All</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase()} ({counts[value]})
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-secondary" type="submit">
          Apply
        </button>
      </form>

      <Card title={`${projects.length} project${projects.length === 1 ? '' : 's'}`}>
        {projects.length === 0 ? (
          <EmptyState title="No projects match that filter" />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Seats</th>
                  <th>Requirements</th>
                  <th>Rate ceiling</th>
                  <th>Starts</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <td>
                      <Link
                        className="font-mono text-xs text-accent-600 hover:underline"
                        href={`/projects/${project.id}`}
                      >
                        {project.code}
                      </Link>
                    </td>
                    <td>
                      <Link
                        className="font-medium text-ink-900 hover:underline"
                        href={`/projects/${project.id}`}
                      >
                        {project.title}
                      </Link>
                      <div className="text-xs text-ink-500">{project.clientName}</div>
                    </td>
                    <td>
                      <StatusBadge status={project.status} />
                    </td>
                    <td className="tabular-nums">
                      {project.seatsFilled}/{project.seatsRequested}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {project.requirements.map((requirement) => (
                          <Badge
                            key={requirement.id}
                            tone={requirement.required ? 'info' : 'muted'}
                            title={`min proficiency ${requirement.minProficiency}, weight ${requirement.weight}`}
                          >
                            {requirement.skill.name}
                            {requirement.required ? ' *' : ''}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="tabular-nums">
                      {project.maxHourlyRateCents
                        ? centsToRateDisplay(project.maxHourlyRateCents)
                        : '—'}
                    </td>
                    <td className="text-ink-600">{formatDate(project.startDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
