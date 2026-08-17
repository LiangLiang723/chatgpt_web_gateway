import { describe, expect, it } from 'vitest';

import { streamAssistantText } from '../../src/stream/text-stream.js';
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

describe('streamAssistantText', () => {
  it('emits only stable DOM prefixes while generating and flushes the confirmed final tail', async () => {
    const deltas: string[] = [];
    const finalText = await streamAssistantText({
      observe: observations([
        { exists: false, text: '', completionMarkerPresent: false },
        { exists: true, text: 'H', completionMarkerPresent: false },
        { exists: true, text: 'He', completionMarkerPresent: false },
        { exists: true, text: 'Hel', completionMarkerPresent: false },
        { exists: true, text: 'Hell', completionMarkerPresent: false },
        { exists: true, text: 'Hello', completionMarkerPresent: true },
        { exists: true, text: 'Hello!', completionMarkerPresent: true },
        { exists: true, text: 'Hello!', completionMarkerPresent: true },
        { exists: true, text: 'Hello!', completionMarkerPresent: true },
        { exists: true, text: 'Hello!', completionMarkerPresent: true },
      ]),
      onDelta: async (delta) => {
        deltas.push(delta);
      },
      clock: scriptedClock(),
      pollIntervalMs: 10,
      holdbackCodePoints: 0,
      timeoutMs: 200,
    });

    expect(finalText).toBe('Hello!');
    expect(deltas.every((delta) => delta.length > 0)).toBe(true);
    expect(deltas.join('')).toBe('Hello!');
    expect(deltas.length).toBeGreaterThan(1);
  });

  it('keeps a bounded stable tail uncommitted so short renderer tail rewrites can settle', async () => {
    const deltas: string[] = [];
    const growing = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const final = growing.slice(0, -3);

    const finalText = await streamAssistantText({
      observe: observations([
        { exists: true, text: growing, completionMarkerPresent: false },
        { exists: true, text: growing, completionMarkerPresent: false },
        { exists: true, text: growing, completionMarkerPresent: false },
        { exists: true, text: final, completionMarkerPresent: false },
        { exists: true, text: final, completionMarkerPresent: true },
        { exists: true, text: final, completionMarkerPresent: true },
        { exists: true, text: final, completionMarkerPresent: true },
        { exists: true, text: final, completionMarkerPresent: true },
      ]),
      onDelta: async (delta) => {
        deltas.push(delta);
      },
      clock: scriptedClock(),
      pollIntervalMs: 10,
      timeoutMs: 200,
    });

    expect(finalText).toBe(final);
    expect(deltas.join('')).toBe(final);
    expect(deltas.length).toBeGreaterThan(1);
  });

  it('never emits a correction when the DOM rewrites an already committed prefix', async () => {
    const deltas: string[] = [];

    await expect(
      streamAssistantText({
        observe: observations([
          { exists: true, text: 'Hello', completionMarkerPresent: false },
          { exists: true, text: 'Hello ', completionMarkerPresent: false },
          { exists: true, text: 'Hello w', completionMarkerPresent: false },
          { exists: true, text: 'Hallo', completionMarkerPresent: false },
        ]),
        onDelta: async (delta) => {
          deltas.push(delta);
        },
        clock: scriptedClock(),
        pollIntervalMs: 10,
        holdbackCodePoints: 0,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_stream_diverged' });

    expect(deltas.join('')).toBe('Hello');
  });
});
