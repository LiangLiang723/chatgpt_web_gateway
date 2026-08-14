import { describe, expect, it } from 'vitest';

import { UnsupportedParameterError } from '../../src/api/errors.js';
import { normalizeResponses } from '../../src/api/normalize/responses.js';
import type { ResponsesRequest } from '../../src/api/schemas/responses.js';

function normalize(request: ResponsesRequest) {
  return normalizeResponses(request, {
    requestId: 'req-responses-1',
    conversationKey: 'conversation-123',
  });
}

describe('normalizeResponses', () => {
  it('normalizes string input, instructions, flat tools, structured output, and stream metadata', () => {
    const result = normalize({
      model: 'chatgpt-web',
      instructions: 'Be concise.',
      input: 'Hello',
      tools: [
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
      ],
      tool_choice: { type: 'function', name: 'lookup_weather' },
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema: { type: 'object', properties: { summary: { type: 'string' } } },
          strict: true,
        },
      },
      stream: true,
    });

    expect(result).toEqual({
      requestId: 'req-responses-1',
      conversationKey: 'conversation-123',
      instructions: [{ role: 'developer', content: 'Be concise.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      tools: [
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
      ],
      toolChoice: { mode: 'function', name: 'lookup_weather' },
      attachments: [],
      output: {
        mode: 'text',
        stream: true,
        structured: {
          type: 'json_schema',
          name: 'answer',
          schema: { type: 'object', properties: { summary: { type: 'string' } } },
          strict: true,
        },
      },
      diagnostics: { ignoredParameters: [] },
    });
  });

  it('normalizes message arrays, image/file inputs, function calls, and function outputs', () => {
    const result = normalize({
      model: 'chatgpt-web',
      input: [
        { role: 'system', content: 'System rule' },
        { role: 'developer', content: 'Developer rule' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect these' },
            {
              type: 'input_image',
              image_url: 'https://example.com/a.png',
              detail: 'high',
            },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_image', file_id: 'file_image_1' },
            { type: 'input_file', file_id: 'file_123' },
            { type: 'input_file', file_data: 'QUJD', filename: 'notes.txt' },
          ],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup_weather',
          arguments: '{"city":"Tokyo"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'Sunny' },
        { role: 'assistant', content: 'It is sunny.' },
      ],
    });

    expect(result.instructions).toEqual([
      { role: 'system', content: 'System rule' },
      { role: 'developer', content: 'Developer rule' },
    ]);
    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect these' },
          { type: 'attachment', attachmentId: 'attachment-1' },
          { type: 'attachment', attachmentId: 'attachment-2' },
          { type: 'attachment', attachmentId: 'attachment-3' },
          { type: 'attachment', attachmentId: 'attachment-4' },
          { type: 'attachment', attachmentId: 'attachment-5' },
        ],
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            id: 'call_1',
            name: 'lookup_weather',
            arguments: '{"city":"Tokyo"}',
          },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'Sunny' }],
        toolCallId: 'call_1',
      },
      { role: 'assistant', content: [{ type: 'text', text: 'It is sunny.' }] },
    ]);
    expect(result.attachments).toHaveLength(5);
    expect(result.attachments[2]).toEqual({
      id: 'attachment-3',
      kind: 'image',
      source: { type: 'file_id', fileId: 'file_image_1' },
    });
    expect(result.diagnostics.ignoredParameters).toEqual(['image_detail']);
  });

  it('records accepted-but-ignored parameters and uses conservative defaults', () => {
    const result = normalize({
      model: 'chatgpt-web',
      input: 'Hello',
      temperature: 0.3,
      top_p: 0.9,
      seed: 42,
      max_output_tokens: 100,
    });

    expect(result.output).toEqual({ mode: 'text', stream: false });
    expect(result.toolChoice).toEqual({ mode: 'auto' });
    expect(result.diagnostics.ignoredParameters).toEqual([
      'temperature',
      'top_p',
      'seed',
      'max_output_tokens',
    ]);
  });

  it.each(['logprobs', 'logit_bias'] as const)('rejects unsupported %s', (param) => {
    const request = {
      model: 'chatgpt-web',
      input: 'Hello',
      [param]: param === 'logprobs' ? false : {},
    } as ResponsesRequest;

    expect(() => normalize(request)).toThrow(UnsupportedParameterError);
    expect(() => normalize(request)).toThrow(param);
  });
});
