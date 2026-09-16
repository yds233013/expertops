'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost } from '@/lib/api-client';

/**
 * Add a candidate by hand.
 *
 * Duplicate detection runs in the service, and a possible duplicate puts the
 * person on hold rather than rejecting them. That outcome is reported here in
 * those words, because "held for review" and "rejected" are different things.
 */
export function CandidateForm({
  channels,
  campaigns,
  owners,
}: {
  channels: { id: string; name: string }[];
  campaigns: { id: string; label: string }[];
  owners: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [headline, setHeadline] = useState('');
  const [yearsExperience, setYearsExperience] = useState(5);
  const [sourceChannelId, setSourceChannelId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [relationshipOwnerId, setRelationshipOwnerId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        setNotice(null);
        try {
          const result = await apiPost<{
            candidate: { id: string; fullName: string; stage: string };
            onHoldForDuplicateReview: boolean;
          }>('/api/candidates', {
            fullName,
            email,
            headline: headline || undefined,
            yearsExperience,
            sourceChannelId: sourceChannelId || null,
            campaignId: campaignId || null,
            relationshipOwnerId: relationshipOwnerId || null,
          });
          if (!result.ok) {
            setError(result.error?.message ?? 'The candidate could not be added.');
            return;
          }
          setNotice(
            result.data?.onHoldForDuplicateReview
              ? `${result.data.candidate.fullName} looks like someone already on file, so they are on hold for a duplicate decision. Nothing was merged.`
              : `${result.data?.candidate.fullName} added.`,
          );
          setFullName('');
          setEmail('');
          setHeadline('');
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset className="fieldset">
        <legend className="legend">The person</legend>
        <p className="legend-hint">
          Name and address are checked against everyone on file before anything is saved.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="candidate-name" className="label">
              Full name
            </label>
            <input
              id="candidate-name"
              className="input"
              required
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="candidate-email" className="label">
              Email
            </label>
            <input
              id="candidate-email"
              type="email"
              className="input"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="candidate-headline" className="label">
              Headline
            </label>
            <input
              id="candidate-headline"
              className="input"
              value={headline}
              onChange={(event) => setHeadline(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="candidate-years" className="label">
              Years of experience
            </label>
            <input
              id="candidate-years"
              type="number"
              min={0}
              max={60}
              className="input"
              value={yearsExperience}
              onChange={(event) => setYearsExperience(Number(event.target.value))}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend className="legend">Where they came from</legend>
        <p className="legend-hint">
          Recorded so source effectiveness is measured on who qualifies, not on volume.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="candidate-channel" className="label">
              Source
            </label>
            <select
              id="candidate-channel"
              className="select"
              value={sourceChannelId}
              onChange={(event) => setSourceChannelId(event.target.value)}
            >
              <option value="">Not recorded</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="candidate-campaign" className="label">
              Campaign
            </label>
            <select
              id="candidate-campaign"
              className="select"
              value={campaignId}
              onChange={(event) => setCampaignId(event.target.value)}
            >
              <option value="">No campaign</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="candidate-owner" className="label">
              Relationship owner
            </label>
            <select
              id="candidate-owner"
              className="select"
              value={relationshipOwnerId}
              onChange={(event) => setRelationshipOwnerId(event.target.value)}
            >
              <option value="">Me</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="alert alert-success">
          {notice}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Adding…' : 'Add candidate'}
      </button>
    </form>
  );
}
