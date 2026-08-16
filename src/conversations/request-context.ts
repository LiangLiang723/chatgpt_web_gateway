import type { NormalizedRequest } from '../api/normalized.js';
import { canonicalizeInstructions, canonicalizeText } from '../context/canonicalize.js';
import type { CanonicalConversationRequest, CanonicalTextMessage } from '../context/types.js';
import { Phase4ExecutionError, Phase5ExecutionError } from './errors.js';

type RequestPhase = 'phase4' | 'phase5';

function unsupported(phase: RequestPhase, message: string): never {
  if (phase === 'phase5') throw new Phase5ExecutionError('unsupported_phase5_request', message);
  throw new Phase4ExecutionError('unsupported_phase4_request', message);
}

function invalid(phase: RequestPhase, message: string): never {
  if (phase === 'phase5') throw new Phase5ExecutionError('invalid_conversation_request', message);
  throw new Phase4ExecutionError('invalid_conversation_request', message);
}

function canonicalConversationRequest(
  request: NormalizedRequest,
  phase: RequestPhase,
): CanonicalConversationRequest {
  if (request.output.mode !== 'text') unsupported(phase, `${phase} only supports text output`);
  if (phase === 'phase4' && request.output.stream) {
    unsupported(phase, 'Streaming is not available in Phase 4');
  }
  if (request.attachments.length > 0) unsupported(phase, 'Attachments are not available yet');
  if (request.tools.length > 0) unsupported(phase, 'Tools are not available yet');
  if (request.toolChoice.mode !== 'auto') unsupported(phase, 'Tool choice is not available yet');
  if (request.output.structured !== undefined) {
    unsupported(phase, 'Structured output execution is not available yet');
  }

  const messages: CanonicalTextMessage[] = request.messages.map((message) => {
    if (message.role === 'tool') unsupported(phase, 'Tool messages are not available yet');
    if (message.toolCallId !== undefined || (message.toolCalls?.length ?? 0) > 0) {
      unsupported(phase, 'Tool calls are not available yet');
    }
    if (message.content.some((part) => part.type !== 'text')) {
      unsupported(phase, 'Attachment content parts are not available yet');
    }
    return {
      role: message.role,
      text: canonicalizeText(
        message.content.map((part) => (part.type === 'text' ? part.text : '')),
      ),
    };
  });

  const last = messages.at(-1);
  if (!last || last.role !== 'user') {
    invalid(phase, 'Conversation request must end with a user message');
  }
  if (last.text.trim().length === 0) {
    invalid(phase, 'Final user message must be non-empty');
  }

  return {
    instructions: canonicalizeInstructions(request.instructions),
    messages,
    mode: messages.length === 1 ? 'incremental' : 'full',
  };
}

export function toCanonicalConversationRequest(
  request: NormalizedRequest,
): CanonicalConversationRequest {
  return canonicalConversationRequest(request, 'phase4');
}

export function toCanonicalStreamingConversationRequest(
  request: NormalizedRequest,
): CanonicalConversationRequest {
  if (!request.output.stream) {
    throw new Phase5ExecutionError(
      'invalid_conversation_request',
      'Streaming execution requires output.stream=true',
    );
  }
  return canonicalConversationRequest(request, 'phase5');
}
