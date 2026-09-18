import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, operatorToken } from '../helpers/api';
import { makeDomain, makeOperator } from '../helpers/factories';
import { POST as opportunitiesRoute } from '@/app/api/opportunities/route';

/**
 * A question an operator can type must be a question the listing can save.
 *
 * The form used to send the question's label as its `key`, and the route capped
 * `key` at 64 characters while allowing a 300-character label. Any question
 * longer than that refused the whole listing with "Request body failed
 * validation" — naming no field, over a value the operator never typed.
 * Reproduced through the hosted interface on 17 September 2026.
 */
describe('POST /api/opportunities, applicant questions', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  const LONG_LABEL =
    'Describe a review where you changed the outcome. What did you do, and what happened next?';

  async function post(body: unknown) {
    const operator = await makeOperator({ role: 'ADMIN', email: `ops.${Date.now()}@test.local` });
    const token = await operatorToken(operator);
    const domain = await makeDomain('Coding');
    return callRoute(
      opportunitiesRoute,
      buildRequest('POST', '/api/opportunities', {
        body: { title: 'Sample reviewer', domainId: domain.id, ...(body as object) },
        operatorToken: token,
      }),
    );
  }

  it('accepts a question far longer than a stored key, and slugifies the key', async () => {
    expect(LONG_LABEL.length).toBeGreaterThan(64);

    const result = await post({ questions: [{ label: LONG_LABEL, required: true }] });

    expect(result.status).toBe(201);
    const [question] = result.body.opportunity.questions as { key: string; label: string }[];
    expect(question!.label).toBe(LONG_LABEL);
    expect(question!.key.length).toBeLessThanOrEqual(64);
    expect(question!.key).toMatch(/^[a-z0-9-]+$/);
  });

  it('still accepts a caller that sends the label as the key, as the form used to', async () => {
    const result = await post({
      questions: [{ key: LONG_LABEL, label: LONG_LABEL, required: false }],
    });

    expect(result.status).toBe(201);
    const [question] = result.body.opportunity.questions as { key: string }[];
    expect(question!.key.length).toBeLessThanOrEqual(64);
  });

  it('still refuses a question with no label at all', async () => {
    const result = await post({ questions: [{ label: '' }] });
    expect(result.status).toBe(400);
  });
});
