/**
 * Scripted walkthrough against a running application.
 *
 * Drives the real HTTP API exactly as the browser does - cookies included -
 * from project creation through to a confirmed seat, then exercises the
 * documented failure cases. Run it with `npm run smoke` while `npm run dev`
 * and `npm run worker` are up.
 */
import 'dotenv/config';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'demo-password-123';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

interface Jar {
  operator?: string;
  portal?: string;
  /** Double-submit CSRF token, exactly as a browser would hold it. */
  csrf?: string;
}

/**
 * Fetch the CSRF cookie the way a browser would: by loading a page first.
 *
 * Middleware issues it on any page request, so one GET is enough to pick it up.
 */
async function primeCsrf(jar: Jar): Promise<void> {
  if (jar.csrf) return;
  const response = await fetch(`${BASE}/login`, { redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = /expertops_csrf=([^;]*)/.exec(setCookie);
  if (match?.[1]) jar.csrf = decodeURIComponent(match[1]);
}

async function api<T = any>(
  method: string,
  path: string,
  options: {
    body?: unknown;
    jar?: Jar;
    use?: 'operator' | 'portal';
    /** Send the request without the double-submit header, as a cross-site form would. */
    omitCsrf?: boolean;
  } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const jar = options.jar;
  if (jar) await primeCsrf(jar);

  const cookie: string[] = [];
  if (options.use === 'operator' && jar?.operator) {
    cookie.push(`expertops_session=${jar.operator}`);
  }
  if (options.use === 'portal' && jar?.portal) {
    cookie.push(`expertops_portal=${jar.portal}`);
  }
  if (jar?.csrf) {
    cookie.push(`expertops_csrf=${jar.csrf}`);
    // A same-origin browser submission echoes the cookie in a header.
    if (!options.omitCsrf) headers['x-csrf-token'] = jar.csrf;
  }
  if (cookie.length > 0) headers.cookie = cookie.join('; ');

  // The server checks Origin on every mutation.
  headers.origin = BASE;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    redirect: 'manual',
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie && jar) {
    const operator = /expertops_session=([^;]*)/.exec(setCookie);
    if (operator?.[1]) jar.operator = operator[1];
    const portal = /expertops_portal=([^;]*)/.exec(setCookie);
    if (portal?.[1]) jar.portal = portal[1];
    const csrf = /expertops_csrf=([^;]*)/.exec(setCookie);
    if (csrf?.[1]) jar.csrf = decodeURIComponent(csrf[1]);
  }

  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Poll until the worker has processed whatever we are waiting on. */
async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}. Is the worker running (npm run worker)?`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main() {
  console.log(`ExpertOps smoke walkthrough against ${BASE}\n`);

  section('Health');
  const health = await api('GET', '/api/health');
  check('the app and database are reachable', health.status === 200, health.body);

  section('Authentication and access control');
  const jar: Jar = {};
  const signIn = await api('POST', '/api/auth/login', {
    jar,
    body: { email: 'operator@expertops.test', password: PASSWORD },
  });
  check('an operator can sign in', signIn.status === 200, signIn.body);
  check('a session cookie is issued', Boolean(jar.operator));

  const badPassword = await api('POST', '/api/auth/login', {
    jar: { csrf: jar.csrf },
    body: { email: 'operator@expertops.test', password: 'wrong-password' },
  });
  check('a wrong password is rejected with 401', badPassword.status === 401);

  const anonymous = await api('GET', '/api/projects');
  check('an unauthenticated request is rejected with 401', anonymous.status === 401);

  // A cross-site form post carrying the operator's cookie must be refused.
  const forged = await fetch(`${BASE}/api/experts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://attacker.example',
      cookie: `expertops_session=${jar.operator}; expertops_csrf=${jar.csrf}`,
      'x-csrf-token': jar.csrf ?? '',
    },
    body: JSON.stringify({ fullName: 'Forged', email: 'forged@example.test', headline: 'x' }),
  });
  check('a cross-origin mutation is rejected with 403', forged.status === 403);

  const viewerJar: Jar = {};
  await api('POST', '/api/auth/login', {
    jar: viewerJar,
    body: { email: 'viewer@expertops.test', password: PASSWORD },
  });
  const viewerWrite = await api('POST', '/api/projects', {
    jar: viewerJar,
    use: 'operator',
    body: { title: 'Blocked', clientName: 'Blocked' },
  });
  check('a viewer cannot create a project (403)', viewerWrite.status === 403, viewerWrite.body);

  section('Expert record');
  const stamp = Date.now();
  // The walkthrough creates its own expert rather than reusing a seeded one, so
  // it always starts from a clean PROSPECT with no onboarding history.
  const expertCreated = await api('POST', '/api/experts', {
    jar,
    use: 'operator',
    body: {
      fullName: `Walkthrough Candidate ${stamp}`,
      email: `walkthrough.${stamp}@example.test`,
      headline: 'Principal Consultant — payments platforms',
      yearsExperience: 14,
      hourlyRateCents: 24_000,
      timezone: 'Europe/London',
      weeklyCapacityHours: 25,
      skills: [
        { name: 'Payments Infrastructure', proficiency: 5, yearsUsed: 10 },
        { name: 'Risk Modelling', proficiency: 4, yearsUsed: 6 },
      ],
    },
  });
  check('an expert record is created', expertCreated.status === 201, expertCreated.body);
  const expertId: string = expertCreated.body.expert.id;

  const duplicateExpert = await api('POST', '/api/experts', {
    jar,
    use: 'operator',
    body: {
      fullName: 'Duplicate',
      email: `walkthrough.${stamp}@example.test`,
      headline: 'Duplicate',
    },
  });
  check(
    'a duplicate expert email is refused (409)',
    duplicateExpert.status === 409,
    duplicateExpert.body,
  );

  section('Project creation');
  const created = await api('POST', '/api/projects', {
    jar,
    use: 'operator',
    body: {
      title: `Smoke walkthrough ${stamp}`,
      clientName: 'Northwind Logistics',
      description: 'Created by the scripted walkthrough.',
      seatsRequested: 1,
      minYearsExperience: 5,
      maxHourlyRateCents: 40_000,
      preferredTimezone: 'Europe/London',
      requirements: [
        { skillName: 'Payments Infrastructure', required: true, minProficiency: 3, weight: 5 },
        { skillName: 'Risk Modelling', required: false, minProficiency: 2, weight: 2 },
      ],
    },
  });
  check(
    'the project is created in DRAFT',
    created.status === 201 && created.body.project.status === 'DRAFT',
    created.body,
  );
  const projectId: string = created.body.project.id;

  const earlyMatch = await api('POST', `/api/projects/${projectId}/match`, {
    jar,
    use: 'operator',
    body: {},
  });
  check('matching a draft project is refused (409)', earlyMatch.status === 409, earlyMatch.body);

  const opened = await api('POST', `/api/projects/${projectId}/status`, {
    jar,
    use: 'operator',
    body: { status: 'MATCHING' },
  });
  check('the project opens for matching', opened.status === 200, opened.body);

  const illegal = await api('POST', `/api/projects/${projectId}/status`, {
    jar,
    use: 'operator',
    body: { status: 'CLOSED' },
  });
  check('an illegal status jump is refused (409)', illegal.status === 409, illegal.body);

  section('Matching');
  // A generous limit on purpose. This runs against a development database that
  // accumulates synthetic experts, and a limit of ten eventually pushes the
  // expert this walkthrough just created out of the ranking, failing on the
  // size of the dataset rather than on anything about matching.
  const matched = await api('POST', `/api/projects/${projectId}/match`, {
    jar,
    use: 'operator',
    body: { limit: 100, includeExcluded: true },
  });
  check('a match run is produced', matched.status === 201, matched.body);

  const candidates: any[] = matched.body.matchRun.candidates ?? [];
  const eligible = candidates.filter((candidate) => !candidate.excluded);
  check('at least one candidate is ranked', eligible.length > 0);
  check(
    'excluded candidates carry a reason',
    candidates.filter((c) => c.excluded).every((c) => typeof c.exclusionReason === 'string'),
  );
  check(
    'candidates are ordered by descending score',
    eligible.every(
      (candidate, index) => index === 0 || eligible[index - 1].score >= candidate.score,
    ),
  );

  const topCandidate = eligible.find((candidate) => candidate.expertId === expertId);
  check('the walkthrough expert is ranked as a candidate', Boolean(topCandidate), {
    ranked: eligible.map((candidate) => candidate.expertId),
  });
  if (!topCandidate) throw new Error('The walkthrough expert was not ranked; cannot continue.');

  section('Invitation');
  const invited = await api('POST', `/api/projects/${projectId}/invitations`, {
    jar,
    use: 'operator',
    body: {
      expertId,
      message: 'Scripted walkthrough invitation.',
      ttlHours: 48,
      matchCandidateId: topCandidate.id,
    },
  });
  check('the invitation is created', invited.status === 201, invited.body);
  const invitationId: string = invited.body.invitation.id;

  const duplicate = await api('POST', `/api/projects/${projectId}/invitations`, {
    jar,
    use: 'operator',
    body: { expertId },
  });
  check('a duplicate invitation is refused (409)', duplicate.status === 409, duplicate.body);

  const portalUrl = await waitFor<string>('the worker to send the invitation', async () => {
    const outbox = await api('GET', '/api/outbox', {
      jar,
      use: 'operator',
      body: undefined,
    });
    const message = (outbox.body.messages ?? []).find(
      (item: any) => item.relatedId === invitationId && item.template === 'invitation.sent',
    );
    return message?.devPortalUrl ?? null;
  });
  check('the worker queued a simulated invitation email with a portal link', Boolean(portalUrl));

  await waitFor('the outbox dispatch job', async () => {
    const outbox = await api('GET', '/api/outbox', { jar, use: 'operator' });
    const message = (outbox.body.messages ?? []).find(
      (item: any) => item.relatedId === invitationId && item.template === 'invitation.sent',
    );
    return message?.status === 'SENT' ? message : null;
  });
  check('the simulated email is marked delivered', true);

  section('Expert acceptance');
  const rawToken = new URLSearchParams(new URL(portalUrl).hash.replace(/^#/, '')).get('t')!;
  const portalJar: Jar = {};
  const session = await api('POST', '/api/portal/session', {
    jar: portalJar,
    body: { token: rawToken },
  });
  check('the portal link opens a session', session.status === 200, session.body);

  const reused = await api('POST', '/api/portal/session', {
    jar: { csrf: jar.csrf },
    body: { token: rawToken },
  });
  check('the portal link cannot be reused (401)', reused.status === 401, reused.body);

  const declineWithoutReason = await api(
    'POST',
    `/api/portal/invitations/${invitationId}/respond`,
    { jar: portalJar, use: 'portal', body: { accept: false } },
  );
  check('declining without a reason is refused (400)', declineWithoutReason.status === 400);

  const accepted = await api('POST', `/api/portal/invitations/${invitationId}/respond`, {
    jar: portalJar,
    use: 'portal',
    body: { accept: true },
  });
  check(
    'the expert accepts the invitation',
    accepted.status === 200 && accepted.body.invitation.status === 'ACCEPTED',
    accepted.body,
  );

  const answeredTwice = await api('POST', `/api/portal/invitations/${invitationId}/respond`, {
    jar: portalJar,
    use: 'portal',
    body: { accept: true },
  });
  check('answering twice is refused (409)', answeredTwice.status === 409, answeredTwice.body);

  section('Availability');
  const start = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

  const badWindow = await api('POST', '/api/portal/availability', {
    jar: portalJar,
    use: 'portal',
    body: { startAt: end, endAt: start, hoursPerWeek: 20 },
  });
  check('a backwards availability window is refused (400)', badWindow.status === 400);

  const window = await api('POST', '/api/portal/availability', {
    jar: portalJar,
    use: 'portal',
    body: { startAt: start, endAt: end, hoursPerWeek: 20, projectId },
  });
  check('the expert declares availability', window.status === 201, window.body);

  const overlapping = await api('POST', '/api/portal/availability', {
    jar: portalJar,
    use: 'portal',
    body: { startAt: start, endAt: end, hoursPerWeek: 10, projectId },
  });
  check('an overlapping window is refused (409)', overlapping.status === 409, overlapping.body);

  section('Onboarding');
  const checklist = await api('GET', '/api/portal/onboarding', { jar: portalJar, use: 'portal' });
  check('the checklist opened on acceptance', checklist.status === 200, checklist.body);

  const earlySubmit = await api('POST', '/api/portal/onboarding/submit', {
    jar: portalJar,
    use: 'portal',
  });
  check(
    'submitting an incomplete checklist is refused (409)',
    earlySubmit.status === 409,
    earlySubmit.body,
  );

  const unknownKey = await api('PATCH', '/api/portal/onboarding', {
    jar: portalJar,
    use: 'portal',
    body: { answers: [{ key: 'date_of_birth', value: '1990-01-01' }] },
  });
  check('an unknown checklist key is refused (400)', unknownKey.status === 400, unknownKey.body);

  const items: any[] = checklist.body.onboardingCase.items;
  const filled = await api('PATCH', '/api/portal/onboarding', {
    jar: portalJar,
    use: 'portal',
    body: {
      answers: items
        .filter((item) => item.required)
        .map((item) => ({
          key: item.key,
          value: item.kind === 'ATTESTATION' ? 'true' : `SMOKE-${stamp}`,
        })),
    },
  });
  check('the checklist is completed', filled.status === 200, filled.body);

  const submitted = await api('POST', '/api/portal/onboarding/submit', {
    jar: portalJar,
    use: 'portal',
  });
  check(
    'the checklist is submitted and awaits a human operator',
    submitted.status === 200 && submitted.body.awaitingOperatorVerification === true,
    submitted.body,
  );

  section('Staffing blocked before verification');
  const tooEarly = await api('POST', `/api/projects/${projectId}/assignments`, {
    jar,
    use: 'operator',
    body: { expertId, allocationHoursPerWeek: 16 },
  });
  check(
    'staffing an unverified expert is refused (409)',
    tooEarly.status === 409 && String(tooEarly.body?.error?.message).includes('VERIFIED'),
    tooEarly.body,
  );

  section('Operator verification');
  const viewerVerify = await api('POST', `/api/experts/${expertId}/verify`, {
    jar: viewerJar,
    use: 'operator',
    body: { approve: true },
  });
  check('a viewer cannot verify (403)', viewerVerify.status === 403, viewerVerify.body);

  const verified = await api('POST', `/api/experts/${expertId}/verify`, {
    jar,
    use: 'operator',
    body: { approve: true, note: 'Scripted walkthrough verification.' },
  });
  check('the operator verifies the expert', verified.status === 200, verified.body);

  const verifiedTwice = await api('POST', `/api/experts/${expertId}/verify`, {
    jar,
    use: 'operator',
    body: { approve: false, note: 'Changed my mind' },
  });
  check(
    'a second verification decision is refused (409)',
    verifiedTwice.status === 409,
    verifiedTwice.body,
  );

  section('Staffing');
  const overAllocated = await api('POST', `/api/projects/${projectId}/assignments`, {
    jar,
    use: 'operator',
    body: { expertId, allocationHoursPerWeek: 55 },
  });
  check(
    'an allocation above declared availability is refused (409)',
    overAllocated.status === 409,
    overAllocated.body,
  );

  const proposal = await api('POST', `/api/projects/${projectId}/assignments`, {
    jar,
    use: 'operator',
    body: { expertId, allocationHoursPerWeek: 16 },
  });
  check('the seat is proposed', proposal.status === 201, proposal.body);
  const assignmentId: string = proposal.body.assignment.id;

  const confirmed = await api('POST', `/api/assignments/${assignmentId}/confirm`, {
    jar,
    use: 'operator',
  });
  check(
    'the operator confirms the seat and the project fills',
    confirmed.status === 200 && confirmed.body.seatsFilled === 1,
    confirmed.body,
  );

  const confirmedTwice = await api('POST', `/api/assignments/${assignmentId}/confirm`, {
    jar,
    use: 'operator',
  });
  check('confirming twice is refused (409)', confirmedTwice.status === 409, confirmedTwice.body);

  section('Expert withdrawal');
  const strangerProject = await api('POST', '/api/projects', {
    jar,
    use: 'operator',
    body: {
      title: `Smoke unrelated ${stamp}`,
      clientName: 'Northwind Logistics',
      seatsRequested: 1,
      requirements: [{ skillName: 'Payments Infrastructure', required: false }],
    },
  });
  const strangerProjectId: string = strangerProject.body.project.id;

  const wrongProject = await api('POST', '/api/portal/withdrawals', {
    jar: portalJar,
    use: 'portal',
    body: { projectId: strangerProjectId },
  });
  check(
    'withdrawing from a project the expert has no commitment on is refused (409)',
    wrongProject.status === 409,
    wrongProject.body,
  );

  const noSession = await api('POST', '/api/portal/withdrawals', {
    jar: {},
    body: { projectId },
  });
  check(
    'withdrawing without a portal session is refused (401)',
    noSession.status === 401,
    noSession.body,
  );

  const noCsrf = await api('POST', '/api/portal/withdrawals', {
    jar: portalJar,
    use: 'portal',
    body: { projectId },
    omitCsrf: true,
  });
  check('withdrawing without a CSRF token is refused (403)', noCsrf.status === 403, noCsrf.body);

  const withdrew = await api('POST', '/api/portal/withdrawals', {
    jar: portalJar,
    use: 'portal',
    // No reason: a withdrawal is valid without one.
    body: { projectId },
  });
  check(
    'the expert withdraws from their own project',
    withdrew.status === 200 && withdrew.body.withdrawal.alreadyWithdrawn === false,
    withdrew.body,
  );

  const withdrewAgain = await api('POST', '/api/portal/withdrawals', {
    jar: portalJar,
    use: 'portal',
    body: { projectId },
  });
  check(
    'a repeated withdrawal changes nothing and says so',
    withdrewAgain.status === 200 && withdrewAgain.body.withdrawal.alreadyWithdrawn === true,
    withdrewAgain.body,
  );

  const reopened = await api('GET', `/api/projects/${projectId}`, { jar, use: 'operator' });
  check(
    'the seat is released and the project is open for staffing again',
    reopened.body.project.seatsFilled === 0 && reopened.body.project.status === 'STAFFING',
    reopened.body?.project,
  );

  section('History and outbox');
  const activity = await api('GET', `/api/activity?projectId=${projectId}&limit=100`, {
    jar,
    use: 'operator',
  });
  const actions = (activity.body.events ?? []).map((event: any) => event.action);
  for (const expected of [
    'project.created',
    'matching.run',
    'invitation.created',
    'invitation.sent',
    'invitation.accepted',
    'assignment.proposed',
    'assignment.confirmed',
    'assignment.expert_withdrew',
  ]) {
    check(`the project history records ${expected}`, actions.includes(expected), actions);
  }

  // Onboarding is network-level rather than project-level, so those entries sit
  // on the expert timeline.
  const expertHistory = await api('GET', `/api/activity?expertId=${expertId}&limit=100`, {
    jar,
    use: 'operator',
  });
  const expertActions = (expertHistory.body.events ?? []).map((event: any) => event.action);
  for (const expected of [
    'expert.created',
    'onboarding.started',
    'onboarding.submitted',
    'onboarding.verified',
    'expert.status_changed',
  ]) {
    check(
      `the expert history records ${expected}`,
      expertActions.includes(expected),
      expertActions,
    );
  }

  const actors = new Set((activity.body.events ?? []).map((event: any) => event.actorType));
  check('the history distinguishes operator, expert and worker actions', actors.size >= 3, [
    ...actors,
  ]);

  const outbox = await api(`GET`, `/api/outbox?projectId=${projectId}`, { jar, use: 'operator' });
  check('the outbox is marked simulated', outbox.body.simulated === true);
  check(
    'every simulated message says it was not delivered',
    (outbox.body.messages ?? []).every((message: any) =>
      String(message.bodyText).includes('not delivered to any mail server'),
    ),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nWalkthrough aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
