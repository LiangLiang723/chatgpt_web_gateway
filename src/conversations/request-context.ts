import type { NormalizedMessage, NormalizedRequest } from '../api/normalized.js';
import { canonicalizeInstructions, canonicalizeText } from '../context/canonicalize.js';
import {
  hasMeaningfulCanonicalUserContent,
  type ResolvedAttachmentSemanticMap,
} from '../context/multimodal.js';
import type {
  CanonicalContentPart,
  CanonicalConversationRequest,
  CanonicalMessage,
} from '../context/types.js';
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

function canonicalizeRequestMessage(
  message: NormalizedMessage,
  resolved: ResolvedAttachmentSemanticMap,
): CanonicalMessage {
  const hasAttachment = message.content.some((part) => part.type === 'attachment');
  if (!hasAttachment) {
    return {
      role: message.role as 'user' | 'assistant',
      text: canonicalizeText(
        message.content.map((part) => (part.type === 'text' ? part.text : '')),
      ),
    };
  }

  const content: CanonicalContentPart[] = [];
  let pendingText: string[] = [];
  const flushText = (): void => {
    if (pendingText.length === 0) return;
    content.push({ type: 'text', text: canonicalizeText(pendingText) });
    pendingText = [];
  };

  for (const part of message.content) {
    if (part.type === 'text') {
      pendingText.push(part.text);
      continue;
    }
    flushText();
    const semantic = resolved.get(part.attachmentId);
    if (!semantic) throw new Error(`Missing resolved attachment semantic: ${part.attachmentId}`);
    content.push({
      type: 'attachment',
      reference: part.attachmentId,
      kind: semantic.kind,
      sha256: semantic.sha256,
      filename: semantic.filename,
      ...(semantic.mimeType === undefined ? {} : { mimeType: semantic.mimeType }),
    });
  }
  flushText();

  return { role: message.role as 'user' | 'assistant', content };
}

function canonicalConversationRequest(
  request: NormalizedRequest,
  phase: RequestPhase,
  resolvedAttachments?: ResolvedAttachmentSemanticMap,
): CanonicalConversationRequest {
  if (request.output.mode !== 'text') unsupported(phase, `${phase} only supports text output`);
  if (phase === 'phase4' && request.output.stream) {
    unsupported(phase, 'Streaming is not available in Phase 4');
  }
  const attachmentsEnabled = resolvedAttachments !== undefined;
  if (request.attachments.length > 0 && !attachmentsEnabled) {
    unsupported(phase, 'Attachments are not available yet');
  }
  if (request.tools.length > 0) unsupported(phase, 'Tools are not available yet');
  if (request.toolChoice.mode !== 'auto') unsupported(phase, 'Tool choice is not available yet');
  if (request.output.structured !== undefined) {
    unsupported(phase, 'Structured output execution is not available yet');
  }

  const messages: CanonicalMessage[] = request.messages.map((message) => {
    if (message.role === 'tool') unsupported(phase, 'Tool messages are not available yet');
    if (message.toolCallId !== undefined || (message.toolCalls?.length ?? 0) > 0) {
      unsupported(phase, 'Tool calls are not available yet');
    }
    if (message.content.some((part) => part.type !== 'text') && !attachmentsEnabled) {
      unsupported(phase, 'Attachment content parts are not available yet');
    }
    try {
      return canonicalizeRequestMessage(message, resolvedAttachments ?? new Map());
    } catch {
      return invalid(phase, 'Attachment content could not be resolved');
    }
  });

  const last = messages.at(-1);
  if (!last || last.role !== 'user') {
    invalid(phase, 'Conversation request must end with a user message');
  }
  if (!hasMeaningfulCanonicalUserContent(last)) {
    invalid(phase, 'Final user message must contain text or an attachment');
  }

  return {
    instructions: canonicalizeInstructions(request.instructions),
    messages,
    mode: messages.length === 1 ? 'incremental' : 'full',
  };
}

export function toCanonicalConversationRequest(
  request: NormalizedRequest,
  resolvedAttachments?: ResolvedAttachmentSemanticMap,
): CanonicalConversationRequest {
  return canonicalConversationRequest(request, 'phase4', resolvedAttachments);
}

export function toCanonicalStreamingConversationRequest(
  request: NormalizedRequest,
  resolvedAttachments?: ResolvedAttachmentSemanticMap,
): CanonicalConversationRequest {
  if (!request.output.stream) {
    throw new Phase5ExecutionError(
      'invalid_conversation_request',
      'Streaming execution requires output.stream=true',
    );
  }
  return canonicalConversationRequest(request, 'phase5', resolvedAttachments);
}
