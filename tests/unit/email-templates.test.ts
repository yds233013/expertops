import { describe, expect, it } from 'vitest';
import {
  renderAssignmentConfirmedEmail,
  renderInvitationEmail,
  renderInvitationExpiredEmail,
  renderInvitationReminderEmail,
  renderOnboardingNudgeEmail,
  renderOnboardingRejectedEmail,
  renderOnboardingStartEmail,
  renderOnboardingVerifiedEmail,
  TEMPLATE_NAMES,
} from '@/server/email/templates';

const EXPIRES = new Date('2026-07-01T17:00:00Z');

describe('simulated email templates', () => {
  it('states in every body that nothing was delivered', () => {
    const rendered = [
      renderInvitationEmail({
        expertName: 'Avery Okafor',
        projectTitle: 'Settlement review',
        projectCode: 'PRJ-0001',
        clientName: 'Northwind',
        message: '',
        expiresAt: EXPIRES,
        portalUrl: 'http://localhost:3000/portal/enter#t=abc',
      }),
      renderInvitationReminderEmail({
        expertName: 'Avery Okafor',
        projectTitle: 'Settlement review',
        projectCode: 'PRJ-0001',
        expiresAt: EXPIRES,
        portalUrl: 'http://localhost:3000/portal/enter#t=abc',
      }),
      renderInvitationExpiredEmail({
        expertName: 'Avery Okafor',
        projectTitle: 'Settlement review',
        projectCode: 'PRJ-0001',
      }),
      renderOnboardingStartEmail({
        expertName: 'Avery Okafor',
        portalUrl: 'http://localhost:3000/portal/enter#t=abc',
        outstandingItems: ['Accept the mutual non-disclosure terms'],
      }),
      renderOnboardingVerifiedEmail({ expertName: 'Avery Okafor', operatorName: 'Sam' }),
    ];

    for (const message of rendered) {
      expect(message.bodyText).toContain('simulated outbox');
      expect(message.bodyText).toContain('not delivered to any mail server');
    }
  });

  it('puts the project code in the invitation subject', () => {
    const message = renderInvitationEmail({
      expertName: 'Avery Okafor',
      projectTitle: 'Settlement review',
      projectCode: 'PRJ-0007',
      clientName: 'Northwind',
      message: 'Looking forward to it.',
      expiresAt: EXPIRES,
      portalUrl: 'http://localhost:3000/portal/enter#t=abc',
    });
    expect(message.subject).toContain('PRJ-0007');
    expect(message.bodyText).toContain('Looking forward to it.');
    expect(message.bodyText).toContain('http://localhost:3000/portal/enter#t=abc');
  });

  it('omits the operator note block when there is no note', () => {
    const message = renderInvitationEmail({
      expertName: 'Avery Okafor',
      projectTitle: 'Settlement review',
      projectCode: 'PRJ-0007',
      clientName: 'Northwind',
      message: '',
      expiresAt: EXPIRES,
      portalUrl: 'http://localhost:3000/portal/enter#t=abc',
    });
    expect(message.bodyText).not.toContain('Note from the ExpertOps team');
  });

  it('formats the rate ceiling when one is set', () => {
    const message = renderInvitationEmail({
      expertName: 'Avery Okafor',
      projectTitle: 'Settlement review',
      projectCode: 'PRJ-0007',
      clientName: 'Northwind',
      message: '',
      expiresAt: EXPIRES,
      portalUrl: 'http://localhost:3000/portal/enter#t=abc',
      maxHourlyRateCents: 32_000,
      currency: 'USD',
    });
    expect(message.bodyText).toContain('$320/h');
  });

  it('lists every outstanding item in an onboarding nudge', () => {
    const message = renderOnboardingNudgeEmail({
      expertName: 'Avery Okafor',
      portalUrl: 'http://localhost:3000/portal/enter#t=abc',
      outstandingItems: ['Billing reference', 'Declare any conflicts of interest'],
    });
    expect(message.bodyText).toContain('- Billing reference');
    expect(message.bodyText).toContain('- Declare any conflicts of interest');
  });

  it('includes the operator reason when a submission is returned', () => {
    const message = renderOnboardingRejectedEmail({
      expertName: 'Avery Okafor',
      operatorName: 'Sam Okafor',
      note: 'Billing reference does not match our records.',
    });
    expect(message.bodyText).toContain('Sam Okafor');
    expect(message.bodyText).toContain('Billing reference does not match our records.');
  });

  it('states the allocation and rate on an assignment confirmation', () => {
    const message = renderAssignmentConfirmedEmail({
      expertName: 'Avery Okafor',
      projectTitle: 'Settlement review',
      projectCode: 'PRJ-0007',
      clientName: 'Northwind',
      hoursPerWeek: 16,
      rateCents: 21_500,
      currency: 'USD',
      startDate: new Date('2026-07-06T00:00:00Z'),
      endDate: null,
    });
    expect(message.bodyText).toContain('16 hours per week');
    expect(message.bodyText).toContain('$215/h');
    expect(message.bodyText).not.toContain('End:');
  });

  it('keeps the template registry in step with what is rendered', () => {
    expect(TEMPLATE_NAMES).toContain('invitation.sent');
    expect(TEMPLATE_NAMES).toContain('onboarding.verified');
    expect(TEMPLATE_NAMES).toContain('assignment.confirmed');
    expect(new Set(TEMPLATE_NAMES).size).toBe(TEMPLATE_NAMES.length);
  });
});

describe('the signature names the environment it was rendered in', () => {
  // A hosted staging box used to sign every simulated message "local
  // development instance". A tester reading that has been told, by the system
  // itself, that what they are looking at does not count.
  const render = () =>
    renderInvitationExpiredEmail({
      expertName: 'Avery Okafor',
      projectTitle: 'Settlement review',
      projectCode: 'PRJ-0001',
    }).bodyText;

  it('says local development when that is what it is', async () => {
    const { resetEnvCache } = await import('@/lib/env');
    resetEnvCache();
    expect(render()).toContain('ExpertOps (local development build)');
    expect(render()).not.toContain('hosted deployment');
  });

  it('says hosted deployment on a deployment', async () => {
    const { resetEnvCache } = await import('@/lib/env');
    // A deployment has to satisfy the production configuration guard before it
    // can have a label at all, so the fixture is a whole plausible deployment
    // rather than one flipped variable.
    const previous = {
      EXPERTOPS_ENV: process.env.EXPERTOPS_ENV,
      AUTH_SECRET: process.env.AUTH_SECRET,
      DATABASE_URL: process.env.DATABASE_URL,
      APP_BASE_URL: process.env.APP_BASE_URL,
      SEED_DEMO_PASSWORD: process.env.SEED_DEMO_PASSWORD,
      EXPOSE_PORTAL_LINKS_IN_UI: process.env.EXPOSE_PORTAL_LINKS_IN_UI,
    };
    process.env.EXPERTOPS_ENV = 'production';
    process.env.AUTH_SECRET = 'a'.repeat(64);
    process.env.DATABASE_URL = 'postgresql://app:s3cret@db.internal:5432/railway';
    process.env.APP_BASE_URL = 'https://staging.example.test';
    process.env.SEED_DEMO_PASSWORD = 'not-the-shared-demo-password';
    process.env.EXPOSE_PORTAL_LINKS_IN_UI = 'false';
    resetEnvCache();
    try {
      expect(render()).toContain('ExpertOps (hosted deployment)');
      expect(render()).not.toContain('local development');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvCache();
    }
  });
});
