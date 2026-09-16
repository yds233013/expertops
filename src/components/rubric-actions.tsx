'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/** Create a screening template. */
export function CreateTemplateForm({ domains }: { domains: { id: string; name: string }[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid gap-3 sm:grid-cols-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
          const result = await apiPost('/api/rubrics', {
            action: 'create_template',
            name,
            domainId,
            description,
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The template could not be created.');
            return;
          }
          setName('');
          setDescription('');
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <div>
        <label htmlFor="template-name" className="label">
          Template name
        </label>
        <input
          id="template-name"
          className="input"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <label htmlFor="template-domain" className="label">
          Domain
        </label>
        <select
          id="template-domain"
          className="select"
          value={domainId}
          onChange={(event) => setDomainId(event.target.value)}
        >
          {domains.map((domain) => (
            <option key={domain.id} value={domain.id}>
              {domain.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="template-description" className="label">
          Description
        </label>
        <input
          id="template-description"
          className="input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="flex items-end">
        <button type="submit" className="btn btn-primary w-full" disabled={pending || !domainId}>
          {pending ? 'Creating…' : 'Create template'}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="sm:col-span-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Start a new draft version of a template.
 *
 * The new draft copies the latest version's criteria, which is what makes
 * "raise the bar slightly" a small edit rather than a re-typing exercise.
 */
export function NewDraftButton({
  templateId,
  nextVersion,
  isFirstVersion,
}: {
  templateId: string;
  nextVersion: number;
  /** A template with no versions has nothing to copy, so start one criterion. */
  isFirstVersion: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const result = await apiPost('/api/rubrics', {
              action: 'draft_version',
              templateId,
              // A rubric must have at least one criterion. Later versions copy
              // the previous one; the first gets a placeholder to edit.
              ...(isFirstVersion
                ? { criteria: [{ key: 'criterion-1', label: 'Criterion 1' }] }
                : {}),
            });
            if (!result.ok) {
              setError(result.error?.message ?? 'A new draft could not be started.');
              return;
            }
            router.refresh();
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Starting…' : `Start draft v${nextVersion}`}
      </button>
      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}
