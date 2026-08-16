import { randomUUID } from 'node:crypto';

import type { TextStreamEvent } from '../../stream/events.js';

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
    encode(event: TextStreamEvent): EncodedSseFrame[] {
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
      return [
        chunk({
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }),
        { data: '[DONE]' },
      ];
    },
    encodeError(error: StreamErrorPayload): EncodedSseFrame[] {
      return [{ data: JSON.stringify({ error }) }];
    },
  };
}
