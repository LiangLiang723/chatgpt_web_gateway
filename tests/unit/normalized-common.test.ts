import { describe, expect, it } from 'vitest';

import {
  addBase64FileAttachment,
  addFileIdAttachment,
  addImageAttachment,
  createNormalizationState,
  normalizeInstructionText,
  normalizeStructuredOutput,
  normalizeToolChoice,
  normalizeTools,
  recordIgnoredParameters,
} from '../../src/api/normalize/common.js';

describe('common request normalization', () => {
  it('normalizes instruction strings and text-part arrays', () => {
    expect(normalizeInstructionText('alpha')).toBe('alpha');
    expect(
      normalizeInstructionText([
        { type: 'text', text: 'alpha' },
        { type: 'text', text: 'beta' },
      ]),
    ).toBe('alpha\nbeta');
  });

  it('normalizes function tools and tool-choice variants', () => {
    expect(
      normalizeTools([
        {
          type: 'function',
          function: {
            name: 'lookup_weather',
            description: 'Look up weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ]),
    ).toEqual([
      {
        type: 'function',
        name: 'lookup_weather',
        description: 'Look up weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ]);

    expect(normalizeToolChoice(undefined)).toEqual({ mode: 'auto' });
    expect(normalizeToolChoice('none')).toEqual({ mode: 'none' });
    expect(normalizeToolChoice('required')).toEqual({ mode: 'required' });
    expect(normalizeToolChoice({ type: 'function', function: { name: 'lookup_weather' } })).toEqual(
      { mode: 'function', name: 'lookup_weather' },
    );
  });

  it('creates deterministic attachment descriptors without resolving bytes or URLs', () => {
    const state = createNormalizationState();

    expect(addImageAttachment(state, 'https://example.com/cat.png')).toEqual({
      type: 'attachment',
      attachmentId: 'attachment-1',
    });
    expect(addImageAttachment(state, 'data:image/png;base64,AAAA')).toEqual({
      type: 'attachment',
      attachmentId: 'attachment-2',
    });
    expect(addFileIdAttachment(state, 'file_123')).toEqual({
      type: 'attachment',
      attachmentId: 'attachment-3',
    });
    expect(addBase64FileAttachment(state, 'QUJD', 'notes.txt')).toEqual({
      type: 'attachment',
      attachmentId: 'attachment-4',
    });

    expect(state.attachments).toEqual([
      {
        id: 'attachment-1',
        kind: 'image',
        source: { type: 'url', url: 'https://example.com/cat.png' },
      },
      {
        id: 'attachment-2',
        kind: 'image',
        source: { type: 'data_url', dataUrl: 'data:image/png;base64,AAAA' },
      },
      {
        id: 'attachment-3',
        kind: 'file',
        source: { type: 'file_id', fileId: 'file_123' },
      },
      {
        id: 'attachment-4',
        kind: 'file',
        source: { type: 'base64', data: 'QUJD', filename: 'notes.txt' },
      },
    ]);
  });

  it('normalizes structured-output descriptions', () => {
    expect(normalizeStructuredOutput({ type: 'json_object' })).toEqual({
      type: 'json_object',
    });
    expect(
      normalizeStructuredOutput({
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          description: 'Structured answer',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          strict: true,
        },
      }),
    ).toEqual({
      type: 'json_schema',
      name: 'answer',
      description: 'Structured answer',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      strict: true,
    });
  });

  it('records accepted-but-ignored parameters for diagnostics', () => {
    const state = createNormalizationState();
    recordIgnoredParameters(
      state,
      { temperature: 0.2, top_p: undefined, seed: 42, max_tokens: 100 },
      ['temperature', 'top_p', 'seed', 'max_tokens'],
    );

    expect(state.ignoredParameters).toEqual(['temperature', 'seed', 'max_tokens']);
  });
});
