import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { ConversationStore } from './conversation-store.js';
import { closeDatabase, openDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { AttachmentRepository } from './repositories/attachments.js';
import { ConversationRepository } from './repositories/conversations.js';
import { FileRepository } from './repositories/files.js';
import { GeneratedImageRepository } from './repositories/generated-images.js';
import { MessageRepository } from './repositories/messages.js';
import { ToolCallRepository } from './repositories/tool-calls.js';

export interface CreatePersistenceContextOptions {
  databasePath: string;
  migrationsDir?: string;
}

export interface PersistenceContext {
  readonly database: DatabaseSync;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly toolCalls: ToolCallRepository;
  readonly attachments: AttachmentRepository;
  readonly files: FileRepository;
  readonly generatedImages: GeneratedImageRepository;
  readonly conversationStore: ConversationStore;
  close(): void;
}

function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

export function createPersistenceContext(
  options: CreatePersistenceContextOptions,
): PersistenceContext {
  const database = openDatabase(options.databasePath);
  try {
    runMigrations(database, {
      migrationsDir: options.migrationsDir ?? defaultMigrationsDir(),
    });
  } catch (error) {
    closeDatabase(database);
    throw error;
  }

  const conversations = new ConversationRepository(database);
  const messages = new MessageRepository(database);
  const toolCalls = new ToolCallRepository(database);
  const attachments = new AttachmentRepository(database);
  const files = new FileRepository(database);
  const generatedImages = new GeneratedImageRepository(database);
  const conversationStore = new ConversationStore(database, {
    conversations,
    messages,
    toolCalls,
    attachments,
    generatedImages,
  });

  let closed = false;
  return {
    database,
    conversations,
    messages,
    toolCalls,
    attachments,
    files,
    generatedImages,
    conversationStore,
    close() {
      if (closed) return;
      closed = true;
      closeDatabase(database);
    },
  };
}

export type * from './types.js';
