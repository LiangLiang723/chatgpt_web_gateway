import { waitForStreamingCompletion } from '../stream/completion.js';
import { TextStreamError } from '../stream/errors.js';
import type { StreamClock } from '../stream/types.js';
import { ChatGptDriverError, type ChatGptDriverErrorCode } from './errors.js';

export interface AssistantCompletionObservation {
  exists: boolean;
  generating: boolean;
  text: string;
}

export type CompletionClock = StreamClock;

export interface WaitForAssistantCompletionOptions {
  observe(): Promise<AssistantCompletionObservation>;
  clock?: CompletionClock;
  pollIntervalMs?: number;
  stableSamples?: number;
  timeoutMs?: number;
}

function toDriverError(error: TextStreamError): ChatGptDriverError {
  return new ChatGptDriverError({
    code: error.code as ChatGptDriverErrorCode,
    message: error.message,
    cause: error,
  });
}

export async function waitForAssistantCompletion(
  options: WaitForAssistantCompletionOptions,
): Promise<string> {
  try {
    return await waitForStreamingCompletion({
      observe: async () => {
        const observation = await options.observe();
        return {
          exists: observation.exists,
          text: observation.text,
          completionMarkerPresent: observation.exists && !observation.generating,
        };
      },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.stableSamples === undefined ? {} : { stableSamples: options.stableSamples }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    if (error instanceof TextStreamError) throw toDriverError(error);
    throw error;
  }
}

export async function waitForAssistantFinalSnapshot(
  options: WaitForAssistantCompletionOptions,
): Promise<string> {
  const clock = options.clock;
  const startedAt = clock?.now() ?? Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 120_000;
  let sawTurn = false;

  while ((clock?.now() ?? Date.now()) - startedAt <= timeoutMs) {
    const observation = await options.observe();
    if (observation.exists) sawTurn = true;
    if (observation.exists && !observation.generating && observation.text.trim().length > 0) {
      return observation.text;
    }
    if (clock) await clock.sleep(pollIntervalMs);
    else await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new ChatGptDriverError({
    code: sawTurn ? 'chatgpt_generation_timeout' : 'chatgpt_response_missing',
    message: sawTurn
      ? 'ChatGPT generation did not complete before the timeout'
      : 'ChatGPT did not produce a new Assistant turn',
  });
}
