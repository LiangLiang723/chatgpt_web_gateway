import { randomUUID } from 'node:crypto';

import type { NormalizedContentPart, NormalizedToolCall } from '../api/normalized.js';
import { canonicalizeText } from '../context/canonicalize.js';
import {
  fingerprintCanonicalMessage,
  isCanonicalAssistantToolCallMessage,
  isCanonicalTextMessage,
  isCanonicalToolResultMessage,
} from '../context/multimodal.js';
import type { CanonicalMessage } from '../context/types.js';
import type {
  AttachmentRecord,
  AttachmentSourceRecord,
  ConversationAggregate,
  ConversationRecord,
  MessageRecord,
  ToolCallRecord,
} from '../persistence/types.js';

export interface PersistenceAttachmentBinding {
  localAttachmentId: string;
  kind: 'image' | 'file';
  source: AttachmentSourceRecord;
  fileId: string;
}

export type AssistantAggregateResult =
  { type: 'text'; text: string } | { type: 'tool_calls'; toolCalls: NormalizedToolCall[] };

function storedCanonicalMessage(
  record: MessageRecord,
  aggregate: ConversationAggregate,
): CanonicalMessage | undefined {
  if (record.role === 'tool') {
    if (!record.toolCallId || record.content.some((part) => part.type !== 'text')) return undefined;
    return {
      role: 'tool',
      toolCallId: record.toolCallId,
      text: canonicalizeText(record.content.map((part) => (part.type === 'text' ? part.text : ''))),
    };
  }
  if (record.role !== 'user' && record.role !== 'assistant') return undefined;
  if (record.content.some((part) => part.type !== 'text')) return undefined;
  const text = canonicalizeText(
    record.content.map((part) => (part.type === 'text' ? part.text : '')),
  );
  const calls = aggregate.toolCalls.filter((call) => call.messageId === record.id);
  if (record.role === 'assistant' && calls.length > 0) {
    return {
      role: 'assistant',
      text,
      toolCalls: calls.map((call) => ({
        externalCallId: call.externalCallId,
        name: call.name,
        arguments: call.argumentsText,
      })),
    };
  }
  return { role: record.role, text };
}

function sameMessage(left: CanonicalMessage | undefined, right: CanonicalMessage): boolean {
  return (
    left !== undefined && fingerprintCanonicalMessage(left) === fingerprintCanonicalMessage(right)
  );
}

function longestCommonPrefix(options: {
  stored?: ConversationAggregate;
  storedCanonicalMessages?: readonly CanonicalMessage[];
  authoritative: readonly CanonicalMessage[];
}): number {
  if (!options.stored) return 0;
  let index = 0;
  while (index < options.stored.messages.length && index < options.authoritative.length) {
    const storedCanonical =
      options.storedCanonicalMessages?.[index] ??
      storedCanonicalMessage(options.stored.messages[index] as MessageRecord, options.stored);
    const authoritative = options.authoritative[index];
    if (!authoritative || !sameMessage(storedCanonical, authoritative)) break;
    index += 1;
  }
  return index;
}

function contentForCanonicalMessage(
  message: CanonicalMessage,
  attachmentBindings: ReadonlyMap<string, PersistenceAttachmentBinding>,
): NormalizedContentPart[] {
  if (isCanonicalToolResultMessage(message)) return [{ type: 'text', text: message.text }];
  if (isCanonicalAssistantToolCallMessage(message)) {
    return message.text.length === 0 ? [] : [{ type: 'text', text: message.text }];
  }
  if (isCanonicalTextMessage(message)) return [{ type: 'text', text: message.text }];
  return message.content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    const binding = attachmentBindings.get(part.reference);
    if (!binding) throw new Error(`Missing persistence attachment binding: ${part.reference}`);
    return { type: 'attachment' as const, attachmentId: binding.localAttachmentId };
  });
}

