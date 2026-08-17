import { ChatGptStreamDivergedError } from './errors.js';

export interface StablePrefixState {
  emitted: string;
  samples: string[];
  stableSamples: number;
  holdbackCodePoints: number;
}

export function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  const codePoints = values.map((value) => Array.from(value));
  const first = codePoints[0]!;
  let length = first.length;

  for (let valueIndex = 1; valueIndex < codePoints.length; valueIndex += 1) {
    const current = codePoints[valueIndex]!;
    length = Math.min(length, current.length);
    let index = 0;
    while (index < length && first[index] === current[index]) index += 1;
    length = index;
    if (length === 0) break;
  }

  return first.slice(0, length).join('');
}

export function createStablePrefixState(
  options: { stableSamples?: number; holdbackCodePoints?: number } = {},
): StablePrefixState {
  const stableSamples = options.stableSamples ?? 3;
  const holdbackCodePoints = options.holdbackCodePoints ?? 0;
  if (!Number.isInteger(stableSamples) || stableSamples < 1) {
    throw new RangeError('stableSamples must be a positive integer');
  }
  if (!Number.isInteger(holdbackCodePoints) || holdbackCodePoints < 0) {
    throw new RangeError('holdbackCodePoints must be a non-negative integer');
  }
  return { emitted: '', samples: [], stableSamples, holdbackCodePoints };
}

function assertStillContainsEmitted(emitted: string, text: string): void {
  if (!text.startsWith(emitted)) throw new ChatGptStreamDivergedError();
}

export function observeStablePrefix(
  state: StablePrefixState,
  text: string,
): { state: StablePrefixState; delta: string } {
  assertStillContainsEmitted(state.emitted, text);
  const samples = [...state.samples, text].slice(-state.stableSamples);
  if (samples.length < state.stableSamples) {
    return { state: { ...state, samples }, delta: '' };
  }

  const stable = longestCommonPrefix(samples);
  assertStillContainsEmitted(state.emitted, stable);
  const stableCodePoints = Array.from(stable);
  const committable = stableCodePoints
    .slice(0, Math.max(0, stableCodePoints.length - state.holdbackCodePoints))
    .join('');
  const emitted = committable.startsWith(state.emitted) ? committable : state.emitted;
  const delta = emitted.slice(state.emitted.length);
  return {
    state: {
      ...state,
      emitted,
      samples,
    },
    delta,
  };
}

export function flushStablePrefix(
  state: StablePrefixState,
  finalText: string,
): { state: StablePrefixState; delta: string } {
  assertStillContainsEmitted(state.emitted, finalText);
  const delta = finalText.slice(state.emitted.length);
  return {
    state: {
      ...state,
      emitted: finalText,
      samples: [...state.samples, finalText].slice(-state.stableSamples),
    },
    delta,
  };
}
