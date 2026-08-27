import { fingerprintCanonical } from './fingerprint.js';
import type {
  CanonicalAssistantToolCallMessage,
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalMultimodalMessage,
  CanonicalToolResultMessage,
  ContextSyncPlan,
} from './types.js';

export interface ResolvedAttachmentSemantic {
  kind: 'image' | 'file';
  sha256: string;
  filename: string;
  mimeType?: string;
}

export type ResolvedAttachmentSemanticMap = ReadonlyMap<string, ResolvedAttachmentSemantic>;

export function isCanonicalToolResultMessage(
  message: CanonicalMessage,
): message is CanonicalToolResultMessage {
  return message.role === 'tool';
}

export function isCanonicalAssistantToolCallMessage(
  message: CanonicalMessage,
): message is CanonicalAssistantToolCallMessage {
  return message.role === 'assistant' && 'toolCalls' in message;
}

export function isCanonicalTextMessage(
  message: CanonicalMessage,
): message is Extract<CanonicalMessage, { role: 'user' | 'assistant'; text: string }> {
  return message.role !== 'tool' && !('toolCalls' in message) && 'text' in message;
}

function isCanonicalMultimodalMessage(
  message: CanonicalMessage,
): message is CanonicalMultimodalMessage {
  return 'content' in message;
}

export function fingerprintCanonicalMessage(message: CanonicalMessage): string {
  if (isCanonicalToolResultMessage(message)) {
    return fingerprintCanonical({
      role: message.role,
      toolCallId: message.toolCallId,
      text: message.text,
    });
  }
  if (isCanonicalAssistantToolCallMessage(message)) {
    return fingerprintCanonical({
      role: message.role,
      text: message.text,
      toolCalls: message.toolCalls.map((call) => ({
        externalCallId: call.externalCallId,
        name: call.name,
        arguments: call.arguments,
      })),
    });
  }
  if (isCanonicalTextMessage(message)) return fingerprintCanonical(message);
  return fingerprintCanonical({
    role: message.role,
    content: message.content.map((part) =>
      part.type === 'text'
        ? part
        : {
            type: 'attachment',
            kind: part.kind,
            sha256: part.sha256,
            filename: part.filename,
            ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
          },
    ),
  });
}

export function hasMeaningfulCanonicalUserContent(message: CanonicalMessage): boolean {
  if (message.role !== 'user') return false;
  if (isCanonicalTextMessage(message)) return message.text.trim().length > 0;
  if (!isCanonicalMultimodalMessage(message)) return false;
  return message.content.some(
    (part) => part.type === 'attachment' || (part.type === 'text' && part.text.trim().length > 0),
  );
}

export function attachmentReferences(message: CanonicalMessage): string[] {
  if (!isCanonicalMultimodalMessage(message)) return [];
  return message.content
    .filter(
      (part): part is Extract<CanonicalContentPart, { type: 'attachment' }> =>
        part.type === 'attachment',
    )
    .map((part) => part.reference);
}

export function selectUploadAttachmentReferences(plan: ContextSyncPlan): string[] {
  const messages =
    plan.mode === 'FRESH' || plan.mode === 'REBUILD'
      ? [...plan.history, ...plan.pending]
      : [...plan.pending];
  const references: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const reference of attachmentReferences(message)) {
      if (seen.has(reference)) continue;
      seen.add(reference);
      references.push(reference);
    }
  }
  return references;
}

export function serializeCanonicalMessage(
  message: CanonicalMessage,
  uploadFilenameByReference: ReadonlyMap<string, string> = new Map(),
  toolNameByCallId: ReadonlyMap<string, string> = new Map(),
): unknown {
  if (isCanonicalToolResultMessage(message)) {
    const name = toolNameByCallId.get(message.toolCallId);
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      ...(name === undefined ? {} : { name }),
      output: message.text,
    };
  }
  if (isCanonicalAssistantToolCallMessage(message)) {
    return {
      role: 'assistant',
      ...(message.text.length === 0 ? {} : { text: message.text }),
      tool_calls: message.toolCalls.map((call) => ({
        tool_call_id: call.externalCallId,
        name: call.name,
        arguments: call.arguments,
      })),
    };
  }
  if (isCanonicalTextMessage(message)) return { role: message.role, text: message.text };
  return {
    role: message.role,
    content: serializeCanonicalContent(message, uploadFilenameByReference),
  };
}

export function serializeCanonicalCurrentUser(
  message: CanonicalMessage,
  uploadFilenameByReference: ReadonlyMap<string, string> = new Map(),
): unknown {
  if (message.role !== 'user') return serializeCanonicalMessage(message, uploadFilenameByReference);
  if (isCanonicalTextMessage(message)) return { text: message.text };
  return { content: serializeCanonicalContent(message, uploadFilenameByReference) };
}

function serializeCanonicalContent(
  message: CanonicalMultimodalMessage,
  uploadFilenameByReference: ReadonlyMap<string, string>,
): unknown[] {
  return message.content.map((part) => {
    if (part.type === 'text') return part;
    return {
      type: 'attachment',
      kind: part.kind,
      filename: part.filename,
      upload_filename: uploadFilenameByReference.get(part.reference) ?? part.filename,
    };
  });
}
