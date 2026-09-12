import { FragmentEntry } from '@/components/fragment-entry';

export const dynamic = 'force-dynamic';

/** Expert portal magic-link landing. See `/apply/enter` for why the token is in
 * the fragment rather than the path. */
export default function PortalEnterPage() {
  return <FragmentEntry endpoint="/api/portal/session" destination="/portal" audience="portal" />;
}
