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
