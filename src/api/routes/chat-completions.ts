import type { FastifyInstance } from 'fastify';

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
    async (request) =>
      execute(
        normalizeChatCompletions(request.body, {
          requestId: String(request.id),
          conversationKey: conversationKeyFromRequest(request),
        }),
      ),
  );
}
