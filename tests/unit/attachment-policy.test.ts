import { describe, expect, it } from 'vitest';

import { isSafeLogicalFilename } from '../../src/attachments/policy.js';

describe('attachment filename policy', () => {
  it.each(['notes.txt', '报告 2026.pdf', 'école.xlsx'])(
    'accepts safe logical filename %s',
    (value) => {
      expect(isSafeLogicalFilename(value)).toBe(true);
    },
  );

  it.each(['', '../notes.txt', 'folder/notes.txt', 'folder\\notes.txt', 'a\0.txt', 'a\n.txt'])(
    'rejects unsafe logical filename %j',
    (value) => {
      expect(isSafeLogicalFilename(value)).toBe(false);
    },
  );

  it('enforces the 255-byte UTF-8 limit rather than JavaScript character count', () => {
    expect(isSafeLogicalFilename('a'.repeat(255))).toBe(true);
    expect(isSafeLogicalFilename('界'.repeat(85))).toBe(true);
    expect(isSafeLogicalFilename('界'.repeat(86))).toBe(false);
  });
});
