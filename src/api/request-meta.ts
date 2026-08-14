import type { FastifyRequest } from 'fastify';

import { InvalidRequestError } from './errors.js';

export function conversationKeyFromRequest(request: FastifyRequest): string | undefined {
  const value = request.headers['x-conversation-key'];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    throw new InvalidRequestError(
      'X-Conversation-Key must be a single header value',
      'X-Conversation-Key',
    );
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new InvalidRequestError('X-Conversation-Key must be non-empty', 'X-Conversation-Key');
  }
  return normalized;
}
