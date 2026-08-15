import type { NormalizedRequest } from '../api/normalized.js';
import { canonicalizeInstructions, canonicalizeText } from '../context/canonicalize.js';
import type {
  CanonicalConversationRequest,
  CanonicalTextMessage,
} from '../context/types.js';
import { Phase4ExecutionError } from './errors.js';

function unsupported(message: string): never {
  throw new Phase4ExecutionError('unsupported_phase4_request', message);
}

function invalid(message: string): never {
  throw new Phase4ExecutionError('invalid_conversation_request', message);
}

export function toCanonicalConversationRequest(
  request: NormalizedRequest,
): CanonicalConversationRequest {
  if (request.output.mode !== 'text') unsupported('Phase 4 only supports text output');
  if (request.output.stream) unsupported('Streaming is not available in Phase 4');
  if (request.attachments.length > 0) unsupported('Attachments are not available in Phase 4');
  if (request.tools.length > 0) unsupported('Tools are not available in Phase 4');
  if (request.toolChoice.mode !== 'auto') unsupported('Tool choice is not available in Phase 4');
  if (request.output.structured !== undefined) {
    unsupported('Structured output execution is not available in Phase 4');
  }

  const messages: CanonicalTextMessage[] = request.messages.map((message) => {
    if (message.role === 'tool') unsupported('Tool messages are not available in Phase 4');
    if (message.toolCallId !== undefined || (message.toolCalls?.length ?? 0) > 0) {
      unsupported('Tool calls are not available in Phase 4');
    }
    if (message.content.some((part) => part.type !== 'text')) {
      unsupported('Attachment content parts are not available in Phase 4');
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
    invalid('Phase 4 Conversation request must end with a user message');
  }
  if (last.text.trim().length === 0) {
    invalid('Phase 4 final user message must be non-empty');
  }

  return {
    instructions: canonicalizeInstructions(request.instructions),
    messages,
    mode: messages.length === 1 ? 'incremental' : 'full',
  };
}
