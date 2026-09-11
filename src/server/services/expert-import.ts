import { type Db } from '@/lib/db';
import { badRequest } from '@/lib/errors';
import { parseCsv, toCsv } from '@/lib/csv';
import { isKnownTimezone } from '@/lib/timezone';
import { type Actor, recordActivity } from './activity';
import { createExpert, listExperts, type SkillInput } from './experts';
import { normaliseEmail } from './candidates';

/**
 * Expert CSV import and export.
 *
 * Two rules shape the import:
 *
 *  * **Preview before commit.** Validation runs against the whole file and
 *    returns a row-by-row verdict. Nothing is written until the operator sends
 *    the file back with `commit: true`.
 *  * **Qualifications are never imported as decisions.** A CSV can carry a
 *    qualification hint, but it lands as a note for a human to act on. A
 *    spreadsheet cannot make someone qualified, because a qualification is a
 *    record that a named person decided something.
 */
export const IMPORT_COLUMNS = [
  'full_name',
  'email',
  'headline',
  'years_experience',
  'hourly_rate',
  'currency',
  'timezone',
  'weekly_capacity_hours',
  'skills',
  'notes',
] as const;

export const OPTIONAL_COLUMNS = ['qualification_hint'] as const;

export type RowVerdict = 'create' | 'duplicate' | 'error';

export interface PreviewRow {
  line: number;
  verdict: RowVerdict;
  fullName: string;
  email: string;
  errors: string[];
  warnings: string[];
  /** Present when the row matches somebody already in the system. */
  duplicateOf?: { kind: 'expert' | 'candidate'; id: string; reference: string };
  parsed?: {
    fullName: string;
    email: string;
    headline: string;
    yearsExperience: number;
    hourlyRateCents: number;
    currency: string;
    timezone: string;
    weeklyCapacityHours: number;
    skills: SkillInput[];
    notes: string;
    qualificationHint: string | null;
  };
}

export interface ImportPreview {
  totalRows: number;
  creatable: number;
  duplicates: number;
  errors: number;
  missingColumns: string[];
  unknownColumns: string[];
  malformedLines: Array<{ line: number; raw: string; reason: string }>;
  rows: PreviewRow[];
  /** Qualification hints seen in the file, listed so nobody expects them applied. */
  qualificationHintsIgnored: number;
}

function parseIntField(
  value: string,
  field: string,
  bounds: { min: number; max: number },
  errors: string[],
): number {
  if (value === '') return bounds.min;
  if (!/^\d+$/.test(value)) {
    errors.push(`${field} must be a whole number (got "${value}").`);
    return bounds.min;
  }
  const parsed = Number(value);
  if (parsed < bounds.min || parsed > bounds.max) {
    errors.push(`${field} must be between ${bounds.min} and ${bounds.max} (got ${parsed}).`);
    return bounds.min;
  }
  return parsed;
}

function parseMoneyField(value: string, errors: string[]): number {
  if (value === '') return 0;
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    errors.push(`hourly_rate must be a plain number such as 250 or 250.00 (got "${value}").`);
    return 0;
  }
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

function parseSkills(value: string, errors: string[]): SkillInput[] {
  if (!value.trim()) return [];
  const skills: SkillInput[] = [];
  const seen = new Set<string>();

  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Accepted forms: "Name" or "Name:4" (proficiency 1-5).
    const [rawName = '', rawProficiency] = trimmed.split(':');
    const name = rawName.trim();
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) {
      errors.push(`skill "${name}" is listed twice.`);
      continue;
    }
    seen.add(key);

    let proficiency = 3;
    if (rawProficiency !== undefined && rawProficiency.trim() !== '') {
      const parsed = Number(rawProficiency.trim());
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
        errors.push(`proficiency for "${name}" must be 1-5 (got "${rawProficiency.trim()}").`);
        continue;
      }
      proficiency = parsed;
    }
    skills.push({ name, proficiency });
  }
  return skills;
}

/**
 * Validate a CSV without writing anything.
 *
 * Every row gets a verdict and its own error list, so an operator can fix a
 * file rather than being told "import failed".
 */
