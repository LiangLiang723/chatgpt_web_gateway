import { describe, expect, it } from 'vitest';

import { architectureImportViolation } from '../../scripts/architecture-rules.mjs';

describe('architecture import rules', () => {
  it.each([
    ['context', '../api/normalized.js'],
    ['context', '../persistence/types.js'],
    ['context', '../chatgpt/driver.js'],
    ['context', 'playwright'],
    ['browser', '../api/errors.js'],
    ['browser', '../persistence/types.js'],
    ['browser', '../chatgpt/driver.js'],
    ['browser', '../conversations/page-registry.js'],
    ['chatgpt', '../api/errors.js'],
    ['chatgpt', '../persistence/types.js'],
    ['chatgpt', '../conversations/conversation-engine.js'],
    ['chatgpt', '../conversations/page-registry.js'],
    ['api', 'playwright'],
    ['api', '../chatgpt/selectors.js'],
    ['persistence', 'playwright'],
  ])('rejects %s importing %s', (directory, imported) => {
    expect(architectureImportViolation(directory, imported)).toEqual(expect.any(String));
  });

  it.each([
    ['context', './planner.js'],
    ['browser', './types.js'],
    ['chatgpt', '../browser/types.js'],
    ['api', '../conversations/conversation-engine.js'],
    ['persistence', '../api/normalized.js'],
  ])('allows approved dependency %s importing %s', (directory, imported) => {
    expect(architectureImportViolation(directory, imported)).toBeUndefined();
  });
});
