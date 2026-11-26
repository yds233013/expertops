/**
 * Stripe's `requirements.currently_due` keys, in words an expert or an
 * operator can act on.
 *
 * Stripe reports one key per missing field ("individual.dob.day",
 * "individual.dob.month", ...). Those collapse into one line per thing to do;
 * a key this list does not know is shown as Stripe wrote it rather than
 * guessed at.
 */
const PREFIXES: Array<[prefix: string, label: string]> = [
  ['external_account', 'Bank account'],
  ['individual.', 'Identity details'],
  ['representative.', 'Identity details'],
  ['tos_acceptance', 'Accept Stripe’s terms'],
  ['business_profile.', 'Business details'],
];

export function describeRequirement(key: string): string {
  for (const [prefix, label] of PREFIXES) {
    if (key === prefix || key.startsWith(prefix)) return label;
  }
  return key;
}

/** Read the JSON column defensively and return one plain line per thing missing. */
export function payoutRequirements(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = value.filter((entry): entry is string => typeof entry === 'string');
  return [...new Set(keys.map(describeRequirement))];
}

export type PayoutState = 'not_set_up' | 'incomplete' | 'ready';

export function payoutState(expert: {
  stripeAccountId: string | null;
  payoutsEnabled: boolean;
}): PayoutState {
  if (!expert.stripeAccountId) return 'not_set_up';
  return expert.payoutsEnabled ? 'ready' : 'incomplete';
}
