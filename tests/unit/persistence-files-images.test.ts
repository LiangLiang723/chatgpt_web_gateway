import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/persistence/database.js';
import { runMigrations } from '../../src/persistence/migrations.js';
import { ConversationRepository } from '../../src/persistence/repositories/conversations.js';
import { GeneratedImageRepository } from '../../src/persistence/repositories/generated-images.js';
import { MessageRepository } from '../../src/persistence/repositories/messages.js';
import type {
  ConversationRecord,
  GeneratedImageRecord,
  MessageRecord,
} from '../../src/persistence/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

interface TestContext {
  paths: TempPersistencePaths;
  database: ReturnType<typeof openDatabase>;
  conversations: ConversationRepository;
  messages: MessageRepository;
  generatedImages: GeneratedImageRepository;
}

const contexts: TestContext[] = [];

afterEach(() => {
  while (contexts.length) {
    const context = contexts.pop();
    if (!context) continue;
    closeDatabase(context.database);
    context.paths.cleanup();
  }
});

function setup(): TestContext {
  const paths = createTempPersistencePaths();
  const database = openDatabase(paths.databasePath);
  runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 1000 });
  const context = {
    paths,
    database,
    conversations: new ConversationRepository(database),
    messages: new MessageRepository(database),
    generatedImages: new GeneratedImageRepository(database),
  };
  contexts.push(context);
  return context;
}

const conversationId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';

function insertConversationAndMessage(context: TestContext): void {
  const conversation: ConversationRecord = {
    id: conversationId,
    instructions: [],
    tools: [],
    toolChoice: { mode: 'auto' },
    sync: { status: 'clean', syncedMessageCount: 0 },
    createdAt: 1000,
    updatedAt: 1000,
    lastUsedAt: 1000,
  };
  const message: MessageRecord = {
    id: messageId,
    conversationId,
    sequence: 0,
    role: 'assistant',
    content: [{ type: 'text', text: 'Generated an image.' }],
    createdAt: 2000,
    updatedAt: 2000,
  };
  context.conversations.insert(conversation);
  context.messages.insert(message);
}

function image(overrides: Partial<GeneratedImageRecord> = {}): GeneratedImageRecord {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    conversationId,
    messageId,
    prompt: 'Draw a tiny cat',
    mimeType: 'image/png',
    sizeBytes: 1024,
    sha256: 'imagehash',
    storagePath: '/data/generated/cat.png',
    createdAt: 4000,
    ...overrides,
  };
}

describe('GeneratedImageRepository', () => {
  it('round-trips metadata and lists images by conversation in stable order', () => {
    const context = setup();
    insertConversationAndMessage(context);
    const later = image();
    const earlier = image({
      id: '88888888-8888-4888-8888-888888888888',
      storagePath: '/data/generated/earlier.png',
      createdAt: 3000,
    });

    context.generatedImages.insert(later);
    context.generatedImages.insert(earlier);

    expect(context.generatedImages.getById(later.id)).toEqual(later);
    expect(context.generatedImages.listByConversation(conversationId)).toEqual([earlier, later]);
  });

  it('retains generated image metadata with null references after deleting its conversation', () => {
    const context = setup();
    insertConversationAndMessage(context);
    const record = image();
    context.generatedImages.insert(record);

    context.database.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);

    expect(context.generatedImages.getById(record.id)).toEqual({
      ...record,
      conversationId: undefined,
      messageId: undefined,
    });
  });
});
