import { waitForStreamingCompletion } from '../stream/completion.js';
import { TextStreamError } from '../stream/errors.js';
import type { StreamClock } from '../stream/types.js';
import { ChatGptDriverError, type ChatGptDriverErrorCode } from './errors.js';

export interface AssistantCompletionObservation {
  exists: boolean;
  generating: boolean;
  text: string;
}

export interface CompletionClock extends StreamClock {}

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
