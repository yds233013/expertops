import { describe, expect, it } from 'vitest';
import { ONBOARDING_CHECKLIST, outstandingRequiredItems } from '@/server/services/onboarding';

describe('onboarding checklist template', () => {
  it('uses unique keys', () => {
    const keys = ONBOARDING_CHECKLIST.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('asks only about the working engagement, never a personal characteristic', () => {
    const text = ONBOARDING_CHECKLIST.map((item) => `${item.key} ${item.label} ${item.helpText}`)
      .join(' ')
      .toLowerCase();

    // Whole-word matching: a substring check would flag "age" inside
    // "engagement" and give a false failure.
    const prohibited = [
      'age',
      'birthday',
      'birthdate',
      'gender',
      'sex',
      'race',
      'ethnicity',
      'nationality',
      'citizenship',
      'religion',
      'disability',
      'health',
      'medical',
      'marital',
      'pregnancy',
      'orientation',
      'political',
      'union',
    ];
    for (const term of prohibited) {
      expect(text, `checklist must not mention "${term}"`).not.toMatch(new RegExp(`\\b${term}\\b`));
    }
  });

  it('collects no payment details, only a simulated reference', () => {
    const billing = ONBOARDING_CHECKLIST.find((item) => item.key === 'billing_reference');
    expect(billing).toBeDefined();
    expect(billing!.helpText.toLowerCase()).toContain('no payment details are collected');
  });

  it('marks exactly one item optional', () => {
    expect(ONBOARDING_CHECKLIST.filter((item) => !item.required)).toHaveLength(1);
  });
});

describe('outstandingRequiredItems', () => {
  const items = [
    { key: 'a', label: 'A', required: true, completedAt: null },
    { key: 'b', label: 'B', required: true, completedAt: new Date() },
    { key: 'c', label: 'C', required: false, completedAt: null },
  ];

  it('returns only incomplete required items', () => {
    expect(outstandingRequiredItems(items).map((item) => item.key)).toEqual(['a']);
  });

  it('returns an empty list when every required item is done', () => {
    const done = items.map((item) => ({ ...item, completedAt: item.required ? new Date() : null }));
    expect(outstandingRequiredItems(done)).toEqual([]);
  });
});
