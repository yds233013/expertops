/**
 * Display names for seeded fixtures, and the names they used to carry.
 *
 * Seeded records were once called "NET Ada Nowak 001", "PRACTICE coding review
 * pilot" and "SYNTHETIC Client (staging only)". The prefix was doing two jobs:
 * telling a reader the record was not real, and letting the public demo pick
 * out which records it could show. The second job moved to the `demoEligible`
 * column; the first moved to a single "Sample data" label on the page. What was
 * left was a list that read like a database dump.
 *
 * Migration `20260916100000_fixture_display_names` renamed already-seeded rows
 * from each `legacy` value to its `current` value, and only where the row's
 * provenance could be shown. The seed scripts look records up by either name,
 * so re-running one against a database the migration has not reached yet does
 * not create a second copy.
 *
 * `tests/integration/fixture-names.test.ts` checks that the migration and this
 * file agree. Change one and that test will say so.
 */

export interface Rename {
  legacy: string;
  current: string;
}

export const SAMPLE_CLIENT = 'Sample client';

export const PROJECT_RENAMES = {
  coding: { legacy: 'PRACTICE coding review pilot', current: 'Coding review pilot' },
  enterprise: {
    legacy: 'PRACTICE enterprise process assessment',
    current: 'Enterprise process assessment',
  },
  cyber: { legacy: 'PRACTICE security posture review', current: 'Security posture review' },
  evaluation: { legacy: 'PRACTICE evaluation pilot', current: 'Evaluation pilot' },
  handsOn: { legacy: 'PRACTICE hands-on review pilot', current: 'Hands-on review pilot' },
  staging: { legacy: 'SYNTHETIC staging sandbox project', current: 'Evaluation sandbox' },
} satisfies Record<string, Rename>;

/** The client name each script wrote, which is part of the provenance check. */
export const LEGACY_CLIENT_NAMES = [
  'PRACTICE Client (practice only)',
  'PRACTICE Client (hands-on only)',
  'SYNTHETIC Client (staging only)',
] as const;

export const OPPORTUNITY_RENAMES = {
  coding: { legacy: 'PRACTICE code review specialist', current: 'Code review specialist' },
  enterprise: {
    legacy: 'PRACTICE enterprise process analyst',
    current: 'Enterprise process analyst',
  },
  cyber: { legacy: 'PRACTICE security reviewer', current: 'Security reviewer' },
  handsOn: { legacy: 'PRACTICE hands-on code reviewer', current: 'Hands-on code reviewer' },
} satisfies Record<string, Rename>;

/** Keyed by domain slug, which never changed and is what the scripts look up. */
export const DOMAIN_RENAMES = {
  'practice-coding': { legacy: 'PRACTICE Coding', current: 'Coding' },
  'practice-enterprise-business': {
    legacy: 'PRACTICE Enterprise Business',
    current: 'Enterprise business',
  },
  'practice-cybersecurity': { legacy: 'PRACTICE Cybersecurity', current: 'Cybersecurity' },
  'practice-evaluation': { legacy: 'PRACTICE Evaluation', current: 'Evaluation' },
} satisfies Record<string, Rename>;

export const RUBRIC_RENAMES = {
  coding: { legacy: 'PRACTICE coding screening', current: 'Coding screening' },
  enterprise: { legacy: 'PRACTICE enterprise screening', current: 'Enterprise screening' },
  cyber: { legacy: 'PRACTICE security screening', current: 'Security screening' },
  evaluation: { legacy: 'PRACTICE evaluation screening', current: 'Evaluation screening' },
} satisfies Record<string, Rename>;

