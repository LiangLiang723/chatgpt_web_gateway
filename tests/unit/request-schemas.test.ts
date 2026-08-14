import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

import { ChatCompletionsRequestSchema } from '../../src/api/schemas/chat-completions.js';
import { ResponsesRequestSchema } from '../../src/api/schemas/responses.js';

const ajv = new Ajv({ allErrors: true });
const validateChat = ajv.compile(ChatCompletionsRequestSchema);
const validateResponses = ajv.compile(ResponsesRequestSchema);

describe('OpenAI request schemas', () => {
  it('accepts the approved Chat Completions subset', () => {
    expect(
      validateChat({
        model: 'chatgpt-web',
        messages: [
          { role: 'system', content: 'Be concise.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image' },
              { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
              { type: 'file', file: { file_id: 'file_123' } },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        tool_choice: 'auto',
        response_format: { type: 'json_object' },
        logprobs: false,
      }),
    ).toBe(true);
  });

  it('rejects malformed Chat Completions messages', () => {
    expect(
      validateChat({
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }],
      }),
    ).toBe(false);
  });

  it('accepts the approved Responses input subset', () => {
    expect(
      validateResponses({
        model: 'chatgpt-web',
        instructions: 'Be concise.',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Read these inputs' },
              { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
              { type: 'input_file', file_data: 'QUJD', filename: 'notes.txt' },
            ],
          },
        ],
        stream: true,
        logit_bias: {},
      }),
    ).toBe(true);
  });

  it('rejects malformed Responses input parts and unknown top-level fields', () => {
    expect(
      validateResponses({
        model: 'chatgpt-web',
        input: [{ role: 'user', content: [{ type: 'input_image' }] }],
      }),
    ).toBe(false);

    expect(
      validateResponses({
        model: 'chatgpt-web',
        input: 'hello',
        completely_unknown: true,
      }),
    ).toBe(false);
  });
});
