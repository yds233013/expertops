import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, operatorToken } from '../helpers/api';
import { makeExpert, makeOperator, makeProject } from '../helpers/factories';
import { GET as candidatesRoute } from '@/app/api/projects/[projectId]/candidates/route';

/**
 * Searching the network against a project's brief is a read, and reads here
 * still need a signed-in operator: the results carry names, addresses and rates.
 */
describe('GET /api/projects/:id/candidates', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function setup() {
    const operator = await makeOperator({ role: 'ADMIN', email: `ops.${Date.now()}@test.local` });
    const project = await makeProject(operator.id, {
      status: 'MATCHING',
      requirements: [{ name: 'Code Review', required: true, minProficiency: 3 }],
    });
    const expert = await makeExpert({
      fullName: 'Searchable Person',
      email: 'searchable.person@example.test',
      status: 'VERIFIED',
      skills: [{ name: 'Code Review', proficiency: 4, yearsUsed: 4 }],
    });
    return { operator, project, expert };
  }

  it('refuses an anonymous caller', async () => {
    const { project } = await setup();
    const result = await callRoute(
      candidatesRoute,
      buildRequest('GET', `/api/projects/${project.id}/candidates`, {
        searchParams: { search: 'Searchable' },
      }),
      { projectId: project.id },
    );
    expect([401, 403]).toContain(result.status);
  });

  it('returns scored matches for a signed-in operator', async () => {
    const { operator, project, expert } = await setup();
    const result = await callRoute(
      candidatesRoute,
      buildRequest('GET', `/api/projects/${project.id}/candidates`, {
        searchParams: { search: 'Searchable' },
        operatorToken: await operatorToken(operator),
      }),
      { projectId: project.id },
    );

    expect(result.status).toBe(200);
    const matches = result.body.matches as { expertId: string; excluded: boolean }[];
    expect(matches.map((m) => m.expertId)).toContain(expert.id);
    expect(matches.find((m) => m.expertId === expert.id)!.excluded).toBe(false);
  });
});
