import { InvalidRequestError, UnsupportedParameterError } from '../errors.js';
import type {
  NormalizedContentPart,
  NormalizedInstruction,
  NormalizedMessage,
  NormalizedRequest,
} from '../normalized.js';
import type { ResponsesRequest } from '../schemas/responses.js';
import {
  addBase64FileAttachment,
  addFileIdAttachment,
  addImageAttachment,
  addImageFileIdAttachment,
  createNormalizationState,
  normalizeResponsesStructuredOutput,
  normalizeResponsesToolChoice,
  normalizeResponsesTools,
  recordIgnoredParameters,
} from './common.js';
import type { RequestNormalizationMeta } from './chat-completions.js';

const ignoredRequestParameters = ['temperature', 'top_p', 'seed', 'max_output_tokens'] as const;

type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'input_image'; file_id: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'input_file'; file_id: string; filename?: string }
  | { type: 'input_file'; file_data: string; filename?: string };

function recordImageDetail(
  state: ReturnType<typeof createNormalizationState>,
  detail: unknown,
): void {
  if (detail !== undefined && !state.ignoredParameters.includes('image_detail')) {
    state.ignoredParameters.push('image_detail');
  }
}

function normalizeContentParts(
  content: string | ResponsesContentPart[],
  state: ReturnType<typeof createNormalizationState>,
): NormalizedContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];

  const normalized: NormalizedContentPart[] = [];
  for (const part of content) {
    if (part.type === 'input_text') {
      normalized.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'input_image') {
      recordImageDetail(state, part.detail);
      if ('image_url' in part) {
        normalized.push(addImageAttachment(state, part.image_url));
      } else {
        normalized.push(addImageFileIdAttachment(state, part.file_id));
      }
      continue;
    }

    if ('file_id' in part) {
      normalized.push(addFileIdAttachment(state, part.file_id));
    } else {
      normalized.push(addBase64FileAttachment(state, part.file_data, part.filename));
    }
  }
  return normalized;
}

function normalizeInstructionContent(content: string | ResponsesContentPart[]): string {
  if (typeof content === 'string') return content;
  if (content.some((part) => part.type !== 'input_text')) {
    throw new InvalidRequestError(
      'System and developer messages only support text content in Phase 1',
      'input',
    );
  }
  return content.map((part) => (part.type === 'input_text' ? part.text : '')).join('\n');
}

export function normalizeResponses(
  request: ResponsesRequest,
  meta: RequestNormalizationMeta,
): NormalizedRequest {
  if (request.logprobs !== undefined) {
    throw new UnsupportedParameterError('logprobs');
  }
  if (request.logit_bias !== undefined) {
    throw new UnsupportedParameterError('logit_bias');
  }

  const state = createNormalizationState();
  const instructions: NormalizedInstruction[] = [];
  const messages: NormalizedMessage[] = [];

  recordIgnoredParameters(
    state,
    request as unknown as Record<string, unknown>,
    ignoredRequestParameters,
  );

  if (request.instructions !== undefined) {
    instructions.push({ role: 'developer', content: request.instructions });
  }

  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: [{ type: 'text', text: request.input }] });
  } else {
    for (const item of request.input) {
      if ('role' in item) {
        const content = item.content as string | ResponsesContentPart[];
        if (item.role === 'system' || item.role === 'developer') {
          instructions.push({ role: item.role, content: normalizeInstructionContent(content) });
          continue;
        }
        messages.push({ role: item.role, content: normalizeContentParts(content, state) });
        continue;
      }

      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: [],
          toolCalls: [{ id: item.call_id, name: item.name, arguments: item.arguments }],
        });
        continue;
      }

      messages.push({
        role: 'tool',
        content: [{ type: 'text', text: item.output }],
        toolCallId: item.call_id,
      });
    }
  }

  const structured = normalizeResponsesStructuredOutput(request.text?.format);

  return {
    requestId: meta.requestId,
    ...(meta.conversationKey === undefined ? {} : { conversationKey: meta.conversationKey }),
    instructions,
    messages,
    tools: normalizeResponsesTools(request.tools),
    toolChoice: normalizeResponsesToolChoice(request.tool_choice),
    attachments: state.attachments,
    output: {
      mode: 'text',
      stream: request.stream ?? false,
      ...(structured === undefined ? {} : { structured }),
    },
    diagnostics: {
      ignoredParameters: state.ignoredParameters,
    },
  };
}
