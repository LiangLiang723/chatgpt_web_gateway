import { randomUUID } from 'node:crypto';

import type { TextStreamEvent } from '../../stream/events.js';
import type { EncodedSseFrame } from './chat-completions-stream.js';

export interface ResponsesStreamEncoderOptions {
  responseId?: string;
  messageId?: string;
  createdAt?: number;
}

export interface ResponsesStreamErrorPayload {
  message: string;
  code: string | null;
  param: string | null;
}

export function createResponsesStreamEncoder(options: ResponsesStreamEncoderOptions = {}) {
  const responseId = options.responseId ?? `resp_${randomUUID()}`;
  const messageId = options.messageId ?? `msg_${randomUUID()}`;
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  let sequenceNumber = 0;

  const frame = (event: string, body: Record<string, unknown>): EncodedSseFrame => {
    sequenceNumber += 1;
    return {
      event,
      data: JSON.stringify({
        type: event,
        ...body,
        sequence_number: sequenceNumber,
      }),
    };
  };

  const inProgressResponse = () => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    completed_at: null,
    status: 'in_progress',
    error: null,
    incomplete_details: null,
    model: 'chatgpt-web',
    output: [],
    usage: null,
  });

  const completedResponse = (text: string, completedAt: number) => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    completed_at: Math.floor(completedAt / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: 'chatgpt-web',
    output: [
      {
        id: messageId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: null,
  });

  return {
    encode(event: TextStreamEvent): EncodedSseFrame[] {
      if (event.type === 'started') {
        return [
          frame('response.created', { response: inProgressResponse() }),
          frame('response.in_progress', { response: inProgressResponse() }),
          frame('response.output_item.added', {
            output_index: 0,
            item: {
              id: messageId,
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            },
          }),
          frame('response.content_part.added', {
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          }),
        ];
      }

      if (event.type === 'text.delta') {
        return [
          frame('response.output_text.delta', {
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: event.delta,
          }),
        ];
      }

      const text = event.result.text;
      return [
        frame('response.output_text.done', {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text,
        }),
        frame('response.content_part.done', {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text, annotations: [] },
        }),
        frame('response.output_item.done', {
          output_index: 0,
          item: {
            id: messageId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        }),
        frame('response.completed', {
          response: completedResponse(text, event.result.completedAt),
        }),
      ];
    },
    encodeError(error: ResponsesStreamErrorPayload): EncodedSseFrame[] {
      return [
        frame('error', {
          code: error.code,
          message: error.message,
          param: error.param,
        }),
      ];
    },
  };
}
