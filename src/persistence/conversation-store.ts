import type { DatabaseSync } from 'node:sqlite';

import { DataIntegrityError } from './errors.js';
import { AttachmentRepository } from './repositories/attachments.js';
import { ConversationRepository } from './repositories/conversations.js';
import { FileRepository } from './repositories/files.js';
import { GeneratedImageRepository } from './repositories/generated-images.js';
import { MessageRepository } from './repositories/messages.js';
import { ToolCallRepository } from './repositories/tool-calls.js';
import { transaction } from './transaction.js';
import type { ConversationAggregate } from './types.js';

export interface ConversationStoreRepositories {
  conversations: ConversationRepository;
  messages: MessageRepository;
  toolCalls: ToolCallRepository;
  attachments: AttachmentRepository;
  files: FileRepository;
  generatedImages: GeneratedImageRepository;
}

function validateAggregate(aggregate: ConversationAggregate, files?: FileRepository): void {
  const conversationId = aggregate.conversation.id;
  if (aggregate.conversation.sync.syncedMessageCount > aggregate.messages.length) {
    throw new DataIntegrityError('Conversation sync message count exceeds aggregate Messages');
  }
  const messageIds = new Set<string>();
  const sequences = new Set<number>();

  for (const message of aggregate.messages) {
    if (message.conversationId !== conversationId) {
      throw new DataIntegrityError('Message belongs to a different Conversation');
    }
    if (messageIds.has(message.id)) {
      throw new DataIntegrityError('Conversation aggregate contains duplicate Message ids');
    }
    if (sequences.has(message.sequence)) {
      throw new DataIntegrityError('Conversation aggregate contains duplicate Message sequences');
    }
    messageIds.add(message.id);
    sequences.add(message.sequence);
  }

  const toolCallIds = new Set<string>();
  for (const call of aggregate.toolCalls) {
    if (call.conversationId !== conversationId || !messageIds.has(call.messageId)) {
      throw new DataIntegrityError('Tool Call must reference a Message in the same Conversation');
    }
    if (toolCallIds.has(call.externalCallId)) {
      throw new DataIntegrityError('Conversation aggregate contains duplicate Tool Call ids');
    }
    toolCallIds.add(call.externalCallId);
  }

  for (const message of aggregate.messages) {
    if (message.role === 'tool') {
      if (!message.toolCallId || !toolCallIds.has(message.toolCallId)) {
        throw new DataIntegrityError(
          'Tool Result must reference a Tool Call in the same Conversation',
        );
      }
    }
  }

  const attachmentKeys = new Set<string>();
  for (const attachment of aggregate.attachments) {
    if (attachment.conversationId !== conversationId || !messageIds.has(attachment.messageId)) {
      throw new DataIntegrityError('Attachment must reference a Message in the same Conversation');
    }
    const sourceKeys = Object.keys(attachment.source as object);
    if (sourceKeys.length !== 1 || sourceKeys[0] !== 'type') {
      throw new DataIntegrityError('Attachment source provenance must not persist source payloads');
    }
    const key = `${attachment.messageId}\u0000${attachment.localAttachmentId}`;
    if (attachmentKeys.has(key)) {
      throw new DataIntegrityError(
        'Conversation aggregate contains duplicate Attachment references',
      );
    }
    attachmentKeys.add(key);
    if (files !== undefined && files.getById(attachment.fileId) === undefined) {
      throw new DataIntegrityError('Attachment must reference an existing File');
    }
  }

  for (const message of aggregate.messages) {
    for (const part of message.content) {
      if (part.type !== 'attachment') continue;
      const key = `${message.id}\u0000${part.attachmentId}`;
      if (!attachmentKeys.has(key)) {
        throw new DataIntegrityError(
          'Message attachment content must have a matching Attachment record',
        );
      }
    }
  }

  for (const attachment of aggregate.attachments) {
    const message = aggregate.messages.find((item) => item.id === attachment.messageId);
    if (
      !message?.content.some(
        (part) => part.type === 'attachment' && part.attachmentId === attachment.localAttachmentId,
      )
    ) {
      throw new DataIntegrityError(
        'Attachment record must have a matching Message content reference',
      );
    }
  }

  for (const image of aggregate.generatedImages) {
    if (image.conversationId !== conversationId) {
      throw new DataIntegrityError('Generated Image must belong to the aggregate Conversation');
    }
    if (image.messageId !== undefined && !messageIds.has(image.messageId)) {
      throw new DataIntegrityError('Generated Image must reference a Message in the aggregate');
    }
  }
}

export class ConversationStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly repositories: ConversationStoreRepositories,
  ) {}

  save(aggregate: ConversationAggregate): void {
    validateAggregate(aggregate, this.repositories.files);

    transaction(this.database, () => {
      if (this.repositories.conversations.getById(aggregate.conversation.id)) {
        this.repositories.conversations.update(aggregate.conversation);
      } else {
        this.repositories.conversations.insert(aggregate.conversation);
      }

      this.repositories.generatedImages.deleteByConversation(aggregate.conversation.id);
      this.repositories.messages.deleteByConversation(aggregate.conversation.id);

      for (const message of aggregate.messages) this.repositories.messages.insert(message);
      for (const call of aggregate.toolCalls) this.repositories.toolCalls.insert(call);
      for (const attachment of aggregate.attachments)
        this.repositories.attachments.insert(attachment);
      for (const image of aggregate.generatedImages)
        this.repositories.generatedImages.insert(image);
    });
  }

  markSyncInFlight(conversationId: string, startedAt: number): void {
    const aggregate = this.loadById(conversationId);
    if (!aggregate) {
      throw new DataIntegrityError(`Conversation ${conversationId} does not exist`);
    }
    transaction(this.database, () => {
      this.repositories.conversations.updateSyncCheckpoint(conversationId, {
        status: 'in_flight',
        syncedMessageCount: aggregate.conversation.sync.syncedMessageCount,
        startedAt,
      });
    });
  }

  loadById(id: string): ConversationAggregate | undefined {
    const conversation = this.repositories.conversations.getById(id);
    return conversation ? this.load(conversation.id, conversation) : undefined;
  }

  loadByKey(conversationKey: string): ConversationAggregate | undefined {
    const conversation = this.repositories.conversations.getByKey(conversationKey);
    return conversation ? this.load(conversation.id, conversation) : undefined;
  }

  loadAnonymousBySyncedMessageCount(syncedMessageCount: number): ConversationAggregate[] {
    return this.repositories.conversations
      .listAnonymousBySyncedMessageCount(syncedMessageCount)
      .map((conversation) => this.load(conversation.id, conversation));
  }

  private load(
    conversationId: string,
    conversation: ConversationAggregate['conversation'],
  ): ConversationAggregate {
    const aggregate: ConversationAggregate = {
      conversation,
      messages: this.repositories.messages.listByConversation(conversationId),
      toolCalls: this.repositories.toolCalls.listByConversation(conversationId),
      attachments: this.repositories.attachments.listByConversation(conversationId),
      generatedImages: this.repositories.generatedImages.listByConversation(conversationId),
    };
    validateAggregate(aggregate, this.repositories.files);
    return aggregate;
  }
}
