'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type ContactPreference } from '@prisma/client';
import { apiPost } from '@/lib/api-client';
import { Alert } from '@/components/ui';

/**
 * How an expert says they want to be contacted.
 *
 * Theirs to set, not the operator's to assume. "Not asked yet" appears when
 * that is the truth and cannot be chosen: the way out of it is to say
 * something, not to go back to silence.
 */
const OPTIONS: { value: ContactPreference; label: string; help: string }[] = [
  {
    value: 'EMAIL_ALL',
    label: 'Email me about everything',
    help: 'Invitations, decisions, and reminders when something is waiting on you.',
  },
  {
    value: 'EMAIL_ESSENTIAL',
    label: 'Only what I need to act on',
    help: 'Invitations, decisions and seat changes. No reminders or nudges.',
  },
  {
    value: 'NO_CONTACT',
    label: 'Do not contact me',
    help: 'No messages at all. You will also stop being considered for new projects, because there would be no way to tell you about one.',
  },
];

export function ContactPreferencePanel({
  current,
  setAt,
}: {
  current: ContactPreference;
  setAt: Date | null;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<ContactPreference>(
    current === 'UNKNOWN' ? 'EMAIL_ALL' : current,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        setNotice(null);
        try {
          const result = await apiPost('/api/portal/contact-preference', { preference: choice });
          if (!result.ok) {
            setError(result.error?.message ?? 'That could not be saved.');
            return;
          }
          setNotice('Saved. It applies to the next message we would have sent.');
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      {current === 'UNKNOWN' ? (
        <Alert tone="warning">
          Nobody has asked you this yet. Until you answer, we send you things you have to act on and
          nothing else — no reminders.
        </Alert>
      ) : (
        <p className="text-xs text-ink-500">
          {setAt
            ? `You set this on ${new Date(setAt).toISOString().slice(0, 10)}.`
            : 'Set for you by the ExpertOps team.'}
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="sr-only">Contact preference</legend>
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex gap-2 rounded-lg border border-ink-200 px-3 py-2"
            htmlFor={`contact-${option.value}`}
          >
            <input
              id={`contact-${option.value}`}
              type="radio"
              name="contactPreference"
              className="mt-1"
              value={option.value}
              checked={choice === option.value}
              onChange={() => setChoice(option.value)}
            />
            <span>
              <span className="block text-sm font-medium text-ink-900">{option.label}</span>
              <span className="block text-xs text-ink-600">{option.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Saving…' : 'Save preference'}
      </button>
    </form>
  );
}
