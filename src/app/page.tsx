import { redirect } from 'next/navigation';
import { currentOperator } from '@/server/http/context';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const operator = await currentOperator();
  redirect(operator ? '/dashboard' : '/login');
}
