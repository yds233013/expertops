import { EnterApplication } from './enter-application';

export const dynamic = 'force-dynamic';

/**
 * Screening magic-link landing page.
 *
 * The token is exchanged for a session by a client-side POST, for two reasons:
 * the cookie is set on a real response, and the single-use token is not burned
 * by a link preview or a router prefetch. The page never logs or displays the
 * token, and replaces the URL as soon as the exchange succeeds.
 */
export default async function ApplyEnterPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <EnterApplication token={token} />;
}
