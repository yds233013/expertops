import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeCandidate, makeExpert, makeOperator } from '../helpers/factories';
import {
  commitExpertImport,
  exportExpertsCsv,
  exportImportTemplate,
  previewExpertImport,
} from '@/server/services/expert-import';
import { parseCsv } from '@/lib/csv';

const HEADER =
  'full_name,email,headline,years_experience,hourly_rate,currency,timezone,weekly_capacity_hours,skills,notes';

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

describe('expert CSV import: preview before commit', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('validates a whole file without writing anything', async () => {
    const preview = await previewExpertImport(
      prisma,
      csv(
        'Avery Lindqvist,avery@example.test,Consultant,12,250.00,USD,Europe/London,20,Incident Response:5,Referred',
        'Rowan Barros,rowan@example.test,Advisor,8,180,USD,UTC,15,Threat Intel:4,',
      ),
    );

    expect(preview.totalRows).toBe(2);
    expect(preview.creatable).toBe(2);
    expect(preview.errors).toBe(0);
    // Nothing was written.
    expect(await prisma.expert.count()).toBe(0);
  });

  it('reports a per-row reason for every invalid field', async () => {
    const preview = await previewExpertImport(
      prisma,
      csv(
        ',missing.name@example.test,Consultant,12,250,USD,UTC,20,Skill:3,',
        'No Email,,Consultant,12,250,USD,UTC,20,Skill:3,',
        'Bad Email,not-an-email,Consultant,12,250,USD,UTC,20,Skill:3,',
        'Bad Years,years@example.test,Consultant,abc,250,USD,UTC,20,Skill:3,',
        'Bad Rate,rate@example.test,Consultant,12,two-fifty,USD,UTC,20,Skill:3,',
        'Bad Zone,zone@example.test,Consultant,12,250,USD,Mars/Olympus,20,Skill:3,',
        'Bad Prof,prof@example.test,Consultant,12,250,USD,UTC,20,Skill:9,',
      ),
    );

    expect(preview.errors).toBe(7);
    const messages = preview.rows.flatMap((row) => row.errors).join(' | ');
    expect(messages).toContain('full_name is required');
    expect(messages).toContain('email is required');
    expect(messages).toContain('is not a valid email address');
    expect(messages).toContain('years_experience must be a whole number');
    expect(messages).toContain('hourly_rate must be a plain number');
    expect(messages).toContain('not a recognised IANA timezone');
    expect(messages).toContain('proficiency for "Skill" must be 1-5');

    // Each bad row carries its own line number.
    expect(preview.rows.map((row) => row.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('detects a duplicate of an existing expert and of an existing candidate', async () => {
    await makeExpert({ email: 'known.expert@example.test' });
    await makeCandidate({ email: 'known.candidate@example.test' });

    const preview = await previewExpertImport(
      prisma,
      csv(
        'Known Expert,known.expert@example.test,Consultant,12,250,USD,UTC,20,Skill:3,',
        'Known Candidate,known.candidate@example.test,Consultant,12,250,USD,UTC,20,Skill:3,',
        'Brand New,new@example.test,Consultant,12,250,USD,UTC,20,Skill:3,',
      ),
    );

    expect(preview.duplicates).toBe(2);
    expect(preview.creatable).toBe(1);
    expect(preview.rows[0]!.duplicateOf?.kind).toBe('expert');
    expect(preview.rows[1]!.duplicateOf?.kind).toBe('candidate');
    expect(preview.rows[2]!.verdict).toBe('create');
  });

  it('detects a duplicate within the file itself', async () => {
    const preview = await previewExpertImport(
      prisma,
      csv(
        'First Copy,same@example.test,Consultant,12,250,USD,UTC,20,Skill:3,',
        'Second Copy,same@example.test,Consultant,12,250,USD,UTC,20,Skill:3,',
      ),
    );
    expect(preview.rows[1]!.errors.join(' ')).toContain('duplicates line 2');
  });

  it('reports malformed lines rather than silently dropping them', async () => {
    const preview = await previewExpertImport(
      prisma,
      `${HEADER}\nToo,Few,Columns\nGood Row,good@example.test,Consultant,12,250,USD,UTC,20,Skill:3,\n`,
    );
    expect(preview.malformedLines).toHaveLength(1);
    expect(preview.malformedLines[0]!.reason).toContain('Expected 10 columns');
    expect(preview.creatable).toBe(1);
  });

  it('lists unknown columns without failing the import', async () => {
    const preview = await previewExpertImport(
      prisma,
      `${HEADER},salary_expectation\nAvery,avery@example.test,Consultant,12,250,USD,UTC,20,Skill:3,,100000\n`,
    );
    expect(preview.unknownColumns).toContain('salary_expectation');
    expect(preview.creatable).toBe(1);
  });

  it('refuses an empty file', async () => {
    await expect(previewExpertImport(prisma, '')).rejects.toThrow(/no header row/);
  });
});

describe('expert CSV import: qualifications are never imported as decisions', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('records a qualification hint as a note and warns about it', async () => {
    const operator = await makeOperator();
    const source = `${HEADER},qualification_hint\nAvery Lindqvist,avery@example.test,Consultant,12,250,USD,UTC,20,Incident Response:5,,Cybersecurity expert - already vetted\n`;

    const preview = await previewExpertImport(prisma, source);
    expect(preview.qualificationHintsIgnored).toBe(1);
    expect(preview.rows[0]!.warnings.join(' ')).toContain('recorded as a note only');

    const result = await commitExpertImport(prisma, actorFor(operator), source);
    expect(result.created).toBe(1);

    // No qualification row exists. Not one.
    expect(await prisma.qualification.count()).toBe(0);

    // The hint survives as a note for a human to act on.
    const expert = await prisma.expert.findFirstOrThrow({ where: { email: 'avery@example.test' } });
    expect(expert.notes).toContain('Qualification hint from import');
    expect(expert.notes).toContain('already vetted');

    // And the audit trail says the hint was not applied.
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { action: 'import.experts_committed' },
    });
    expect((event.metadata as Record<string, unknown>).qualificationHintsIgnored).toBe(1);
  });

  it('never marks an imported expert as verified', async () => {
    const operator = await makeOperator();
    await commitExpertImport(
      prisma,
      actorFor(operator),
      csv('Avery Lindqvist,avery@example.test,Consultant,12,250,USD,UTC,20,Skill:4,'),
    );

    const expert = await prisma.expert.findFirstOrThrow({ where: { email: 'avery@example.test' } });
    expect(expert.status).toBe('PROSPECT');
  });
});

