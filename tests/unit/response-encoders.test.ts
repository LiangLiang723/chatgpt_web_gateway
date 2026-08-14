import { describe, expect, it } from 'vitest';

import { encodeChatCompletion } from '../../src/api/encode/chat-completions.js';
import { encodeResponse } from '../../src/api/encode/responses.js';
import type { NormalizedExecutionResult } from '../../src/api/execution.js';

const result: NormalizedExecutionResult = {
  type: 'text',
  text: 'hello',
  conversationUrl: 'https://chatgpt.com/c/test',
  completedAt: 1_786_720_001_234,
};

describe('Phase 3 response encoders', () => {
  it('encodes a non-streaming Chat Completion without fabricated token usage', () => {
    expect(
      encodeChatCompletion(result, {
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

  it('encodes a completed Responses object with output_text and null usage', () => {
    expect(
      encodeResponse(result, {
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
});
