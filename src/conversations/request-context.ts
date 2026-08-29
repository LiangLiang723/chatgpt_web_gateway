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
import { validateStructuredOutputDefinition } from '../structured/output.js';
import { fingerprintTools, validateToolChoice } from '../tools/canonicalize.js';
import {
  Phase4ExecutionError,
  Phase5ExecutionError,
  Phase6ExecutionError,
  Phase7ExecutionError,
} from './errors.js';

type RequestPhase = 'phase4' | 'phase5' | 'phase6' | 'phase7';

function unsupported(phase: RequestPhase, message: string): never {
  if (phase === 'phase7') throw new Phase7ExecutionError('unsupported_phase7_request', message);
  if (phase === 'phase6') throw new Phase6ExecutionError('unsupported_phase6_request', message);
  if (phase === 'phase5') throw new Phase5ExecutionError('unsupported_phase5_request', message);
  throw new Phase4ExecutionError('unsupported_phase4_request', message);
}

function invalid(phase: RequestPhase, message: string): never {
  if (phase === 'phase7') throw new Phase7ExecutionError('invalid_conversation_request', message);
  if (phase === 'phase6') throw new Phase6ExecutionError('invalid_conversation_request', message);
  if (phase === 'phase5') throw new Phase5ExecutionError('invalid_conversation_request', message);
  throw new Phase4ExecutionError('invalid_conversation_request', message);
}

function canonicalToolMessage(message: NormalizedMessage, phase: RequestPhase): CanonicalMessage {
  if (message.role === 'tool') {
    if (!message.toolCallId || message.toolCallId.trim().length === 0) {
      return invalid(phase, 'Tool result must reference a non-empty tool_call_id');
    }
    return {
      role: 'tool',
      toolCallId: message.toolCallId,
      text: canonicalizeText(
        message.content.map((part) => (part.type === 'text' ? part.text : '')),
      ),
    };
  }

  const toolCalls = message.toolCalls ?? [];
  const seen = new Set<string>();
  return {
    role: 'assistant',
    text: canonicalizeText(message.content.map((part) => (part.type === 'text' ? part.text : ''))),
    toolCalls: toolCalls.map((call) => {
      if (call.id.trim().length === 0 || call.name.trim().length === 0) {
        return invalid(phase, 'Assistant tool call id and name must be non-empty');
      }
      if (seen.has(call.id))
        return invalid(phase, 'Assistant message contains duplicate tool call ids');
      seen.add(call.id);
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return invalid(phase, 'Assistant tool call arguments must encode a JSON object');
        }
      } catch {
        return invalid(phase, 'Assistant tool call arguments must be valid JSON');
      }
      return { externalCallId: call.id, name: call.name, arguments: call.arguments };
    }),
  };
}

