'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/** Move a campaign through its lifecycle. Illegal moves are refused by the service. */
export function CampaignStatusControl({
  campaignId,
  status,
  canWrite,
}: {
  campaignId: string;
  status: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: Record<string, string[]> = {
    DRAFT: ['ACTIVE', 'CLOSED'],
    ACTIVE: ['PAUSED', 'CLOSED'],
    PAUSED: ['ACTIVE', 'CLOSED'],
    CLOSED: [],
  };

  if (!canWrite || options[status]?.length === 0) return null;

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-2">
        {(options[status] ?? []).map((next) => (
          <button
            key={next}
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={pending !== null}
            onClick={async () => {
              setPending(next);
              setError(null);
              try {
                const result = await apiPost(`/api/campaigns/${campaignId}`, {
                  action: 'set_status',
                  status: next,
                });
                if (!result.ok) {
                  setError(result.error?.message ?? 'The status could not be changed.');
                  return;
                }
                router.refresh();
              } finally {
                setPending(null);
              }
            }}
          >
            {pending === next ? 'Saving…' : `Move to ${next.toLowerCase()}`}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}

/** Open a sourcing campaign against a domain, optionally tied to a project. */
export function CreateCampaignForm({
  domains,
  projects,
  owners,
}: {
  domains: { id: string; name: string }[];
  projects: { id: string; label: string }[];
  owners: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [projectId, setProjectId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [targetCount, setTargetCount] = useState(3);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
          const result = await apiPost<{ campaign: { id: string } }>('/api/campaigns', {
            name,
            domainId,
            projectId: projectId || null,
            ownerId: ownerId || null,
            targetCount,
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The campaign could not be created.');
            return;
          }
          setName('');
          router.refresh();
          if (result.data?.campaign.id) router.push(`/campaigns/${result.data.campaign.id}`);
        } finally {
          setPending(false);
        }
      }}
    >
      <div>
        <label htmlFor="campaign-name" className="text-xs font-semibold text-ink-700">
          Campaign name
        </label>
        <input
          id="campaign-name"
          className="input mt-1 w-full"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div>
        <label htmlFor="campaign-domain" className="text-xs font-semibold text-ink-700">
          Domain
        </label>
        <select
          id="campaign-domain"
          className="input mt-1 w-full"
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
        <label htmlFor="campaign-project" className="text-xs font-semibold text-ink-700">
          Project it feeds
        </label>
        <select
          id="campaign-project"
          className="input mt-1 w-full"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">Not tied to a project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="campaign-owner" className="text-xs font-semibold text-ink-700">
          Owner
        </label>
        <select
          id="campaign-owner"
          className="input mt-1 w-full"
          value={ownerId}
          onChange={(event) => setOwnerId(event.target.value)}
        >
          <option value="">Me</option>
          {owners.map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="campaign-target" className="text-xs font-semibold text-ink-700">
          Qualified target
        </label>
        <input
          id="campaign-target"
          type="number"
          min={1}
          max={500}
          className="input mt-1 w-full"
          value={targetCount}
          onChange={(event) => setTargetCount(Number(event.target.value))}
        />
      </div>

      <div className="sm:col-span-2 lg:col-span-5">
        <button type="submit" className="btn btn-primary" disabled={pending || !domainId}>
          {pending ? 'Opening…' : 'Open campaign'}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 sm:col-span-2 lg:col-span-5"
        >
          {error}
        </p>
      )}
    </form>
  );
}
