import { randomUUID } from 'node:crypto';

import type { NormalizedToolCall } from '../normalized.js';
import type { ExecutionStreamEvent } from '../../stream/events.js';
import type { EncodedSseFrame } from './chat-completions-stream.js';

export interface ResponsesStreamEncoderOptions {
  responseId?: string;
  messageId?: string;
  functionCallIds?: string[];
  createdAt?: number;
}

export interface ResponsesStreamErrorPayload {
  message: string;
  code: string | null;
  param: string | null;
}

interface EncodedFunctionCallItem {
  id: string;
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}

export function createResponsesStreamEncoder(options: ResponsesStreamEncoderOptions = {}) {
  const responseId = options.responseId ?? `resp_${randomUUID()}`;
  const messageId = options.messageId ?? `msg_${randomUUID()}`;
  const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  let sequenceNumber = 0;
  let textItemStarted = false;
  let toolItems: EncodedFunctionCallItem[] = [];

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

  const textStartFrames = (): EncodedSseFrame[] => {
    if (textItemStarted) return [];
    textItemStarted = true;
    return [
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
  };

  const completedResponse = (output: unknown[], completedAt: number) => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    completed_at: Math.floor(completedAt / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: 'chatgpt-web',
    output,
    usage: null,
  });

  const encodeToolCalls = (calls: readonly NormalizedToolCall[]): EncodedSseFrame[] => {
    toolItems = calls.map((call, index) => ({
      id: options.functionCallIds?.[index] ?? `fc_${randomUUID()}`,
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    }));
    const frames: EncodedSseFrame[] = [];
    toolItems.forEach((item, outputIndex) => {
      frames.push(
        frame('response.output_item.added', {
          output_index: outputIndex,
          item: {
            ...item,
            arguments: '',
            status: 'in_progress',
          },
        }),
        frame('response.function_call_arguments.delta', {
          item_id: item.id,
          output_index: outputIndex,
          delta: item.arguments,
        }),
        frame('response.function_call_arguments.done', {
          item_id: item.id,
          output_index: outputIndex,
          arguments: item.arguments,
        }),
        frame('response.output_item.done', {
          output_index: outputIndex,
          item,
        }),
      );
    });
    return frames;
  };

  return {
    encode(event: ExecutionStreamEvent): EncodedSseFrame[] {
      if (event.type === 'started') {
        return [
          frame('response.created', { response: inProgressResponse() }),
          frame('response.in_progress', { response: inProgressResponse() }),
        ];
      }

      if (event.type === 'text.delta') {
        return [
          ...textStartFrames(),
          frame('response.output_text.delta', {
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: event.delta,
          }),
        ];
      }

      if (event.type === 'tool_calls') return encodeToolCalls(event.toolCalls);

      if (event.result.type === 'tool_calls') {
        const fallback = toolItems.length === 0 ? encodeToolCalls(event.result.toolCalls) : [];
        return [
          ...fallback,
          frame('response.completed', {
            response: completedResponse(toolItems, event.result.completedAt),
          }),
        ];
      }

      const text = event.result.text;
      const outputItem = {
        id: messageId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      };
      return [
        ...textStartFrames(),
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
          item: outputItem,
        }),
        frame('response.completed', {
          response: completedResponse([outputItem], event.result.completedAt),
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
