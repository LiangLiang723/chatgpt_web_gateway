import { randomUUID } from 'node:crypto';

import type { NormalizedExecutionResult } from '../execution.js';

export interface ResponseEncodeMeta {
  id?: string;
  messageId?: string;
  createdAt?: number;
  completedAt?: number;
}

export function encodeResponse(result: NormalizedExecutionResult, meta: ResponseEncodeMeta = {}) {
  return {
    id: meta.id ?? `resp_${randomUUID()}`,
    object: 'response' as const,
    created_at: meta.createdAt ?? Math.floor(result.completedAt / 1000),
    completed_at: meta.completedAt ?? Math.floor(result.completedAt / 1000),
    status: 'completed' as const,
    error: null,
    incomplete_details: null,
    model: 'chatgpt-web',
    output: [
      {
        id: meta.messageId ?? `msg_${randomUUID()}`,
        type: 'message' as const,
        status: 'completed' as const,
        role: 'assistant' as const,
        content: [
          {
            type: 'output_text' as const,
            text: result.text,
            annotations: [],
          },
        ],
      },
    ],
    usage: null,
  };
}
