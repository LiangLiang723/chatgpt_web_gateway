import { ChatGptDriverError } from './errors.js';

export interface AssistantCompletionObservation {
  exists: boolean;
  generating: boolean;
  text: string;
}

export interface CompletionClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface WaitForAssistantCompletionOptions {
  observe(): Promise<AssistantCompletionObservation>;
  clock?: CompletionClock;
  pollIntervalMs?: number;
  stableSamples?: number;
  timeoutMs?: number;
}

const defaultClock: CompletionClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function waitForAssistantCompletion(
  options: WaitForAssistantCompletionOptions,
): Promise<string> {
  const clock = options.clock ?? defaultClock;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const stableSamples = options.stableSamples ?? 3;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startedAt = clock.now();
  let sawTurn = false;
  let lastText = '';
  let consecutiveStable = 0;

  while (clock.now() - startedAt <= timeoutMs) {
    const observation = await options.observe();
    if (observation.exists) sawTurn = true;

    if (observation.exists && !observation.generating && observation.text.trim().length > 0) {
      if (observation.text === lastText) consecutiveStable += 1;
      else {
        lastText = observation.text;
        consecutiveStable = 1;
      }

      if (consecutiveStable >= stableSamples) {
        const finalObservation = await options.observe();
        if (
          finalObservation.exists &&
          !finalObservation.generating &&
          finalObservation.text === observation.text
        ) {
          return finalObservation.text;
        }
        lastText = finalObservation.text;
        consecutiveStable = 0;
      }
    } else {
      consecutiveStable = 0;
      if (observation.text !== lastText) lastText = observation.text;
    }

    await clock.sleep(pollIntervalMs);
  }

  if (!sawTurn) {
    throw new ChatGptDriverError({
      code: 'chatgpt_response_missing',
      message: 'ChatGPT did not produce a new Assistant turn',
    });
  }
  throw new ChatGptDriverError({
    code: 'chatgpt_generation_timeout',
    message: 'ChatGPT generation did not complete before the timeout',
  });
}
