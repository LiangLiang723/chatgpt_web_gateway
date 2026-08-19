import { randomUUID } from 'node:crypto';

import type { NormalizedContentPart } from '../api/normalized.js';
import { canonicalizeText } from '../context/canonicalize.js';
import { fingerprintCanonicalMessage, isCanonicalTextMessage } from '../context/multimodal.js';
import type { CanonicalMessage, CanonicalTextMessage } from '../context/types.js';
import type {
  AttachmentRecord,
  AttachmentSourceRecord,
  ConversationAggregate,
  ConversationRecord,
  MessageRecord,
} from '../persistence/types.js';

export interface PersistenceAttachmentBinding {
  localAttachmentId: string;
  kind: 'image' | 'file';
  source: AttachmentSourceRecord;
  fileId: string;
}

function storedCanonicalTextMessage(record: MessageRecord): CanonicalTextMessage | undefined {
  if (record.role !== 'user' && record.role !== 'assistant') return undefined;
  if (record.content.some((part) => part.type !== 'text')) return undefined;
  return {
    role: record.role,
    text: canonicalizeText(record.content.map((part) => (part.type === 'text' ? part.text : ''))),
  };
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
      storedCanonicalTextMessage(options.stored.messages[index] as MessageRecord);
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
}): { message: MessageRecord; attachments: AttachmentRecord[] } {
  const id = randomUUID();
  const record: MessageRecord = {
    id,
    conversationId: options.conversationId,
    sequence: options.sequence,
    role: options.message.role,
    content: contentForCanonicalMessage(options.message, options.attachmentBindings),
    createdAt: options.completedAt,
    updatedAt: options.completedAt,
  };

  if (isCanonicalTextMessage(options.message)) return { message: record, attachments: [] };

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
  return { message: record, attachments };
}

export function buildFinalConversationAggregate(input: {
  stored?: ConversationAggregate;
  storedCanonicalMessages?: readonly CanonicalMessage[];
  conversation: ConversationRecord;
  authoritativeMessages: CanonicalMessage[];
  attachmentBindings?: ReadonlyMap<string, PersistenceAttachmentBinding>;
  assistantText: string;
  conversationUrl: string;
  completedAt: number;
}): ConversationAggregate {
  const attachmentBindings = input.attachmentBindings ?? new Map();
  const finalCanonicalMessages: CanonicalMessage[] = [
    ...input.authoritativeMessages,
    { role: 'assistant', text: input.assistantText },
  ];
  const reusablePrefix = longestCommonPrefix({
    stored: input.stored,
    storedCanonicalMessages: input.storedCanonicalMessages,
    authoritative: input.authoritativeMessages,
  });

  const messages: MessageRecord[] = [];
  const attachments: AttachmentRecord[] = [];
  for (const [sequence, canonical] of finalCanonicalMessages.entries()) {
    const existing = sequence < reusablePrefix ? input.stored?.messages[sequence] : undefined;
    if (existing) {
      messages.push({ ...existing, conversationId: input.conversation.id, sequence });
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
    toolCalls: [],
    attachments,
    generatedImages: [],
  };
}
