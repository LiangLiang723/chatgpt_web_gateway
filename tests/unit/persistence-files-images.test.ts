import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/persistence/database.js';
import { runMigrations } from '../../src/persistence/migrations.js';
import { ConversationRepository } from '../../src/persistence/repositories/conversations.js';
import { FileRepository } from '../../src/persistence/repositories/files.js';
import { GeneratedImageRepository } from '../../src/persistence/repositories/generated-images.js';
import { MessageRepository } from '../../src/persistence/repositories/messages.js';
import type {
  ConversationRecord,
  FileRecord,
  GeneratedImageRecord,
  MessageRecord,
} from '../../src/persistence/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

interface TestContext {
  paths: TempPersistencePaths;
  database: ReturnType<typeof openDatabase>;
  conversations: ConversationRepository;
  messages: MessageRepository;
  files: FileRepository;
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
    files: new FileRepository(database),
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

function file(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    filename: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    sha256: 'abc123',
    storagePath: '/data/files/notes.txt',
    createdAt: 3000,
    updatedAt: 3000,
    ...overrides,
  };
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

describe('FileRepository', () => {
  it('round-trips metadata and returns all same-hash logical files in stable order', () => {
    const context = setup();
    const later = file();
    const earlier = file({
      id: '55555555-5555-4555-8555-555555555555',
      filename: 'copy.txt',
      storagePath: '/data/files/copy.txt',
      createdAt: 2000,
      updatedAt: 2000,
    });

    context.files.insert(later);
    context.files.insert(earlier);

    expect(context.files.getById(later.id)).toEqual(later);
    expect(context.files.findBySha256('abc123')).toEqual([earlier, later]);
    expect(context.files.findBySha256('missing')).toEqual([]);
  });

  it('allows duplicate hashes but rejects duplicate storage paths and negative sizes', () => {
    const context = setup();
    context.files.insert(file());

    expect(() =>
      context.files.insert(
        file({
          id: '66666666-6666-4666-8666-666666666666',
          filename: 'duplicate-path.txt',
        }),
      ),
    ).toThrow();

    expect(() =>
      context.database
        .prepare(
          `INSERT INTO files
           (id, filename, size_bytes, sha256, storage_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '77777777-7777-4777-8777-777777777777',
          'bad.txt',
          -1,
          'bad',
          '/data/files/bad.txt',
          1000,
          1000,
        ),
    ).toThrow();
  });
});

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
