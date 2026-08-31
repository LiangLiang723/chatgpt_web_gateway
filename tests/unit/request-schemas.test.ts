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

  it('accepts Pi single-text-object user content without weakening message roles', () => {
    expect(
      validateChat({
        model: 'chatgpt-web',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: { type: 'text', text: '你好' } },
        ],
      }),
    ).toBe(true);
  });

  it('accepts Cherry Studio and OpenAI-compatible agent metadata without weakening message roles', () => {
    expect(
      validateChat({
        model: 'chatgpt-web',
        messages: [
          { role: 'user', content: '你是谁' },
          {
            role: 'assistant',
            content: '我是 ChatGPT。',
            reasoning_content: '',
            reasoning: 'cross-model reasoning replay',
            reasoning_text: 'cross-model reasoning text replay',
          },
          { role: 'user', content: '继续' },
        ],
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        reasoning_effort: 'high',
        parallel_tool_calls: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              description: 'Run a command',
              parameters: { type: 'object', properties: {} },
              strict: false,
            },
          },
        ],
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

  it('accepts the current Codex Responses compatibility shape', () => {
    expect(
      validateResponses({
        model: 'chatgpt-web',
        instructions: 'Use tools when useful.',
        input: [
          {
            type: 'message',
            id: 'msg_developer',
            role: 'developer',
            content: [{ type: 'input_text', text: 'Project instructions' }],
          },
          {
            type: 'message',
            id: 'msg_user',
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply only OK' }],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            description: 'Run a command',
            strict: false,
            parameters: { type: 'object', properties: {} },
          },
          {
            type: 'custom',
            name: 'apply_patch',
            description: 'Apply a patch',
            format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
          },
          {
            type: 'namespace',
            name: 'multi_agent_v1',
            description: 'Agent tools',
            tools: [
              {
                type: 'function',
                name: 'spawn_agent',
                description: 'Spawn an agent',
                strict: false,
                parameters: { type: 'object', properties: {} },
                output_schema: { type: 'object', properties: { id: { type: 'string' } } },
              },
              {
                type: 'custom',
                name: 'delegate_note',
                description: 'Send a freeform note',
              },
            ],
          },
          {
            type: 'tool_search',
            execution: 'client',
            description: 'Search deferred tools',
            parameters: { type: 'object', properties: {} },
          },
          {
            type: 'web_search',
            external_web_access: false,
            indexed_web_access: true,
            search_content_types: ['text'],
          },
        ],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { effort: 'low', summary: 'auto' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'codex-session',
        client_metadata: { session_id: 'codex-session' },
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
