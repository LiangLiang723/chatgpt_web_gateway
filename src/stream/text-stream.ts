import { waitForStreamingCompletion } from './completion.js';
import { normalizeAssistantText } from './normalize.js';
import {
  createStablePrefixState,
  flushStablePrefix,
  observeStablePrefix,
} from './stable-prefix.js';
import type { AssistantSnapshot, StreamClock } from './types.js';

export interface StreamAssistantTextOptions {
  observe(): Promise<AssistantSnapshot>;
  onDelta(delta: string): Promise<void>;
  signal?: AbortSignal;
  clock?: StreamClock;
  pollIntervalMs?: number;
  stableSamples?: number;
  timeoutMs?: number;
}

export async function streamAssistantText(options: StreamAssistantTextOptions): Promise<string> {
  let stableState = createStablePrefixState({ stableSamples: options.stableSamples ?? 3 });

  const finalText = await waitForStreamingCompletion({
    observe: options.observe,
    onSnapshot: async (snapshot) => {
      if (!snapshot.exists) return;
      const observed = observeStablePrefix(stableState, normalizeAssistantText(snapshot.text));
      stableState = observed.state;
      if (observed.delta.length > 0) await options.onDelta(observed.delta);
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.stableSamples === undefined ? {} : { stableSamples: options.stableSamples }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const flushed = flushStablePrefix(stableState, finalText);
  stableState = flushed.state;
  if (flushed.delta.length > 0) await options.onDelta(flushed.delta);
  return stableState.emitted;
}
