import { describe, expect, it } from 'vitest';

import { normalizeChatCompletions } from '../../src/api/normalize/chat-completions.js';
import { normalizeResponses } from '../../src/api/normalize/responses.js';

describe('normalizer semantic parity', () => {
  it('maps equivalent Chat Completions and Responses requests to the same internal meaning', () => {
    const chat = normalizeChatCompletions(
      {
        model: 'chatgpt-web',
        messages: [
          { role: 'developer', content: 'Be concise.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image' },
              { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
            ],
          },
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
        tool_choice: 'auto',
        response_format: { type: 'json_object' },
        stream: true,
      },
      { requestId: 'chat-request', conversationKey: 'conversation-1' },
    );

    const responses = normalizeResponses(
      {
        model: 'chatgpt-web',
        instructions: 'Be concise.',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe this image' },
              { type: 'input_image', image_url: 'https://example.com/cat.png' },
            ],
          },
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
        tool_choice: 'auto',
        text: { format: { type: 'json_object' } },
        stream: true,
      },
      { requestId: 'responses-request', conversationKey: 'conversation-1' },
    );

    expect({ ...chat, requestId: 'same' }).toEqual({ ...responses, requestId: 'same' });
  });
});
