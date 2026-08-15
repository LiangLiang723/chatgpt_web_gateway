import { randomUUID } from 'node:crypto';

import { canonicalizeText } from '../context/canonicalize.js';
import type { CanonicalTextMessage } from '../context/types.js';
import type {
  ConversationAggregate,
  ConversationRecord,
  MessageRecord,
} from '../persistence/types.js';

function storedCanonicalMessage(record: MessageRecord): CanonicalTextMessage | undefined {
  if (record.role !== 'user' && record.role !== 'assistant') return undefined;
  if (record.content.some((part) => part.type !== 'text')) return undefined;
  return {
    role: record.role,
    text: canonicalizeText(
      record.content.map((part) => (part.type === 'text' ? part.text : '')),
    ),
  };
}

function sameMessage(left: CanonicalTextMessage | undefined, right: CanonicalTextMessage): boolean {
  return left?.role === right.role && left.text === right.text;
}

function longestCommonPrefix(
  stored: ConversationAggregate | undefined,
  authoritative: CanonicalTextMessage[],
): number {
  if (!stored) return 0;
  let index = 0;
  while (
    index < stored.messages.length &&
    index < authoritative.length &&
    sameMessage(storedCanonicalMessage(stored.messages[index]!), authoritative[index]!)
  ) {
    index += 1;
  }
  return index;
}

function createMessage(options: {
  conversationId: string;
  sequence: number;
  message: CanonicalTextMessage;
  completedAt: number;
}): MessageRecord {
  return {
    id: randomUUID(),
    conversationId: options.conversationId,
    sequence: options.sequence,
    role: options.message.role,
    content: [{ type: 'text', text: options.message.text }],
    createdAt: options.completedAt,
    updatedAt: options.completedAt,
  };
}

export function buildFinalConversationAggregate(input: {
  stored?: ConversationAggregate;
  conversation: ConversationRecord;
  authoritativeMessages: CanonicalTextMessage[];
  assistantText: string;
  conversationUrl: string;
  completedAt: number;
}): ConversationAggregate {
  const finalCanonicalMessages: CanonicalTextMessage[] = [
    ...input.authoritativeMessages,
    { role: 'assistant', text: input.assistantText },
  ];
  const reusablePrefix = longestCommonPrefix(input.stored, input.authoritativeMessages);

  const messages = finalCanonicalMessages.map((message, sequence) => {
    const existing = sequence < reusablePrefix ? input.stored?.messages[sequence] : undefined;
    if (existing) {
      return {
        ...existing,
        conversationId: input.conversation.id,
        sequence,
        role: message.role,
        content: [{ type: 'text' as const, text: message.text }],
      } satisfies MessageRecord;
    }
    return createMessage({
      conversationId: input.conversation.id,
      sequence,
      message,
      completedAt: input.completedAt,
    });
  });

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
    attachments: [],
    generatedImages: [],
  };
}
