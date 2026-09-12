import { FragmentEntry } from '@/components/fragment-entry';

export const dynamic = 'force-dynamic';

/**
 * Screening magic-link landing.
 *
 * The path carries no token: it arrives in the fragment, which browsers do not
 * transmit. This page therefore appears in a request log as `/apply/enter` and
 * nothing more.
 */
export default function ApplyEnterPage() {
  return <FragmentEntry endpoint="/api/apply/session" destination="/apply" audience="screening" />;
}
