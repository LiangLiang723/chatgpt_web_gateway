import type { FastifyInstance } from 'fastify';

import { createResponsesStreamEncoder } from '../encode/responses-stream.js';
import { encodeResponse } from '../encode/responses.js';
import type {
  NormalizedExecutionHandler,
  NormalizedStreamingExecutionHandler,
} from '../execution.js';
import { normalizeResponses } from '../normalize/responses.js';
import { conversationKeyFromRequest } from '../request-meta.js';
import { ResponsesRequestSchema, type ResponsesRequest } from '../schemas/responses.js';
import { runStreamingResponse } from '../streaming-response.js';

export function registerResponsesRoute(
  app: FastifyInstance,
  execute: NormalizedExecutionHandler,
  stream: NormalizedStreamingExecutionHandler,
): void {
  app.post<{ Body: ResponsesRequest }>(
    '/v1/responses',
    { schema: { body: ResponsesRequestSchema } },
    async (request, reply) => {
      const normalized = normalizeResponses(request.body, {
        requestId: String(request.id),
        conversationKey: conversationKeyFromRequest(request),
      });

      if (!normalized.output.stream) {
        return encodeResponse(await execute(normalized));
      }

      const encoder = createResponsesStreamEncoder();
      await runStreamingResponse({
        reply,
        request: normalized,
        stream,
        encodeEvent: encoder.encode,
        encodeError: (error) =>
          encoder.encodeError({
            message: error.message,
            code: error.code,
            param: error.param,
          }),
      });
    },
  );
}
