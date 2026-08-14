import { UnsupportedParameterError } from '../errors.js';
import type {
  NormalizedContentPart,
  NormalizedInstruction,
  NormalizedMessage,
  NormalizedRequest,
} from '../normalized.js';
import type { ChatCompletionsRequest } from '../schemas/chat-completions.js';
import {
  addBase64FileAttachment,
  addFileIdAttachment,
  addImageAttachment,
  createNormalizationState,
  normalizeInstructionText,
  normalizeStructuredOutput,
  normalizeToolChoice,
  normalizeTools,
  recordIgnoredParameters,
} from './common.js';

export interface RequestNormalizationMeta {
  requestId: string;
  conversationKey?: string;
}

const ignoredRequestParameters = [
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'max_tokens',
  'max_completion_tokens',
] as const;

function textContent(
  content: string | Array<{ type: 'text'; text: string }>,
): NormalizedContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((part) => ({ type: 'text' as const, text: part.text }));
}

export function normalizeChatCompletions(
  request: ChatCompletionsRequest,
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

  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      instructions.push({
        role: message.role,
        content: normalizeInstructionText(message.content),
      });
      continue;
    }

    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        messages.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
        continue;
      }

      const content: NormalizedContentPart[] = [];
      for (const part of message.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
          continue;
        }

        if (part.type === 'image_url') {
          content.push(addImageAttachment(state, part.image_url.url));
          if (
            part.image_url.detail !== undefined &&
            !state.ignoredParameters.includes('image_detail')
          ) {
            state.ignoredParameters.push('image_detail');
          }
          continue;
        }

        if ('file_id' in part.file) {
          content.push(addFileIdAttachment(state, part.file.file_id));
        } else {
          content.push(addBase64FileAttachment(state, part.file.file_data, part.file.filename));
        }
      }
      messages.push({ role: 'user', content });
      continue;
    }

    if (message.role === 'assistant') {
      const normalized: NormalizedMessage = {
        role: 'assistant',
        content:
          message.content === undefined || message.content === null
            ? []
            : textContent(message.content),
      };
      if (message.tool_calls !== undefined) {
        normalized.toolCalls = message.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }));
      }
      messages.push(normalized);
      continue;
    }

    messages.push({
      role: 'tool',
      content: textContent(message.content),
      toolCallId: message.tool_call_id,
    });
  }

  const structured = normalizeStructuredOutput(request.response_format);

  return {
    requestId: meta.requestId,
    ...(meta.conversationKey === undefined ? {} : { conversationKey: meta.conversationKey }),
    instructions,
    messages,
    tools: normalizeTools(request.tools),
    toolChoice: normalizeToolChoice(request.tool_choice),
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
