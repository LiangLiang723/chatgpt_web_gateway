import { describe, expect, it } from 'vitest';

import type { NormalizedTool, NormalizedToolChoice } from '../../src/api/normalized.js';
import {
  canonicalizeTools,
  fingerprintTools,
  validateToolChoice,
} from '../../src/tools/canonicalize.js';

const weather: NormalizedTool = {
  type: 'function',
  name: 'get_weather',
  description: 'Get weather',
  parameters: {
    required: ['city'],
    properties: {
      unit: { enum: ['c', 'f'], type: 'string' },
      city: { type: 'string' },
    },
    type: 'object',
  },
};

const clock: NormalizedTool = {
  type: 'function',
  name: 'get_time',
  parameters: { type: 'object', properties: {} },
};

function choice(value: NormalizedToolChoice): NormalizedToolChoice {
  return value;
}

describe('tool canonicalization', () => {
  it('makes tool declaration order and object-key order fingerprint-equivalent', () => {
    const reorderedWeather: NormalizedTool = {
      type: 'function',
      name: 'get_weather',
      description: 'Get weather',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          unit: { type: 'string', enum: ['c', 'f'] },
        },
        required: ['city'],
      },
    };

    expect(fingerprintTools([weather, clock])).toBe(fingerprintTools([clock, reorderedWeather]));
    expect(canonicalizeTools([weather, clock]).map((tool) => tool.name)).toEqual([
      'get_time',
      'get_weather',
    ]);
  });

  it('changes the fingerprint when a semantic definition changes', () => {
    expect(
      fingerprintTools([
        {
          ...weather,
          description: 'Get current weather from the city service',
        },
      ]),
    ).not.toBe(fingerprintTools([weather]));
  });

  it('rejects duplicate function names', () => {
    expect(() => canonicalizeTools([weather, { ...weather }])).toThrow(/duplicate/i);
  });

  it('rejects required choice without any tools', () => {
    expect(() => validateToolChoice([], choice({ mode: 'required' }))).toThrow(
      /requires at least one tool/i,
    );
  });

  it('rejects a forced function that is not in the current tool set', () => {
    expect(() =>
      validateToolChoice([weather], choice({ mode: 'function', name: 'missing_tool' })),
    ).toThrow(/missing_tool/i);
  });

  it('allows none, auto, required and an existing forced function', () => {
    expect(() => validateToolChoice([weather], choice({ mode: 'none' }))).not.toThrow();
    expect(() => validateToolChoice([weather], choice({ mode: 'auto' }))).not.toThrow();
    expect(() => validateToolChoice([weather], choice({ mode: 'required' }))).not.toThrow();
    expect(() =>
      validateToolChoice([weather], choice({ mode: 'function', name: 'get_weather' })),
    ).not.toThrow();
  });
});
