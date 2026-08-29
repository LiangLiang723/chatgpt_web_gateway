import { describe, expect, it } from 'vitest';

import {
  buildStructuredOutputPolicy,
  validateStructuredAssistantText,
  validateStructuredOutputDefinition,
} from '../../src/structured/output.js';

describe('structured output', () => {
  it('builds compact JSON-object and JSON-Schema prompt policies', () => {
    expect(buildStructuredOutputPolicy({ type: 'json_object' })).toMatchObject({
      type: 'json_object',
      task: expect.stringContaining('valid JSON object'),
    });
    expect(
      buildStructuredOutputPolicy({
        type: 'json_schema',
        name: 'weather',
        description: 'Weather result',
        schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        strict: true,
      }),
    ).toMatchObject({
      type: 'json_schema',
      name: 'weather',
      description: 'Weather result',
      strict: true,
      schema: expect.any(Object),
    });
  });

  it('accepts one JSON object and rejects prose, arrays and malformed JSON', () => {
    expect(() =>
      validateStructuredAssistantText('{"ok":true}', { type: 'json_object' }),
    ).not.toThrow();
    for (const text of ['```json\n{"ok":true}\n```', '[]', '{bad}']) {
      expect(() => validateStructuredAssistantText(text, { type: 'json_object' })).toThrowError(
        expect.objectContaining({ code: 'chatgpt_structured_output_invalid' }),
      );
    }
  });

  it('validates JSON output against the requested schema', () => {
    const output = {
      type: 'json_schema' as const,
      name: 'weather',
      schema: {
        type: 'object',
        properties: { city: { type: 'string' }, temperature: { type: 'number' } },
        required: ['city', 'temperature'],
        additionalProperties: false,
      },
      strict: true,
    };
    expect(() => validateStructuredOutputDefinition(output)).not.toThrow();
    expect(() =>
      validateStructuredAssistantText('{"city":"Tokyo","temperature":31}', output),
    ).not.toThrow();
    expect(() => validateStructuredAssistantText('{"city":"Tokyo"}', output)).toThrowError(
      expect.objectContaining({ code: 'chatgpt_structured_output_invalid' }),
    );
  });

  it('rejects an invalid caller JSON Schema before browser execution', () => {
    expect(() =>
      validateStructuredOutputDefinition({
        type: 'json_schema',
        name: 'bad',
        schema: { type: 'definitely-not-a-json-schema-type' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_conversation_request' }));
  });
});
