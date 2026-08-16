import type { FastifyInstance } from 'fastify';

import { createChatCompletionsStreamEncoder } from '../encode/chat-completions-stream.js';
import { encodeChatCompletion } from '../encode/chat-completions.js';
import type {
  NormalizedExecutionHandler,
  NormalizedStreamingExecutionHandler,
} from '../execution.js';
import { normalizeChatCompletions } from '../normalize/chat-completions.js';
import { conversationKeyFromRequest } from '../request-meta.js';
import {
  ChatCompletionsRequestSchema,
  type ChatCompletionsRequest,
} from '../schemas/chat-completions.js';
import { runStreamingResponse } from '../streaming-response.js';

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  execute: NormalizedExecutionHandler,
  stream: NormalizedStreamingExecutionHandler,
): void {
  app.post<{ Body: ChatCompletionsRequest }>(
    '/v1/chat/completions',
    { schema: { body: ChatCompletionsRequestSchema } },
    async (request, reply) => {
      const normalized = normalizeChatCompletions(request.body, {
        requestId: String(request.id),
        conversationKey: conversationKeyFromRequest(request),
      });

      if (!normalized.output.stream) {
        return encodeChatCompletion(await execute(normalized));
      }

      const encoder = createChatCompletionsStreamEncoder();
      await runStreamingResponse({
        reply,
        request: normalized,
        stream,
        encodeEvent: encoder.encode,
        encodeError: (error) => encoder.encodeError(error),
      });
    },
  );
}