function canonicalizeRequestMessage(
  message: NormalizedMessage,
  resolved: ResolvedAttachmentSemanticMap,
  phase: RequestPhase,
): CanonicalMessage {
  if (phase === 'phase7' && (message.role === 'tool' || (message.toolCalls?.length ?? 0) > 0)) {
    return canonicalToolMessage(message, phase);
  }

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

function validatePhase7Transcript(
  request: NormalizedRequest,
  messages: readonly CanonicalMessage[],
  phase: RequestPhase,
): void {
  const incrementalToolOnly =
    messages.length > 0 && messages.every((message) => message.role === 'tool');
  const knownCalls = new Set<string>();
  const completedCalls = new Set<string>();
  let previousRole: CanonicalMessage['role'] | undefined;

  for (const message of messages) {
    if (message.role === 'assistant' && 'toolCalls' in message) {
      for (const call of message.toolCalls) {
        if (knownCalls.has(call.externalCallId))
          invalid(phase, 'Tool call ids must be unique in a transcript');
        knownCalls.add(call.externalCallId);
      }
    }
    if (message.role === 'tool') {
      if (completedCalls.has(message.toolCallId))
        invalid(phase, 'A tool call cannot have duplicate results');
      if (!knownCalls.has(message.toolCallId) && !incrementalToolOnly) {
        invalid(phase, 'Tool result references an unknown tool call');
      }
      completedCalls.add(message.toolCallId);
    }
    if (message.role === 'user' && previousRole === 'tool') {
      invalid(phase, 'A user turn cannot be mixed directly after an unresolved tool-result turn');
    }
    previousRole = message.role;
  }

  if (incrementalToolOnly && request.conversationKey === undefined) {
    invalid(phase, 'Incremental tool results require X-Conversation-Key');
  }
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
  if (phase !== 'phase7') {
    if (request.tools.length > 0) unsupported(phase, 'Tools are not available yet');
    if (request.toolChoice.mode !== 'auto') unsupported(phase, 'Tool choice is not available yet');
  } else {
    try {
      validateToolChoice(request.tools, request.toolChoice);
    } catch {
      invalid(phase, 'Tool declarations or tool_choice are invalid');
    }
  }
  if (request.output.structured !== undefined) {
    if (phase !== 'phase7') unsupported(phase, 'Structured output execution is not available yet');
    try {
      validateStructuredOutputDefinition(request.output.structured);
    } catch {
      invalid(phase, 'Structured output definition is invalid');
    }
  }

  const messages: CanonicalMessage[] = request.messages.map((message) => {
    if (phase !== 'phase7') {
      if (message.role === 'tool') unsupported(phase, 'Tool messages are not available yet');
      if (message.toolCallId !== undefined || (message.toolCalls?.length ?? 0) > 0) {
        unsupported(phase, 'Tool calls are not available yet');
      }
    }
    if (message.content.some((part) => part.type !== 'text') && !attachmentsEnabled) {
      unsupported(phase, 'Attachment content parts are not available yet');
    }
    try {
      return canonicalizeRequestMessage(message, resolvedAttachments ?? new Map(), phase);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) throw error;
      return invalid(phase, 'Attachment content could not be resolved');
    }
  });

  if (phase === 'phase7') validatePhase7Transcript(request, messages, phase);

  const last = messages.at(-1);
  if (!last || (last.role !== 'user' && last.role !== 'tool')) {
    invalid(phase, 'Conversation request must end with a user message or tool result');
  }
  if (last.role === 'user' && !hasMeaningfulCanonicalUserContent(last)) {
    invalid(phase, 'Final user message must contain text or an attachment');
  }

  const toolOnlyIncremental =
    messages.length > 0 && messages.every((message) => message.role === 'tool');
  return {
    instructions: canonicalizeInstructions(request.instructions),
    messages,
    mode: messages.length === 1 || toolOnlyIncremental ? 'incremental' : 'full',
    ...(phase !== 'phase7'
      ? {}
      : { toolFingerprint: fingerprintTools(request.tools, request.toolChoice) }),
  };
}

export function toCanonicalConversationRequest(
  request: NormalizedRequest,
  resolvedAttachments?: ResolvedAttachmentSemanticMap,
): CanonicalConversationRequest {
  return canonicalConversationRequest(
    request,
    resolvedAttachments === undefined ? 'phase4' : 'phase6',
    resolvedAttachments,
  );
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
  return canonicalConversationRequest(
    request,
    resolvedAttachments === undefined ? 'phase5' : 'phase6',
    resolvedAttachments,
  );
}

export function toCanonicalPhase7ConversationRequest(
  request: NormalizedRequest,
  resolvedAttachments?: ResolvedAttachmentSemanticMap,
): CanonicalConversationRequest {
  return canonicalConversationRequest(request, 'phase7', resolvedAttachments);
}

export function toCanonicalPhase7StreamingConversationRequest(
  request: NormalizedRequest,
  resolvedAttachments?: ResolvedAttachmentSemanticMap,
): CanonicalConversationRequest {
  if (!request.output.stream) {
    throw new Phase7ExecutionError(
      'invalid_conversation_request',
      'Streaming execution requires output.stream=true',
    );
  }
  return canonicalConversationRequest(request, 'phase7', resolvedAttachments);
}
