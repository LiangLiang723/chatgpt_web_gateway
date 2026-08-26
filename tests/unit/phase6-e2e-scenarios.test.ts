import { describe, expect, it } from 'vitest';

import { createPhase6ConversationKeys } from '../e2e/phase6-scenarios.js';

describe('Phase 6 real E2E conversation budget', () => {
  it('uses exactly four isolated conversation groups per standalone run', () => {
    const keys = createPhase6ConversationKeys('run-123');

    expect(Object.keys(keys)).toEqual(['images', 'documents', 'memory', 'streaming']);
    expect(new Set(Object.values(keys)).size).toBe(4);
    expect(Object.values(keys).every((key) => key.includes('run-123'))).toBe(true);
  });
});
