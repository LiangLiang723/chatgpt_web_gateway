import { describe, expect, it } from 'vitest';

import { waitForStreamingCompletion } from '../../src/stream/completion.js';
import { type AssistantSnapshot, type StreamClock } from '../../src/stream/types.js';

function scriptedClock(): StreamClock {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

function observations(values: AssistantSnapshot[]) {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)]!;
}

describe('waitForStreamingCompletion', () => {
  it('requires the target completion marker plus three stable final samples and a final reread', async () => {
    const observe = observations([
      { exists: false, text: '', completionMarkerPresent: false },
      { exists: true, text: 'Hel', completionMarkerPresent: false },
      { exists: true, text: 'Hello', completionMarkerPresent: true },
      { exists: true, text: 'Hello!', completionMarkerPresent: true },
      { exists: true, text: 'Hello!', completionMarkerPresent: true },
      { exists: true, text: 'Hello!', completionMarkerPresent: true },
      { exists: true, text: 'Hello!', completionMarkerPresent: true },
    ]);

    await expect(
      waitForStreamingCompletion({
        observe,
        clock: scriptedClock(),
        pollIntervalMs: 10,
        timeoutMs: 100,
      }),
    ).resolves.toBe('Hello!');
  });

  it('does not depend on a global stop-control signal', async () => {
    const observe = observations([
      { exists: true, text: 'Done', completionMarkerPresent: true },
      { exists: true, text: 'Done', completionMarkerPresent: true },
      { exists: true, text: 'Done', completionMarkerPresent: true },
      { exists: true, text: 'Done', completionMarkerPresent: true },
    ]);

    await expect(
      waitForStreamingCompletion({
        observe,
        clock: scriptedClock(),
        pollIntervalMs: 10,
        timeoutMs: 100,
      }),
    ).resolves.toBe('Done');
  });

  it('throws response_missing when no target Assistant turn appears', async () => {
    await expect(
      waitForStreamingCompletion({
        observe: async () => ({ exists: false, text: '', completionMarkerPresent: false }),
        clock: scriptedClock(),
        pollIntervalMs: 10,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_response_missing' });
  });

  it('throws generation_timeout when a target turn appears but never completes', async () => {
    await expect(
      waitForStreamingCompletion({
        observe: async () => ({
          exists: true,
          text: 'Working',
          completionMarkerPresent: false,
        }),
        clock: scriptedClock(),
        pollIntervalMs: 10,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_generation_timeout' });
  });

  it('throws stream_diverged if the owned target turn disappears after appearing', async () => {
    const observe = observations([
      { exists: true, text: 'A', completionMarkerPresent: false },
      { exists: false, text: '', completionMarkerPresent: false },
    ]);

    await expect(
      waitForStreamingCompletion({
        observe,
        clock: scriptedClock(),
        pollIntervalMs: 10,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_stream_diverged' });
  });
});