/** Named people from the staging and practice scripts, keyed by their fixture address. */
export const PERSON_RENAMES: Record<string, Rename & { headline: Rename }> = {
  'synthetic.avery.lindqvist@example.test': {
    legacy: 'SYNTHETIC Avery Lindqvist',
    current: 'Avery Lindqvist',
    headline: {
      legacy: 'SYNTHETIC staging record — evaluation operations',
      current: 'Evaluation operations lead',
    },
  },
  'synthetic.bo.okonkwo@example.test': {
    legacy: 'SYNTHETIC Bo Okonkwo',
    current: 'Bo Okonkwo',
    headline: {
      legacy: 'SYNTHETIC staging record — clinical operations',
      current: 'Clinical operations specialist',
    },
  },
  'synthetic.cleo.marchetti@example.test': {
    legacy: 'SYNTHETIC Cleo Marchetti',
    current: 'Cleo Marchetti',
    headline: {
      legacy: 'SYNTHETIC staging record — survey methodology',
      current: 'Survey methodologist',
    },
  },
  'synthetic.dara.nkemelu@example.test': {
    legacy: 'SYNTHETIC Dara Nkemelu',
    current: 'Dara Nkemelu',
    headline: {
      legacy: 'SYNTHETIC staging record — programme evaluation',
      current: 'Programme evaluation adviser',
    },
  },
  'practice.nadia.halvorsen@example.test': {
    legacy: 'PRACTICE Nadia Halvorsen',
    current: 'Nadia Halvorsen',
    headline: { legacy: 'PRACTICE record — ready to staff', current: 'Evaluation design lead' },
  },
  'practice.tomas.ferreira@example.test': {
    legacy: 'PRACTICE Tomas Ferreira',
    current: 'Tomas Ferreira',
    headline: {
      legacy: 'PRACTICE record — onboarding not finished',
      current: 'Evaluation methodologist',
    },
  },
  'practice.ingrid.sorensen@example.test': {
    legacy: 'PRACTICE Ingrid Sørensen',
    current: 'Ingrid Sørensen',
    headline: {
      legacy: 'PRACTICE record — holds back as a replacement',
      current: 'Senior evaluation designer',
    },
  },
  'practice.rosa.imani@example.test': {
    legacy: 'PRACTICE Rosa Imani',
    current: 'Rosa Imani',
    headline: {
      legacy: 'PRACTICE applicant — awaiting a screening',
      current: 'Evaluation researcher',
    },
  },
};

/**
 * A distinct name for each network-exercise serial.
 *
 * The old names were drawn at random from 26 given and 26 family names, and a
 * hundred draws collided seven times. With the serial suffix gone those would
 * have become seven pairs of identically named people. Multiplying the serial
 * by 179 — prime, so coprime with 26 × 26 — visits every pair once before any
 * repeats, so serials 1 to 676 each get their own name.
 *
 * The migration does the same arithmetic in SQL.
 */
export const GIVEN = [
  'Amara',
  'Bo',
  'Chidi',
  'Dara',
  'Eli',
  'Faye',
  'Gil',
  'Hana',
  'Ines',
  'Jian',
  'Kofi',
  'Lena',
  'Mila',
  'Nils',
  'Oona',
  'Petra',
  'Quinn',
  'Rafa',
  'Sena',
  'Tariq',
  'Ulla',
  'Vik',
  'Wren',
  'Xia',
  'Yusuf',
  'Zara',
] as const;

export const FAMILY = [
  'Abiodun',
  'Bergstrom',
  'Castellanos',
  'Dlamini',
  'Eriksen',
  'Farooqi',
  'Gustafsson',
  'Haddad',
  'Ivanova',
  'Jonsdottir',
  'Kowalski',
  'Lindqvist',
  'Mbeki',
  'Nakamura',
  'Oyelaran',
  'Petrova',
  'Quintero',
  'Rasmussen',
  'Sorokin',
  'Tanaka',
  'Ustinov',
  'Vasquez',
  'Wojcik',
  'Xu',
  'Yamada',
  'Zielinski',
] as const;

export function networkMemberName(serial: number): string {
  const code = (serial * 179) % (GIVEN.length * FAMILY.length);
  const given = GIVEN[code % GIVEN.length]!;
  const family = FAMILY[Math.floor(code / GIVEN.length)]!;
  return `${given} ${family}`;
}

/** A Prisma `in` filter matching a record under its current or its legacy name. */
export function eitherName(rename: Rename): { in: string[] } {
  return { in: [rename.current, rename.legacy] };
}
