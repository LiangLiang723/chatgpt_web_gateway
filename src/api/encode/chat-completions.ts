import { randomUUID } from 'node:crypto';

import type { NormalizedExecutionResult } from '../execution.js';

export interface ChatCompletionEncodeMeta {
  id?: string;
  created?: number;
}

export function encodeChatCompletion(
  result: NormalizedExecutionResult,
  meta: ChatCompletionEncodeMeta = {},
) {
  return {
    id: meta.id ?? `chatcmpl_${randomUUID()}`,
    object: 'chat.completion' as const,
    created: meta.created ?? Math.floor(Date.now() / 1000),
    model: 'chatgpt-web',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content: result.text,
        },
        finish_reason: 'stop' as const,
      },
    ],
  };
}
