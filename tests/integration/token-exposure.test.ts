import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { makeCandidate, makeExpert } from '../helpers/factories';
import {
  buildCandidatePortalUrl,
  issueCandidatePortalToken,
} from '@/server/services/candidate-portal';
import { buildPortalUrl, issuePortalToken } from '@/server/services/portal-access';

/**
 * Magic-link tokens must not appear in an HTTP request.
 *
 * The defect this guards: the landing URL used to be `/apply/enter/<token>`, so
 * the very first GET wrote the secret verbatim into the server's request log.
 * Nothing done afterwards — a POST exchange, `router.replace`, a redirect —
 * removes a line that is already written.
 *
 * A URL fragment is never transmitted, so putting the token there is what makes
 * the request safe. These tests assert the property at its source: the shape of
 * the link the application generates.
 */
const DISTINCTIVE = 'ZZ-REGRESSION-TOKEN-7f4b91c8e2d5a63f';

/** Everything a server or proxy can observe from a URL. */
function transmittedParts(rawUrl: string) {
  const url = new URL(rawUrl);
  return {
    // What lands in a request line and therefore in an access log.
    requestTarget: url.pathname + url.search,
    // What a browser puts in `Referer` (fragments are stripped by every engine).
    referer: url.origin + url.pathname + url.search,
    fragment: url.hash,
  };
}

describe('magic-link tokens stay out of the request', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('keeps a candidate token in the fragment, not the path or query', () => {
    const url = buildCandidatePortalUrl(DISTINCTIVE);
    const parts = transmittedParts(url);

    expect(parts.requestTarget).toBe('/apply/enter');
    expect(parts.requestTarget).not.toContain(DISTINCTIVE);
    expect(parts.referer).not.toContain(DISTINCTIVE);
    expect(parts.fragment).toBe(`#t=${DISTINCTIVE}`);
  });

  it('keeps an expert token in the fragment, not the path or query', () => {
    const url = buildPortalUrl(DISTINCTIVE);
    const parts = transmittedParts(url);

    expect(parts.requestTarget).toBe('/portal/enter');
    expect(parts.requestTarget).not.toContain(DISTINCTIVE);
    expect(parts.referer).not.toContain(DISTINCTIVE);
    expect(parts.fragment).toBe(`#t=${DISTINCTIVE}`);
  });

  it('percent-encodes a token so it cannot break out of the fragment', () => {
    // A token containing '?' or '#' must not be able to turn part of itself
    // into a query string, which would then be transmitted.
    const awkward = 'abc?x=1#y';
    const parts = transmittedParts(buildCandidatePortalUrl(awkward));
    expect(parts.requestTarget).toBe('/apply/enter');
    expect(parts.referer).not.toContain('x=1');
  });

  it('issues real links in the fragment form, for both audiences', async () => {
    const candidate = await makeCandidate();
    const expert = await makeExpert();

    const candidateLink = await issueCandidatePortalToken(prisma, { candidateId: candidate.id });
    const expertLink = await issuePortalToken(prisma, {
      expertId: expert.id,
      purpose: 'INVITATION',
    });

    for (const issued of [candidateLink, expertLink]) {
      const parts = transmittedParts(issued.url);
      expect(parts.requestTarget).not.toContain(issued.token);
      expect(parts.referer).not.toContain(issued.token);
      expect(parts.fragment).toContain(encodeURIComponent(issued.token));
    }
  });

  it('never writes a token into the simulated email as a path', async () => {
    const candidate = await makeCandidate();
    const issued = await issueCandidatePortalToken(prisma, { candidateId: candidate.id });

    // The body does contain the link — that is the point of the email — but the
    // transmitted part of that link must still be token free.
    const link = issued.url;
    expect(link.split('#')[0]).not.toContain(issued.token);

    const stored = await prisma.candidatePortalToken.findFirstOrThrow({
      where: { candidateId: candidate.id },
    });
    // The token is stored only as a hash; the dev plaintext copy is a
    // development convenience gated by EXPOSE_PORTAL_LINKS_IN_UI.
    expect(stored.tokenHash).not.toBe(issued.token);
    expect(stored.tokenHash).toHaveLength(64);
  });
});
