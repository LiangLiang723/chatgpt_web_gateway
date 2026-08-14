import type { FastifyInstance } from 'fastify';

import { encodeChatCompletion } from '../encode/chat-completions.js';
import type { NormalizedExecutionHandler } from '../execution.js';
import { normalizeChatCompletions } from '../normalize/chat-completions.js';
import { conversationKeyFromRequest } from '../request-meta.js';
import {
  ChatCompletionsRequestSchema,
  type ChatCompletionsRequest,
} from '../schemas/chat-completions.js';

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  execute: NormalizedExecutionHandler,
): void {
  app.post<{ Body: ChatCompletionsRequest }>(
    '/v1/chat/completions',
    { schema: { body: ChatCompletionsRequestSchema } },
    async (request) => {
      const result = await execute(
        normalizeChatCompletions(request.body, {
          requestId: String(request.id),
          conversationKey: conversationKeyFromRequest(request),
        }),
      );
      return encodeChatCompletion(result);
    },
  );
}
