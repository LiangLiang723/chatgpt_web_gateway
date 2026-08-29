import { describe, expect, it } from 'vitest';

import {
  createPhase6ConversationKeys,
  parsePhase6Scenario,
  PHASE6_NEW_ATTACHMENT_TURN_BUDGET,
} from '../e2e/phase6-scenarios.js';

describe('Phase 6 real E2E conversation budget', () => {
  it('uses exactly four isolated conversation groups per standalone run', () => {
    const keys = createPhase6ConversationKeys('run-123');

    expect(Object.keys(keys)).toEqual([
      'images',
      'documentsPrimary',
      'documentsSecondary',
      'memory',
    ]);
    expect(new Set(Object.values(keys)).size).toBe(4);
    expect(Object.values(keys).every((key) => key.includes('run-123'))).toBe(true);
    expect(PHASE6_NEW_ATTACHMENT_TURN_BUDGET).toEqual({
      images: 2,
      documentsPrimary: 2,
      documentsSecondary: 2,
      memory: 1,
    });
  });

  it('parses focused Phase 6 conversation-group scenarios without changing the default full gate', () => {
    expect(parsePhase6Scenario(undefined)).toBe('all');
    expect(parsePhase6Scenario('images')).toBe('images');
    expect(parsePhase6Scenario('documents')).toBe('documents');
    expect(parsePhase6Scenario('xlsx')).toBe('xlsx');
    expect(parsePhase6Scenario('memory')).toBe('memory');
    expect(parsePhase6Scenario('streaming')).toBe('streaming');
    expect(() => parsePhase6Scenario('unknown')).toThrow(/E2E_CHATGPT_PHASE6_SCENARIO/);
  });
});
