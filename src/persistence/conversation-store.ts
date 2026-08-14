import type { DatabaseSync } from 'node:sqlite';

import { DataIntegrityError } from './errors.js';
import { AttachmentRepository } from './repositories/attachments.js';
import { ConversationRepository } from './repositories/conversations.js';
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
  generatedImages: GeneratedImageRepository;
}

function validateAggregate(aggregate: ConversationAggregate): void {
  const conversationId = aggregate.conversation.id;
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

  for (const attachment of aggregate.attachments) {
    if (attachment.conversationId !== conversationId || !messageIds.has(attachment.messageId)) {
      throw new DataIntegrityError('Attachment must reference a Message in the same Conversation');
    }
  }

  for (const image of aggregate.generatedImages) {
    if (image.conversationId !== undefined && image.conversationId !== conversationId) {
      throw new DataIntegrityError('Generated Image belongs to a different Conversation');
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
    validateAggregate(aggregate);

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

  loadById(id: string): ConversationAggregate | undefined {
    const conversation = this.repositories.conversations.getById(id);
    return conversation ? this.load(conversation.id, conversation) : undefined;
  }

  loadByKey(conversationKey: string): ConversationAggregate | undefined {
    const conversation = this.repositories.conversations.getByKey(conversationKey);
    return conversation ? this.load(conversation.id, conversation) : undefined;
  }

  private load(
    conversationId: string,
    conversation: ConversationAggregate['conversation'],
  ): ConversationAggregate {
    return {
      conversation,
      messages: this.repositories.messages.listByConversation(conversationId),
      toolCalls: this.repositories.toolCalls.listByConversation(conversationId),
      attachments: this.repositories.attachments.listByConversation(conversationId),
      generatedImages: this.repositories.generatedImages.listByConversation(conversationId),
    };
  }
}
