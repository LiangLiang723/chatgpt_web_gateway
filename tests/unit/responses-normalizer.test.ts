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

  it('normalizes Codex function namespaces and filters server-only tools', () => {
    const result = normalize({
      model: 'chatgpt-web',
      instructions: 'Use tools when useful.',
      input: [
        {
          type: 'message',
          id: 'msg_user',
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect the repo' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          namespace: 'multi_agent_v1',
          name: 'spawn_agent',
          arguments: '{"task":"inspect"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'done',
        },
        {
          type: 'custom_tool_call',
          call_id: 'call_patch',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_patch',
          output: 'Done!',
        },
        {
          type: 'message',
          id: 'msg_assistant',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Finished.' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          strict: false,
          parameters: { type: 'object', properties: {} },
        },
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'Apply a patch',
        },
        {
          type: 'namespace',
          name: 'multi_agent_v1',
          description: 'Agent tools',
          tools: [
            {
              type: 'function',
              name: 'spawn_agent',
              strict: false,
              parameters: { type: 'object', properties: {} },
              output_schema: { type: 'object', properties: { id: { type: 'string' } } },
            },
            {
              type: 'custom',
              name: 'delegate_note',
              description: 'Send a note',
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
      parallel_tool_calls: true,
      reasoning: { effort: 'low', summary: 'auto' },
      store: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'codex-session',
      client_metadata: { session_id: 'codex-session' },
      stream: true,
    } as unknown as ResponsesRequest);

    expect(result.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Inspect the repo' }] },
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            id: 'call_1',
            name: 'multi_agent_v1::spawn_agent',
            arguments: '{"task":"inspect"}',
          },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'done' }],
        toolCallId: 'call_1',
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            id: 'call_patch',
            name: '__responses_custom__::apply_patch',
            arguments: '{"input":"*** Begin Patch\\n*** End Patch"}',
          },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'Done!' }],
        toolCallId: 'call_patch',
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }] },
    ]);
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'exec_command',
        parameters: { type: 'object', properties: {} },
      },
      {
        type: 'function',
        name: '__responses_custom__::apply_patch',
        description: 'Apply a patch',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'multi_agent_v1::spawn_agent',
        description: 'Agent tools / spawn_agent',
        parameters: { type: 'object', properties: {} },
      },
      {
        type: 'function',
        name: '__responses_custom__::multi_agent_v1::delegate_note',
        description: 'Send a note',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        },
      },
    ]);
    expect(result.diagnostics.ignoredParameters).toEqual([
      'parallel_tool_calls',
      'reasoning',
      'store',
      'include',
      'prompt_cache_key',
      'client_metadata',
      'tools.tool_search',
      'tools.web_search',
    ]);
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