describe('expert CSV import: commit', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('creates only the valid rows and skips duplicates and errors', async () => {
    const operator = await makeOperator();
    await makeExpert({ email: 'existing@example.test' });

    const result = await commitExpertImport(
      prisma,
      actorFor(operator),
      csv(
        'Good One,good1@example.test,Consultant,12,250,USD,UTC,20,Incident Response:5,',
        'Good Two,good2@example.test,Advisor,8,180,USD,Europe/London,15,Threat Intel:4,',
        'Duplicate,existing@example.test,Consultant,12,250,USD,UTC,20,Skill:3,',
        'Broken,,Consultant,12,250,USD,UTC,20,Skill:3,',
      ),
    );

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.failed).toEqual([]);

    // Two new plus the one that already existed.
    expect(await prisma.expert.count()).toBe(3);

    const created = await prisma.expert.findFirstOrThrow({
      where: { email: 'good1@example.test' },
      include: { skills: { include: { skill: true } } },
    });
    expect(created.hourlyRateCents).toBe(25_000);
    expect(created.yearsExperience).toBe(12);
    expect(created.skills).toHaveLength(1);
    expect(created.skills[0]!.proficiency).toBe(5);
    expect(created.reference).toMatch(/^EXP-\d{4}$/);
  });

  it('parses skills with and without a proficiency', async () => {
    const operator = await makeOperator();
    await commitExpertImport(
      prisma,
      actorFor(operator),
      csv('Multi Skill,multi@example.test,Consultant,12,250,USD,UTC,20,Alpha:5; Beta; Gamma:2,'),
    );

    const expert = await prisma.expert.findFirstOrThrow({
      where: { email: 'multi@example.test' },
      include: { skills: { include: { skill: true } } },
    });
    const byName = Object.fromEntries(
      expert.skills.map((link) => [link.skill.name, link.proficiency]),
    );
    expect(byName).toEqual({ Alpha: 5, Beta: 3, Gamma: 2 });
  });

  it('parses a rate written with a currency symbol', async () => {
    const operator = await makeOperator();
    await commitExpertImport(
      prisma,
      actorFor(operator),
      csv('Money Format,money@example.test,Consultant,12,"$1,250.50",USD,UTC,20,Skill:3,'),
    );
    const expert = await prisma.expert.findFirstOrThrow({ where: { email: 'money@example.test' } });
    expect(expert.hourlyRateCents).toBe(125_050);
  });

  it('is idempotent: re-running the same file creates nothing new', async () => {
    const operator = await makeOperator();
    const source = csv('Repeat,repeat@example.test,Consultant,12,250,USD,UTC,20,Skill:3,');

    const first = await commitExpertImport(prisma, actorFor(operator), source);
    const second = await commitExpertImport(prisma, actorFor(operator), source);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await prisma.expert.count()).toBe(1);
  });
});

describe('expert CSV export', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('exports the header and one row per expert', async () => {
    await makeExpert({ fullName: 'Avery Lindqvist', email: 'avery@example.test' });
    await makeExpert({ fullName: 'Rowan Barros', email: 'rowan@example.test' });

    const parsed = parseCsv(await exportExpertsCsv(prisma));
    expect(parsed.headers).toContain('reference');
    expect(parsed.headers).toContain('active_qualifications');
    expect(parsed.rows).toHaveLength(2);
  });

  it('neutralises a formula typed into a user-entered field', async () => {
    await makeExpert({ fullName: '=cmd|/c calc', email: 'evil@example.test' });
    const exported = await exportExpertsCsv(prisma);

    // The safety property is the leading apostrophe, which makes a spreadsheet
    // read the cell as text. Quoting is only added when the value needs it.
    expect(exported).toContain(`'=cmd`);
    expect(exported).not.toMatch(/,=cmd/);

    // Reading it back, the value is inert text rather than a formula.
    const parsed = parseCsv(exported);
    expect(parsed.rows[0]!.full_name!.startsWith("'=")).toBe(true);
  });

  it('produces a template an operator can fill in and re-import', async () => {
    const operator = await makeOperator();
    const template = exportImportTemplate();
    const parsed = parseCsv(template);

    expect(parsed.headers).toContain('full_name');
    expect(parsed.headers).toContain('qualification_hint');
    expect(parsed.rows).toHaveLength(1);

    // The template's example row is itself importable.
    const preview = await previewExpertImport(prisma, template);
    expect(preview.errors).toBe(0);

    const result = await commitExpertImport(prisma, actorFor(operator), template);
    expect(result.created).toBe(1);
  });
});