function createMessage(options: {
  conversationId: string;
  sequence: number;
  message: CanonicalMessage;
  completedAt: number;
  attachmentBindings: ReadonlyMap<string, PersistenceAttachmentBinding>;
}): { message: MessageRecord; attachments: AttachmentRecord[]; toolCalls: ToolCallRecord[] } {
  const id = randomUUID();
  const record: MessageRecord = {
    id,
    conversationId: options.conversationId,
    sequence: options.sequence,
    role: options.message.role,
    content: contentForCanonicalMessage(options.message, options.attachmentBindings),
    ...(isCanonicalToolResultMessage(options.message)
      ? { toolCallId: options.message.toolCallId }
      : {}),
    createdAt: options.completedAt,
    updatedAt: options.completedAt,
  };

  const toolCalls = isCanonicalAssistantToolCallMessage(options.message)
    ? options.message.toolCalls.map((call): ToolCallRecord => ({
        id: randomUUID(),
        conversationId: options.conversationId,
        messageId: id,
        externalCallId: call.externalCallId,
        name: call.name,
        argumentsText: call.arguments,
        createdAt: options.completedAt,
      }))
    : [];

  if (!('content' in options.message)) return { message: record, attachments: [], toolCalls };

  const attachments = options.message.content.flatMap((part) => {
    if (part.type !== 'attachment') return [];
    const binding = options.attachmentBindings.get(part.reference);
    if (!binding) throw new Error(`Missing persistence attachment binding: ${part.reference}`);
    return [
      {
        id: randomUUID(),
        conversationId: options.conversationId,
        messageId: id,
        localAttachmentId: binding.localAttachmentId,
        kind: binding.kind,
        source: binding.source,
        fileId: binding.fileId,
        createdAt: options.completedAt,
      } satisfies AttachmentRecord,
    ];
  });
  return { message: record, attachments, toolCalls };
}

function assistantCanonical(result: AssistantAggregateResult): CanonicalMessage {
  if (result.type === 'text') return { role: 'assistant', text: result.text };
  return {
    role: 'assistant',
    text: '',
    toolCalls: result.toolCalls.map((call) => ({
      externalCallId: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
  };
}

export function buildFinalConversationAggregate(input: {
  stored?: ConversationAggregate;
  storedCanonicalMessages?: readonly CanonicalMessage[];
  conversation: ConversationRecord;
  authoritativeMessages: CanonicalMessage[];
  attachmentBindings?: ReadonlyMap<string, PersistenceAttachmentBinding>;
  assistantResult?: AssistantAggregateResult;
  assistantText?: string;
  conversationUrl: string;
  completedAt: number;
}): ConversationAggregate {
  const attachmentBindings = input.attachmentBindings ?? new Map();
  const assistantResult =
    input.assistantResult ?? ({ type: 'text', text: input.assistantText ?? '' } as const);
  const finalCanonicalMessages: CanonicalMessage[] = [
    ...input.authoritativeMessages,
    assistantCanonical(assistantResult),
  ];
  const reusablePrefix = longestCommonPrefix({
    stored: input.stored,
    storedCanonicalMessages: input.storedCanonicalMessages,
    authoritative: input.authoritativeMessages,
  });

  const messages: MessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const attachments: AttachmentRecord[] = [];
  for (const [sequence, canonical] of finalCanonicalMessages.entries()) {
    const existing = sequence < reusablePrefix ? input.stored?.messages[sequence] : undefined;
    if (existing) {
      messages.push({ ...existing, conversationId: input.conversation.id, sequence });
      toolCalls.push(
        ...(input.stored?.toolCalls.filter((item) => item.messageId === existing.id) ?? []),
      );
      attachments.push(
        ...(input.stored?.attachments.filter((item) => item.messageId === existing.id) ?? []),
      );
      continue;
    }

    const created = createMessage({
      conversationId: input.conversation.id,
      sequence,
      message: canonical,
      completedAt: input.completedAt,
      attachmentBindings,
    });
    messages.push(created.message);
    toolCalls.push(...created.toolCalls);
    attachments.push(...created.attachments);
  }

  return {
    conversation: {
      ...input.conversation,
      chatgptConversationUrl: input.conversationUrl,
      sync: { status: 'clean', syncedMessageCount: messages.length },
      updatedAt: input.completedAt,
      lastUsedAt: input.completedAt,
    },
    messages,
    toolCalls,
    attachments,
    generatedImages: [],
  };
}
