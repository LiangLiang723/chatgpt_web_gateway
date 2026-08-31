import { describe, expect, it } from 'vitest';

import { UnsupportedParameterError } from '../../src/api/errors.js';
import { normalizeChatCompletions } from '../../src/api/normalize/chat-completions.js';
import type { ChatCompletionsRequest } from '../../src/api/schemas/chat-completions.js';

function normalize(request: ChatCompletionsRequest) {
  return normalizeChatCompletions(request, {
    requestId: 'req-chat-1',
    conversationKey: 'conversation-123',
  });
}

describe('normalizeChatCompletions', () => {
  it('normalizes instructions, multi-turn messages, tools, structured output, and stream metadata', () => {
    const result = normalize({
      model: 'chatgpt-web',
      messages: [
        { role: 'system', content: 'System rule' },
        { role: 'developer', content: [{ type: 'text', text: 'Developer rule' }] },
        { role: 'user', content: 'Find the weather' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
        { role: 'assistant', content: 'It is sunny.' },
      ],
      tools: [
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
      ],
      tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'weather_answer',
          schema: { type: 'object', properties: { summary: { type: 'string' } } },
          strict: true,
        },
      },
      stream: true,
    });

    expect(result).toEqual({
      requestId: 'req-chat-1',
      conversationKey: 'conversation-123',
      instructions: [
        { role: 'system', content: 'System rule' },
        { role: 'developer', content: 'Developer rule' },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Find the weather' }] },
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
      ],
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
          name: 'weather_answer',
          schema: { type: 'object', properties: { summary: { type: 'string' } } },
          strict: true,
        },
      },
      diagnostics: { ignoredParameters: [] },
    });
  });

  it('normalizes image URLs, data URLs, file IDs, and base64 files without resolving them', () => {
    const result = normalize({
      model: 'chatgpt-web',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect these' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/a.png', detail: 'high' },
            },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAAA' },
            },
            { type: 'file', file: { file_id: 'file_123' } },
            { type: 'file', file: { file_data: 'QUJD', filename: 'notes.txt' } },
          ],
        },
      ],
    });

    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect these' },
          { type: 'attachment', attachmentId: 'attachment-1' },
          { type: 'attachment', attachmentId: 'attachment-2' },
          { type: 'attachment', attachmentId: 'attachment-3' },
          { type: 'attachment', attachmentId: 'attachment-4' },
        ],
      },
    ]);
    expect(result.attachments).toHaveLength(4);
    expect(result.diagnostics.ignoredParameters).toEqual(['image_detail']);
  });

  it('drops Cherry reasoning history metadata and agent compatibility parameters at the adapter boundary', () => {
    const result = normalize({
      model: 'chatgpt-web',
      messages: [
        { role: 'user', content: '你是谁' },
        {
          role: 'assistant',
          content: '我是 ChatGPT。',
          reasoning_content: '',
          reasoning_details: [],
        },
        { role: 'user', content: '继续' },
      ],
      store: false,
      reasoning_effort: 'high',
      parallel_tool_calls: true,
      service_tier: 'auto',
      stop: ['END'],
      metadata: { client: 'openclaw' },
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: {} },
            strict: false,
          },
        },
      ],
    } as unknown as ChatCompletionsRequest);

    expect(result.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '你是谁' }] },
      { role: 'assistant', content: [{ type: 'text', text: '我是 ChatGPT。' }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ]);
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'exec_command',
        parameters: { type: 'object', properties: {} },
      },
    ]);
    expect(result.diagnostics.ignoredParameters).toEqual([
      'store',
      'reasoning_effort',
      'parallel_tool_calls',
      'service_tier',
      'stop',
      'metadata',
    ]);
  });

  it('uses conservative defaults and records accepted-but-ignored parameters', () => {
    const result = normalize({
      model: 'chatgpt-web',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.3,
      top_p: 0.9,
      presence_penalty: 0.2,
      frequency_penalty: 0.1,
      seed: 42,
      max_tokens: 100,
      max_completion_tokens: 80,
    });

    expect(result.output).toEqual({ mode: 'text', stream: false });
    expect(result.toolChoice).toEqual({ mode: 'auto' });
    expect(result.diagnostics.ignoredParameters).toEqual([
      'temperature',
      'top_p',
      'presence_penalty',
      'frequency_penalty',
      'seed',
      'max_tokens',
      'max_completion_tokens',
    ]);
  });

  it.each(['logprobs', 'logit_bias'] as const)('rejects unsupported %s', (param) => {
    const request = {
      model: 'chatgpt-web',
      messages: [{ role: 'user', content: 'Hello' }],
      [param]: param === 'logprobs' ? false : {},
    } as ChatCompletionsRequest;

    expect(() => normalize(request)).toThrow(UnsupportedParameterError);
    expect(() => normalize(request)).toThrow(param);
  });

  it('leaves conversationKey undefined when the caller provides none', () => {
    const result = normalizeChatCompletions(
      { model: 'chatgpt-web', messages: [{ role: 'user', content: 'Hello' }] },
      { requestId: 'req-chat-2' },
    );

    expect(result.requestId).toBe('req-chat-2');
    expect(result.conversationKey).toBeUndefined();
  });
});
