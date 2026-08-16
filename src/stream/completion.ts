import { ChatGptStreamDivergedError, TextStreamAbortedError, TextStreamError } from './errors.js';
import { normalizeAssistantText } from './normalize.js';
import type { AssistantSnapshot, StreamClock } from './types.js';

export interface WaitForStreamingCompletionOptions {
  observe(): Promise<AssistantSnapshot>;
  onSnapshot?: (snapshot: AssistantSnapshot) => Promise<void>;
  signal?: AbortSignal;
  clock?: StreamClock;
  pollIntervalMs?: number;
  stableSamples?: number;
  timeoutMs?: number;
}

const defaultClock: StreamClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TextStreamAbortedError();
}

export async function waitForStreamingCompletion(
  options: WaitForStreamingCompletionOptions,
): Promise<string> {
  const clock = options.clock ?? defaultClock;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const stableSamples = options.stableSamples ?? 3;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startedAt = clock.now();
  let sawTurn = false;
  let stableText = '';
  let consecutiveStable = 0;

  while (clock.now() - startedAt <= timeoutMs) {
    throwIfAborted(options.signal);
    const observation = await options.observe();
    await options.onSnapshot?.(observation);

    if (!observation.exists) {
      if (sawTurn) throw new ChatGptStreamDivergedError('Owned Assistant turn disappeared');
      consecutiveStable = 0;
      await clock.sleep(pollIntervalMs);
      continue;
    }

    sawTurn = true;
    const text = normalizeAssistantText(observation.text);
    if (observation.completionMarkerPresent && text.trim().length > 0) {
      if (text === stableText) consecutiveStable += 1;
      else {
        stableText = text;
        consecutiveStable = 1;
      }

      if (consecutiveStable >= stableSamples) {
        throwIfAborted(options.signal);
        const finalObservation = await options.observe();
        await options.onSnapshot?.(finalObservation);
        if (!finalObservation.exists) {
          throw new ChatGptStreamDivergedError('Owned Assistant turn disappeared');
        }
        const finalText = normalizeAssistantText(finalObservation.text);
        if (finalObservation.completionMarkerPresent && finalText === text) return finalText;
        stableText = finalText;
        consecutiveStable = 0;
      }
    } else {
      stableText = text;
      consecutiveStable = 0;
    }

    await clock.sleep(pollIntervalMs);
  }

  if (!sawTurn) {
    throw new TextStreamError(
      'chatgpt_response_missing',
      'ChatGPT did not produce a new Assistant turn',
    );
  }
  throw new TextStreamError(
    'chatgpt_generation_timeout',
    'ChatGPT generation did not complete before the timeout',
  );
}
