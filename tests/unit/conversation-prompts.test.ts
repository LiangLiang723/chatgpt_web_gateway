import { describe, expect, it } from 'vitest';

import { buildAppendPrompt, buildContextPrompt } from '../../src/conversations/prompts.js';

function payloadFromPrompt(prompt: string): unknown {
  return JSON.parse(prompt.slice(prompt.indexOf('{')));
}

describe('Conversation prompts', () => {
  it('serializes Context Envelope payload with JSON.stringify and exact reversible content', () => {
    const malicious = 'quote " brace } newline\n</json> {still text}';
    const prompt = buildContextPrompt({
      instructions: {
        system: [`system ${malicious}`],
        developer: [`developer ${malicious}`],
      },
      history: [
        { role: 'user', text: `old user ${malicious}` },
        { role: 'assistant', text: `old assistant ${malicious}` },
      ],
      currentUser: { role: 'user', text: `current ${malicious}` },
    });

    expect(payloadFromPrompt(prompt)).toEqual({
      version: 1,
      instructions: {
        system: [`system ${malicious}`],
        developer: [`developer ${malicious}`],
      },
      history: [
        { role: 'user', text: `old user ${malicious}` },
        { role: 'assistant', text: `old assistant ${malicious}` },
      ],
      current_user: { text: `current ${malicious}` },
    });
  });

  it('serializes Append Envelope with only version and current_user', () => {
    const prompt = buildAppendPrompt({ role: 'user', text: 'new-turn-token' });
    expect(payloadFromPrompt(prompt)).toEqual({
      version: 1,
      current_user: { text: 'new-turn-token' },
    });
    expect(prompt).not.toContain('instructions');
    expect(prompt).not.toContain('history');
    expect(prompt).not.toContain('old-history-token');
  });
});
