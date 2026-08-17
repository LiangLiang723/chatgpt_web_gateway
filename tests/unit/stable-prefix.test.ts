import { describe, expect, it } from 'vitest';

import { ChatGptStreamDivergedError } from '../../src/stream/errors.js';
import {
  createStablePrefixState,
  flushStablePrefix,
  longestCommonPrefix,
  observeStablePrefix,
} from '../../src/stream/stable-prefix.js';

describe('longestCommonPrefix', () => {
  it('finds a code-point-safe common prefix', () => {
    expect(longestCommonPrefix(['a', 'ab', 'abc'])).toBe('a');
    expect(longestCommonPrefix(['abc', 'abc', 'abc'])).toBe('abc');
    expect(longestCommonPrefix(['abX', 'abY', 'abZ'])).toBe('ab');
    expect(longestCommonPrefix(['😀abc', '😀abd', '😀abz'])).toBe('😀ab');
  });
});

describe('Stable Prefix state', () => {
  it('waits for three samples, then emits only newly stable text', () => {
    let state = createStablePrefixState({ stableSamples: 3 });

    let observed = observeStablePrefix(state, 'H');
    state = observed.state;
    expect(observed.delta).toBe('');

    observed = observeStablePrefix(state, 'He');
    state = observed.state;
    expect(observed.delta).toBe('');

    observed = observeStablePrefix(state, 'Hel');
    state = observed.state;
    expect(observed.delta).toBe('H');

    observed = observeStablePrefix(state, 'Hell');
    state = observed.state;
    expect(observed.delta).toBe('e');

    observed = observeStablePrefix(state, 'Hello');
    state = observed.state;
    expect(observed.delta).toBe('l');
    expect(state.emitted).toBe('Hel');
  });

  it('allows uncommitted tail rewrites without duplicating emitted text', () => {
    let state = createStablePrefixState({ stableSamples: 3 });
    for (const text of ['Hel', 'Hell', 'Hello']) {
      state = observeStablePrefix(state, text).state;
    }
    expect(state.emitted).toBe('Hel');

    const rewritten = observeStablePrefix(state, 'Hel!');
    expect(rewritten.delta).toBe('');
    expect(rewritten.state.emitted).toBe('Hel');
  });

  it('holds back whole Unicode code points without splitting a surrogate pair', () => {
    let state = createStablePrefixState({ stableSamples: 1, holdbackCodePoints: 1 });

    const observed = observeStablePrefix(state, 'A😀');
    state = observed.state;
    expect(observed.delta).toBe('A');
    expect(state.emitted).toBe('A');

    const flushed = flushStablePrefix(state, 'A😀');
    expect(flushed.delta).toBe('😀');
    expect(flushed.state.emitted).toBe('A😀');
  });

  it('fails when the DOM rewrites a prefix already emitted to the client', () => {
    let state = createStablePrefixState({ stableSamples: 3 });
    for (const text of ['Hello', 'Hello ', 'Hello w']) {
      state = observeStablePrefix(state, text).state;
    }
    expect(state.emitted).toBe('Hello');

    expect(() => observeStablePrefix(state, 'Hallo')).toThrow(ChatGptStreamDivergedError);
  });

  it('flushes the final confirmed tail exactly once', () => {
    let state = createStablePrefixState({ stableSamples: 3 });
    for (const text of ['Hello', 'Hello ', 'Hello w']) {
      state = observeStablePrefix(state, text).state;
    }

    const flushed = flushStablePrefix(state, 'Hello world!');
    expect(flushed.delta).toBe(' world!');
    expect(flushed.state.emitted).toBe('Hello world!');

    const repeated = flushStablePrefix(flushed.state, 'Hello world!');
    expect(repeated.delta).toBe('');
  });
});
