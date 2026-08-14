import { describe, expect, it } from 'vitest';

import {
  waitForAssistantCompletion,
  type AssistantCompletionObservation,
  type CompletionClock,
} from '../../src/chatgpt/completion.js';

function scriptedClock(): CompletionClock & { advance(ms: number): void } {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

function observations(values: AssistantCompletionObservation[]) {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)]!;
}

describe('waitForAssistantCompletion', () => {
  it('completes after non-generating non-empty text is stable for three samples', async () => {
    const clock = scriptedClock();
    const observe = observations([
      { exists: true, generating: true, text: 'Hel' },
      { exists: true, generating: false, text: 'Hello' },
      { exists: true, generating: false, text: 'Hello' },
      { exists: true, generating: false, text: 'Hello' },
    ]);

    await expect(
      waitForAssistantCompletion({ observe, clock, pollIntervalMs: 10, timeoutMs: 100 }),
    ).resolves.toBe('Hello');
  });

  it('resets stability when text changes and never completes on empty text', async () => {
    const clock = scriptedClock();
    const observe = observations([
      { exists: true, generating: false, text: '' },
      { exists: true, generating: false, text: 'A' },
      { exists: true, generating: false, text: 'A' },
      { exists: true, generating: false, text: 'AB' },
      { exists: true, generating: false, text: 'AB' },
      { exists: true, generating: false, text: 'AB' },
    ]);

    await expect(
      waitForAssistantCompletion({ observe, clock, pollIntervalMs: 10, timeoutMs: 100 }),
    ).resolves.toBe('AB');
  });

  it('throws response_missing when no assistant turn appears before timeout', async () => {
    const clock = scriptedClock();

    await expect(
      waitForAssistantCompletion({
        observe: async () => ({ exists: false, generating: false, text: '' }),
        clock,
        pollIntervalMs: 10,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_response_missing' });
  });

  it('throws generation_timeout when a turn appears but never completes', async () => {
    const clock = scriptedClock();

    await expect(
      waitForAssistantCompletion({
        observe: async () => ({ exists: true, generating: true, text: 'Working' }),
        clock,
        pollIntervalMs: 10,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_generation_timeout' });
  });
});
