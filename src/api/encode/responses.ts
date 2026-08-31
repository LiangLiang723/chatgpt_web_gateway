import { randomUUID } from 'node:crypto';

import type { NormalizedExecutionResult } from '../execution.js';
import { decodeCustomToolInput, decodeResponsesToolName } from '../tool-namespace.js';

export interface ResponseEncodeMeta {
  id?: string;
  messageId?: string;
  functionCallIds?: string[];
  createdAt?: number;
  completedAt?: number;
}

export function encodeResponse(result: NormalizedExecutionResult, meta: ResponseEncodeMeta = {}) {
  const output =
    result.type === 'text'
      ? [
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
        ]
      : result.toolCalls.map((call, index) => {
          const decodedName = decodeResponsesToolName(call.name);
          if (decodedName.kind === 'custom') {
            return {
              id: meta.functionCallIds?.[index] ?? `ctc_${randomUUID()}`,
              type: 'custom_tool_call' as const,
              call_id: call.id,
              ...(decodedName.namespace === undefined ? {} : { namespace: decodedName.namespace }),
              name: decodedName.name,
              input: decodeCustomToolInput(call.arguments),
              status: 'completed' as const,
            };
          }
          return {
            id: meta.functionCallIds?.[index] ?? `fc_${randomUUID()}`,
            type: 'function_call' as const,
            call_id: call.id,
            ...(decodedName.namespace === undefined ? {} : { namespace: decodedName.namespace }),
            name: decodedName.name,
            arguments: call.arguments,
            status: 'completed' as const,
          };
        });

  return {
    id: meta.id ?? `resp_${randomUUID()}`,
    object: 'response' as const,
    created_at: meta.createdAt ?? Math.floor(result.completedAt / 1000),
    completed_at: meta.completedAt ?? Math.floor(result.completedAt / 1000),
    status: 'completed' as const,
    error: null,
    incomplete_details: null,
    model: 'chatgpt-web',
    output,
    usage: null,
  };
}
