import type { FastifyInstance } from 'fastify';

import { encodeResponse } from '../encode/responses.js';
import type { NormalizedExecutionHandler } from '../execution.js';
import { normalizeResponses } from '../normalize/responses.js';
import { conversationKeyFromRequest } from '../request-meta.js';
import { ResponsesRequestSchema, type ResponsesRequest } from '../schemas/responses.js';

export function registerResponsesRoute(
  app: FastifyInstance,
  execute: NormalizedExecutionHandler,
): void {
  app.post<{ Body: ResponsesRequest }>(
    '/v1/responses',
    { schema: { body: ResponsesRequestSchema } },
    async (request) => {
      const result = await execute(
        normalizeResponses(request.body, {
          requestId: String(request.id),
          conversationKey: conversationKeyFromRequest(request),
        }),
      );
      return encodeResponse(result);
    },
  );
}