export async function previewExpertImport(db: Db, csvText: string): Promise<ImportPreview> {
  const parsed = parseCsv(csvText);

  if (parsed.headers.length === 0) {
    throw badRequest('The file is empty or has no header row.');
  }

  const headerSet = new Set(parsed.headers.map((header) => header.toLowerCase()));
  const missingColumns = IMPORT_COLUMNS.filter(
    (column) => !headerSet.has(column) && ['full_name', 'email'].includes(column),
  );
  const knownColumns = new Set<string>([...IMPORT_COLUMNS, ...OPTIONAL_COLUMNS]);
  const unknownColumns = parsed.headers.filter((header) => !knownColumns.has(header.toLowerCase()));

  const rows: PreviewRow[] = [];
  const emailsInFile = new Map<string, number>();
  let qualificationHintsIgnored = 0;

  for (const [index, record] of parsed.rows.entries()) {
    const line = index + 2; // header is line 1
    const errors: string[] = [];
    const warnings: string[] = [];

    const get = (column: string) => (record[column] ?? record[column.toUpperCase()] ?? '').trim();

    const fullName = get('full_name');
    const rawEmail = get('email');
    const email = rawEmail ? normaliseEmail(rawEmail) : '';

    if (!fullName) errors.push('full_name is required.');
    if (!email) errors.push('email is required.');
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push(`"${rawEmail}" is not a valid email address.`);
    }

    const yearsExperience = parseIntField(
      get('years_experience'),
      'years_experience',
      { min: 0, max: 60 },
      errors,
    );
    const hourlyRateCents = parseMoneyField(get('hourly_rate'), errors);
    const weeklyCapacityHours = parseIntField(
      get('weekly_capacity_hours'),
      'weekly_capacity_hours',
      { min: 0, max: 60 },
      errors,
    );

    const currency = (get('currency') || 'USD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency))
      errors.push(`currency must be a 3-letter code (got "${currency}").`);

    const timezone = get('timezone') || 'UTC';
    if (!isKnownTimezone(timezone)) {
      errors.push(`"${timezone}" is not a recognised IANA timezone.`);
    }

    const skills = parseSkills(get('skills'), errors);
    if (skills.length === 0)
      warnings.push('No skills listed; this expert will not match any project.');

    const qualificationHint = get('qualification_hint') || null;
    if (qualificationHint) {
      qualificationHintsIgnored += 1;
      warnings.push(
        'qualification_hint is recorded as a note only. A qualification requires a human review decision and cannot be imported.',
      );
    }

    // Duplicate within the file itself.
    if (email) {
      const firstSeen = emailsInFile.get(email);
      if (firstSeen !== undefined) {
        errors.push(`email duplicates line ${firstSeen} of this file.`);
      } else {
        emailsInFile.set(email, line);
      }
    }

    let duplicateOf: PreviewRow['duplicateOf'];
    if (email && errors.length === 0) {
      const existingExpert = await db.expert.findUnique({ where: { email } });
      if (existingExpert) {
        duplicateOf = {
          kind: 'expert',
          id: existingExpert.id,
          reference: existingExpert.reference,
        };
      } else {
        const existingCandidate = await db.candidate.findFirst({ where: { email } });
        if (existingCandidate) {
          duplicateOf = {
            kind: 'candidate',
            id: existingCandidate.id,
            reference: existingCandidate.reference,
          };
        }
      }
    }

    const verdict: RowVerdict = errors.length > 0 ? 'error' : duplicateOf ? 'duplicate' : 'create';

    rows.push({
      line,
      verdict,
      fullName,
      email,
      errors,
      warnings,
      duplicateOf,
      parsed:
        verdict === 'error'
          ? undefined
          : {
              fullName,
              email,
              headline: get('headline') || 'Imported expert',
              yearsExperience,
              hourlyRateCents,
              currency,
              timezone,
              weeklyCapacityHours,
              skills,
              notes: [
                get('notes'),
                qualificationHint ? `Qualification hint from import: ${qualificationHint}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
              qualificationHint,
            },
    });
  }

  return {
    totalRows: parsed.rows.length,
    creatable: rows.filter((row) => row.verdict === 'create').length,
    duplicates: rows.filter((row) => row.verdict === 'duplicate').length,
    errors: rows.filter((row) => row.verdict === 'error').length,
    missingColumns,
    unknownColumns,
    malformedLines: parsed.malformed,
    rows,
    qualificationHintsIgnored,
  };
}

export interface ImportResult {
  preview: ImportPreview;
  created: number;
  skipped: number;
  failed: Array<{ line: number; email: string; reason: string }>;
  createdExpertIds: string[];
}

/**
 * Commit an import.
 *
 * Only rows the preview marked `create` are written. Duplicates and errors are
 * skipped and reported; the operator resolves them by hand, because deciding
 * that two records are the same person is not something a file should do.
 */
export async function commitExpertImport(
  db: Db,
  actor: Actor,
  csvText: string,
): Promise<ImportResult> {
  const preview = await previewExpertImport(db, csvText);

  const failed: ImportResult['failed'] = [];
  const createdExpertIds: string[] = [];

  for (const row of preview.rows) {
    if (row.verdict !== 'create' || !row.parsed) continue;
    try {
      const expert = await createExpert(db, actor, {
        fullName: row.parsed.fullName,
        email: row.parsed.email,
        headline: row.parsed.headline,
        yearsExperience: row.parsed.yearsExperience,
        hourlyRateCents: row.parsed.hourlyRateCents,
        currency: row.parsed.currency,
        timezone: row.parsed.timezone,
        weeklyCapacityHours: row.parsed.weeklyCapacityHours,
        notes: row.parsed.notes,
        skills: row.parsed.skills,
      });
      createdExpertIds.push(expert.id);
    } catch (error) {
      failed.push({
        line: row.line,
        email: row.email,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await recordActivity(db, {
    actor,
    entityType: 'import',
    entityId: `expert-import-${Date.now()}`,
    action: 'import.experts_committed',
    summary: `${actor.label} imported ${createdExpertIds.length} expert(s) from CSV`,
    metadata: {
      totalRows: preview.totalRows,
      created: createdExpertIds.length,
      duplicatesSkipped: preview.duplicates,
      errorsSkipped: preview.errors,
      failed: failed.length,
      // Recorded so the audit trail shows hints were not treated as decisions.
      qualificationHintsIgnored: preview.qualificationHintsIgnored,
    },
  });

  return {
    preview,
    created: createdExpertIds.length,
    skipped: preview.duplicates + preview.errors,
    failed,
    createdExpertIds,
  };
}

/**
 * Export the expert list as CSV.
 *
 * Every cell is passed through the formula-injection guard, so a headline of
 * `=HYPERLINK(...)` is exported as inert text.
 */
export async function exportExpertsCsv(db: Db, options: { limit?: number } = {}): Promise<string> {
  const { experts } = await listExperts(db, { limit: options.limit ?? 100 });

  const withQualifications = await Promise.all(
    experts.map(async (expert) => ({
      expert,
      qualifications: await db.qualification.findMany({
        where: { expertId: expert.id, status: 'ACTIVE' },
        include: { domain: true, rubricVersion: true },
      }),
    })),
  );

  return toCsv(
    [
      'reference',
      'full_name',
      'email',
      'headline',
      'status',
      'years_experience',
      'hourly_rate',
      'currency',
      'timezone',
      'weekly_capacity_hours',
      'skills',
      'active_qualifications',
      'notes',
    ],
    withQualifications.map(({ expert, qualifications }) => [
      expert.reference,
      expert.fullName,
      expert.email,
      expert.headline,
      expert.status,
      expert.yearsExperience,
      (expert.hourlyRateCents / 100).toFixed(2),
      expert.currency,
      expert.timezone,
      expert.weeklyCapacityHours,
      expert.skills.map((link) => `${link.skill.name}:${link.proficiency}`).join('; '),
      qualifications.map((q) => `${q.domain.name} v${q.rubricVersion.version}`).join('; '),
      expert.notes,
    ]),
  );
}

/** A blank template with the expected headers, for an operator to fill in. */
export function exportImportTemplate(): string {
  return toCsv(
    [...IMPORT_COLUMNS, ...OPTIONAL_COLUMNS],
    [
      [
        'Avery Lindqvist',
        'avery.lindqvist@example.test',
        'Principal Consultant — incident response',
        '12',
        '250.00',
        'USD',
        'Europe/London',
        '20',
        'Incident Response:5; Threat Intelligence:4',
        'Referred by a community contact.',
        'Suggested for cybersecurity screening',
      ],
    ],
  );
}
