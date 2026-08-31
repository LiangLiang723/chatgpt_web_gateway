import { InvalidRequestError, UnsupportedParameterError } from '../errors.js';
import type {
  NormalizedContentPart,
  NormalizedInstruction,
  NormalizedMessage,
  NormalizedRequest,
} from '../normalized.js';
import type { ResponsesRequest } from '../schemas/responses.js';
import { encodeNamespacedToolName, encodeResponsesCustomToolName } from '../tool-namespace.js';
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

const ignoredRequestParameters = [
  'temperature',
  'top_p',
  'seed',
  'max_output_tokens',
  'parallel_tool_calls',
  'reasoning',
  'store',
  'stream_options',
  'include',
  'service_tier',
  'prompt_cache_key',
  'prompt_cache_retention',
  'client_metadata',
  'background',
  'metadata',
  'user',
  'previous_response_id',
  'truncation',
  'max_tool_calls',
  'safety_identifier',
  'top_logprobs',
  'provider',
  'providerOptions',
  'extra_body',
] as const;

type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
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
    if (part.type === 'input_text' || part.type === 'output_text') {
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

function normalizeFunctionOutput(
  output:
    | string
    | Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' }
        | { type: 'input_audio'; audio_url: string }
        | { type: 'encrypted_content'; encrypted_content: string }
      >,
  state: ReturnType<typeof createNormalizationState>,
): NormalizedContentPart[] {
  if (typeof output === 'string') return [{ type: 'text', text: output }];

  const normalized: NormalizedContentPart[] = [];
  for (const part of output) {
    if (part.type === 'input_text') {
      normalized.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'input_image') {
      normalized.push(addImageAttachment(state, part.image_url));
      continue;
    }
    throw new InvalidRequestError(
      `${part.type} function output is not supported by this Gateway`,
      'input',
    );
  }
  return normalized;
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
  if (request.text?.verbosity !== undefined) {
    state.ignoredParameters.push('text.verbosity');
  }

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
          toolCalls: [
            {
              id: item.call_id,
              name:
                item.namespace === undefined
                  ? item.name
                  : encodeNamespacedToolName(item.namespace, item.name),
              arguments: item.arguments,
            },
          ],
        });
        continue;
      }

      if (item.type === 'custom_tool_call') {
        messages.push({
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              id: item.call_id,
              name: encodeResponsesCustomToolName(item.name, item.namespace),
              arguments: JSON.stringify({ input: item.input }),
            },
          ],
        });
        continue;
      }

      messages.push({
        role: 'tool',
        content: normalizeFunctionOutput(item.output, state),
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
    tools: normalizeResponsesTools(request.tools, state),
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
