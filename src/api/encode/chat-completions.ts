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
  const message =
    result.type === 'text'
      ? {
          role: 'assistant' as const,
          content: result.text,
        }
      : {
          role: 'assistant' as const,
          content: null,
          tool_calls: result.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        };

  return {
    id: meta.id ?? `chatcmpl_${randomUUID()}`,
    object: 'chat.completion' as const,
    created: meta.created ?? Math.floor(Date.now() / 1000),
    model: 'chatgpt-web',
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.type === 'text' ? ('stop' as const) : ('tool_calls' as const),
      },
    ],
  };
}
