import { describe, expect, it } from 'vitest';

import {
  canonicalizeInstructions,
  canonicalizeText,
} from '../../src/context/canonicalize.js';
import { fingerprintCanonical } from '../../src/context/fingerprint.js';

describe('Context canonicalization', () => {
  it('joins text parts with the exact browser submission separator', () => {
    expect(canonicalizeText(['a', 'b'])).toBe('a\nb');
    expect(canonicalizeText(['only'])).toBe('only');
    expect(canonicalizeText([])).toBe('');
  });

  it('groups instructions by role while preserving order within each role', () => {
    expect(
      canonicalizeInstructions([
        { role: 'developer', content: 'd1' },
        { role: 'system', content: 's1' },
        { role: 'developer', content: 'd2' },
        { role: 'system', content: 's2' },
      ]),
    ).toEqual({ system: ['s1', 's2'], developer: ['d1', 'd2'] });
  });

  it('creates deterministic SHA-256 fingerprints for canonical values', () => {
    expect(fingerprintCanonical({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintCanonical({ a: 1 })).toBe(fingerprintCanonical({ a: 1 }));
    expect(fingerprintCanonical({ b: 2, a: 1 })).toBe(
      fingerprintCanonical({ a: 1, b: 2 }),
    );
    expect(fingerprintCanonical({ a: 1 })).not.toBe(fingerprintCanonical({ a: 2 }));
  });
});
