import { randomUUID } from 'node:crypto';

import type { ExecutionStreamEvent } from '../../stream/events.js';

export interface EncodedSseFrame {
  event?: string;
  data: string;
}

export interface ChatCompletionsStreamEncoderOptions {
  id?: string;
  created?: number;
}

export interface StreamErrorPayload {
  message: string;
  type: string;
  param: string | null;
  code: string | null;
}

export function createChatCompletionsStreamEncoder(
  options: ChatCompletionsStreamEncoderOptions = {},
) {
  const id = options.id ?? `chatcmpl_${randomUUID()}`;
  const created = options.created ?? Math.floor(Date.now() / 1000);

  const chunk = (choice: unknown): EncodedSseFrame => ({
    data: JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: 'chatgpt-web',
      choices: [choice],
    }),
  });

  return {
    encode(event: ExecutionStreamEvent): EncodedSseFrame[] {
      if (event.type === 'started') {
        return [
          chunk({
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          }),
        ];
      }
      if (event.type === 'text.delta') {
        return [
          chunk({
            index: 0,
            delta: { content: event.delta },
            finish_reason: null,
          }),
        ];
      }
      if (event.type === 'tool_calls') {
        return [
          chunk({
            index: 0,
            delta: {
              tool_calls: event.toolCalls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            },
            finish_reason: null,
          }),
        ];
      }
      return [
        chunk({
          index: 0,
          delta: {},
          finish_reason: event.result.type === 'tool_calls' ? 'tool_calls' : 'stop',
        }),
        { data: '[DONE]' },
      ];
    },
    encodeError(error: StreamErrorPayload): EncodedSseFrame[] {
      return [{ data: JSON.stringify({ error }) }];
    },
  };
}
