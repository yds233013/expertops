import { redirect } from 'next/navigation';
import { currentOperator } from '@/server/http/context';

export const dynamic = 'force-dynamic';

/**
 * The front door.
 *
 * A signed-in operator goes straight to their dashboard. Everybody else lands
 * on the public, read-only demo, which links onward to the applicant listing
 * and to operator sign-in. Every operator route still checks its own session;
 * this only decides where an anonymous visitor starts.
 */
export default async function Home() {
  const operator = await currentOperator();
  redirect(operator ? '/dashboard' : '/demo');
}
