/**
 * Human-facing reference identifiers.
 *
 * Sequence numbers come from a MAX(...) read inside the same transaction that
 * inserts the row, so the counter never drifts from reality the way a separate
 * counter table can.
 */
export function formatReference(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, '0')}`;
}

export function parseReferenceSequence(
  prefix: string,
  reference: string | null | undefined,
): number {
  if (!reference) return 0;
  const expected = `${prefix}-`;
  if (!reference.startsWith(expected)) return 0;
  const parsed = Number.parseInt(reference.slice(expected.length), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const EXPERT_REFERENCE_PREFIX = 'EXP';
export const PROJECT_REFERENCE_PREFIX = 'PRJ';

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
