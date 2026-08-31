import { describe, expect, it } from 'vitest';

import { encodeChatCompletion } from '../../src/api/encode/chat-completions.js';
import { encodeResponse } from '../../src/api/encode/responses.js';
import type { NormalizedExecutionResult } from '../../src/api/execution.js';

const textResult: NormalizedExecutionResult = {
  type: 'text',
  text: 'hello',
  conversationUrl: 'https://chatgpt.com/c/test',
  completedAt: 1_786_720_001_234,
};

const toolResult: NormalizedExecutionResult = {
  type: 'tool_calls',
  toolCalls: [
    { id: 'call_a', name: 'weather', arguments: '{"city":"Tokyo"}' },
    { id: 'call_b', name: 'clock', arguments: '{"zone":"UTC"}' },
  ],
  conversationUrl: 'https://chatgpt.com/c/test',
  completedAt: 1_786_720_001_234,
};

const customToolResult: NormalizedExecutionResult = {
  type: 'tool_calls',
  toolCalls: [
    {
      id: 'call_patch',
      name: '__responses_custom__::apply_patch',
      arguments: '{"input":"*** Begin Patch\\n*** End Patch"}',
    },
  ],
  conversationUrl: 'https://chatgpt.com/c/test',
  completedAt: 1_786_720_001_234,
};

const namespacedToolResult: NormalizedExecutionResult = {
  type: 'tool_calls',
  toolCalls: [
    {
      id: 'call_namespace',
      name: 'multi_agent_v1::spawn_agent',
      arguments: '{"task":"inspect"}',
    },
  ],
  conversationUrl: 'https://chatgpt.com/c/test',
  completedAt: 1_786_720_001_234,
};

describe('response encoders', () => {
  it('encodes a non-streaming Chat Completion without fabricated token usage', () => {
    expect(
      encodeChatCompletion(textResult, {
        id: 'chatcmpl_test',
        created: 1_786_720_000,
      }),
    ).toEqual({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: 1_786_720_000,
      model: 'chatgpt-web',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
    });
  });

  it('encodes Chat Completions function tool calls with content null', () => {
    expect(encodeChatCompletion(toolResult, { id: 'chatcmpl_tool', created: 123 })).toEqual({
      id: 'chatcmpl_tool',
      object: 'chat.completion',
      created: 123,
      model: 'chatgpt-web',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_a',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":"Tokyo"}' },
              },
              {
                id: 'call_b',
                type: 'function',
                function: { name: 'clock', arguments: '{"zone":"UTC"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  });

  it('encodes a completed Responses text object with output_text and null usage', () => {
    expect(
      encodeResponse(textResult, {
        id: 'resp_test',
        messageId: 'msg_test',
        createdAt: 1_786_720_000,
        completedAt: 1_786_720_001,
      }),
    ).toEqual({
      id: 'resp_test',
      object: 'response',
      created_at: 1_786_720_000,
      completed_at: 1_786_720_001,
      status: 'completed',
      error: null,
      incomplete_details: null,
      model: 'chatgpt-web',
      output: [
        {
          id: 'msg_test',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello', annotations: [] }],
        },
      ],
      usage: null,
    });
  });

  it('restores Codex custom tool calls from the internal function bridge', () => {
    expect(
      encodeResponse(customToolResult, {
        id: 'resp_custom',
        functionCallIds: ['ctc_patch'],
        createdAt: 100,
        completedAt: 101,
      }).output,
    ).toEqual([
      {
        id: 'ctc_patch',
        type: 'custom_tool_call',
        call_id: 'call_patch',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch',
        status: 'completed',
      },
    ]);
  });

  it('restores Codex namespace metadata in Responses function calls', () => {
    expect(
      encodeResponse(namespacedToolResult, {
        id: 'resp_namespace',
        functionCallIds: ['fc_namespace'],
        createdAt: 100,
        completedAt: 101,
      }).output,
    ).toEqual([
      {
        id: 'fc_namespace',
        type: 'function_call',
        call_id: 'call_namespace',
        namespace: 'multi_agent_v1',
        name: 'spawn_agent',
        arguments: '{"task":"inspect"}',
        status: 'completed',
      },
    ]);
  });

  it('encodes Responses function_call output items with stable call ids', () => {
    expect(
      encodeResponse(toolResult, {
        id: 'resp_tool',
        functionCallIds: ['fc_a', 'fc_b'],
        createdAt: 100,
        completedAt: 101,
      }),
    ).toEqual({
      id: 'resp_tool',
      object: 'response',
      created_at: 100,
      completed_at: 101,
      status: 'completed',
      error: null,
      incomplete_details: null,
      model: 'chatgpt-web',
      output: [
        {
          id: 'fc_a',
          type: 'function_call',
          call_id: 'call_a',
          name: 'weather',
          arguments: '{"city":"Tokyo"}',
          status: 'completed',
        },
        {
          id: 'fc_b',
          type: 'function_call',
          call_id: 'call_b',
          name: 'clock',
          arguments: '{"zone":"UTC"}',
          status: 'completed',
        },
      ],
      usage: null,
    });
  });
});
