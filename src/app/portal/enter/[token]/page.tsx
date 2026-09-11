import { EnterPortal } from './enter-portal';

export const dynamic = 'force-dynamic';

/**
 * Magic-link landing page.
 *
 * The token is exchanged for a session by a client-side POST so the cookie is
 * set on a real response and the single-use token is not burned by a link
 * preview or a prefetch.
 */
export default async function PortalEnterPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <EnterPortal token={token} />;
}
