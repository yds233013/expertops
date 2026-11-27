'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { apiFetch, apiPost } from '@/lib/api-client';
import { Alert } from '@/components/ui';

/**
 * Forms for managing access to client systems. The server validates every
 * field and its message is shown as is, so the rules live in one place.
 */

const PERMISSION_HELP: Record<string, string> = {
  pull: 'pull: read and clone',
  triage: 'triage: read, manage issues and pull requests',
  push: 'push: read and write',
  maintain: 'maintain: write and manage the repository, without admin',
};

export function AddAccessResourceForm({
  projectId,
  permissions,
}: {
  projectId: string;
  permissions: readonly string[];
}) {
  const router = useRouter();
  const id = useId();
  const [system, setSystem] = useState<'GITHUB' | 'SLACK'>('GITHUB');
  const [resource, setResource] = useState('');
  const [label, setLabel] = useState('');
  const [permission, setPermission] = useState(permissions.includes('push') ? 'push' : '');
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
        const result = await apiPost(`/api/projects/${projectId}/access`, {
          action: 'add',
          system,
          resource: resource.trim(),
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(system === 'GITHUB' && permission ? { permission } : {}),
        });
        setPending(false);
        if (!result.ok) {
          setError(result.error?.message ?? 'It could not be added.');
          return;
        }
        setResource('');
        setLabel('');
        setNotice(
          'Added. Everyone with a confirmed seat gets access on the next check, within a minute.',
        );
        router.refresh();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <div>
          <label className="label" htmlFor={`${id}-system`}>
            System
          </label>
          <select
            id={`${id}-system`}
            className="select"
            value={system}
            onChange={(event) => {
              setSystem(event.target.value === 'SLACK' ? 'SLACK' : 'GITHUB');
              setError(null);
            }}
          >
            <option value="GITHUB">GitHub repository</option>
            <option value="SLACK">Slack channel</option>
          </select>
        </div>
        <div className="min-w-0">
          <label className="label" htmlFor={`${id}-resource`}>
            {system === 'GITHUB' ? 'Repository' : 'Channel id'}
          </label>
          <input
            id={`${id}-resource`}
            className="input font-mono"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder={system === 'GITHUB' ? 'owner/name' : 'C08ABCDEF12'}
            value={resource}
            aria-describedby={`${id}-resource-hint`}
            onChange={(event) => setResource(event.target.value)}
          />
          <p id={`${id}-resource-hint`} className="field-hint">
            {system === 'GITHUB'
              ? 'As owner/name, or paste the github.com link.'
              : 'Starts with C. In Slack, open the channel name, then About; the id is at the bottom. Invite the bot to the channel first.'}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`${id}-label`}>
            Label <span className="font-normal text-ink-400">(optional)</span>
          </label>
          <input
            id={`${id}-label`}
            className="input"
            maxLength={120}
            placeholder={system === 'GITHUB' ? 'Task repository' : '#eval-wave-1'}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        {system === 'GITHUB' && (
          <div>
            <label className="label" htmlFor={`${id}-permission`}>
              Permission
            </label>
            <select
              id={`${id}-permission`}
              className="select"
              value={permission}
              onChange={(event) => setPermission(event.target.value)}
            >
              {permissions.map((value) => (
                <option key={value} value={value}>
                  {PERMISSION_HELP[value] ?? value}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
        {pending ? 'Adding…' : system === 'GITHUB' ? 'Add repository' : 'Add channel'}
      </button>
    </form>
  );
}

/**
 * Record that a failed revoke was done by hand. The note is the evidence, so
 * it is required and says what to write.
 */
export function ConfirmManualRevokeForm({
  projectId,
  grantId,
  who,
}: {
  projectId: string;
  grantId: string;
  /** "Lena Okafor on acme/repo", for the screen reader and the prompt. */
  who: string;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        Confirm removed by hand
      </button>
    );
  }

  return (
    <form
      aria-label={`Confirm access removed by hand for ${who}`}
      className="w-full max-w-sm space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 sm:w-80"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await apiPost(`/api/projects/${projectId}/access`, {
          action: 'confirm_manual_revoke',
          grantId,
          note: note.trim(),
        });
        setPending(false);
        if (!result.ok) {
          setError(result.error?.message ?? 'It could not be recorded.');
          return;
        }
        setOpen(false);
        setNote('');
        router.refresh();
      }}
    >
      <label className="label" htmlFor={`${id}-note`}>
        What did you do?
      </label>
      <textarea
        id={`${id}-note`}
        className="input min-h-16"
        required
        maxLength={500}
        placeholder="Removed them from the repository in GitHub settings, 14:20."
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <p className="text-xs text-amber-900">
        Only confirm once you have removed it yourself. The note is kept as the record.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={pending || note.trim().length === 0}
        >
          {pending ? 'Saving…' : 'Confirm removed'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The GitHub account access is granted to. Used by operators on an expert's
 * page and by the expert in their portal; only the URL differs.
 */
export function GithubUsernameForm({
  url,
  initial,
  hint,
}: {
  url: string;
  initial: string | null;
  hint: string;
}) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(initial ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const unchanged = value.trim().replace(/^@/, '') === (initial ?? '');

  return (
    <form
      className="space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        setNotice(null);
        const trimmed = value.trim();
        const result = await apiFetch<{ githubUsername: string | null }>(url, {
          method: 'PUT',
          body: { githubUsername: trimmed || null },
        });
        setPending(false);
        if (!result.ok) {
          setError(result.error?.message ?? 'The username could not be saved.');
          return;
        }
        setValue(result.data?.githubUsername ?? '');
        setNotice(result.data?.githubUsername ? 'Saved.' : 'Removed.');
        router.refresh();
      }}
    >
      <label className="label" htmlFor={`${id}-github`}>
        GitHub username
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={`${id}-github`}
          className="input min-w-0 flex-1 basis-40 font-mono"
          autoComplete="off"
          spellCheck={false}
          maxLength={60}
          placeholder="username"
          value={value}
          aria-describedby={`${id}-github-hint`}
          onChange={(event) => {
            setValue(event.target.value);
            setNotice(null);
          }}
        />
        <button
          type="submit"
          className="btn btn-secondary btn-sm self-center"
          disabled={pending || unchanged}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p id={`${id}-github-hint`} className="field-hint">
        {hint}
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
    </form>
  );
}
