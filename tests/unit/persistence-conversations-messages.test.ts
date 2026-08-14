import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/persistence/database.js';
import { runMigrations } from '../../src/persistence/migrations.js';
import { ConversationRepository } from '../../src/persistence/repositories/conversations.js';
import { MessageRepository } from '../../src/persistence/repositories/messages.js';
import type { ConversationRecord, MessageRecord } from '../../src/persistence/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

interface TestContext {
  paths: TempPersistencePaths;
  database: ReturnType<typeof openDatabase>;
  conversations: ConversationRepository;
  messages: MessageRepository;
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
  };
  contexts.push(context);
  return context;
}

function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    conversationKey: 'agent-thread-1',
    chatgptConversationUrl: 'https://chatgpt.com/c/example',
    instructions: [
      { role: 'system', content: 'You are a test assistant.' },
      { role: 'developer', content: 'Be concise.' },
    ],
    tools: [
      {
        type: 'function',
        name: 'lookup_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    toolChoice: { mode: 'auto' },
    toolFingerprint: 'tools-v1',
    createdAt: 1000,
    updatedAt: 2000,
    lastUsedAt: 3000,
    ...overrides,
  };
}

function message(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    conversationId: '11111111-1111-4111-8111-111111111111',
    sequence: 0,
    role: 'user',
    content: [{ type: 'text', text: 'Hello' }],
    createdAt: 4000,
    updatedAt: 4000,
    ...overrides,
  };
}

describe('ConversationRepository', () => {
  it('round-trips records by id and conversation key', () => {
    const { conversations } = setup();
    const record = conversation();

    conversations.insert(record);

    expect(conversations.getById(record.id)).toEqual(record);
    expect(conversations.getByKey('agent-thread-1')).toEqual(record);
    expect(conversations.getByKey('missing')).toBeUndefined();
  });

  it('allows multiple null conversation keys but rejects duplicate non-null keys', () => {
    const { conversations } = setup();

    conversations.insert(conversation({ conversationKey: undefined }));
    conversations.insert(
      conversation({
        id: '33333333-3333-4333-8333-333333333333',
        conversationKey: undefined,
      }),
    );

    conversations.insert(
      conversation({
        id: '44444444-4444-4444-8444-444444444444',
        conversationKey: 'duplicate-key',
      }),
    );
    expect(() =>
      conversations.insert(
        conversation({
          id: '55555555-5555-4555-8555-555555555555',
          conversationKey: 'duplicate-key',
        }),
      ),
    ).toThrow();
  });

  it('updates mutable conversation state without changing the primary key', () => {
    const { conversations } = setup();
    const original = conversation();
    conversations.insert(original);

    const updated = conversation({
      chatgptConversationUrl: 'https://chatgpt.com/c/restored',
      instructions: [{ role: 'developer', content: 'Updated.' }],
      tools: [],
      toolChoice: { mode: 'none' },
      toolFingerprint: undefined,
      updatedAt: 5000,
      lastUsedAt: 6000,
    });
    conversations.update(updated);

    expect(conversations.getById(original.id)).toEqual(updated);
  });

  it('rejects non-UUID primary keys at the repository boundary', () => {
    const { conversations } = setup();
    expect(() => conversations.insert(conversation({ id: 'not-a-uuid' }))).toThrow(/UUID/i);
  });
});

describe('MessageRepository', () => {
  it('loads messages in sequence order and round-trips JSON content', () => {
    const { conversations, messages } = setup();
    conversations.insert(conversation());

    const second = message({
      id: '66666666-6666-4666-8666-666666666666',
      sequence: 1,
      role: 'assistant',
      content: [{ type: 'text', text: 'Second' }],
      createdAt: 3000,
      updatedAt: 3000,
    });
    const first = message({ sequence: 0, createdAt: 5000, updatedAt: 5000 });
    messages.insert(second);
    messages.insert(first);

    expect(messages.listByConversation(first.conversationId)).toEqual([first, second]);
  });

  it('rejects duplicate sequence numbers in one conversation', () => {
    const { conversations, messages } = setup();
    conversations.insert(conversation());
    messages.insert(message());

    expect(() =>
      messages.insert(
        message({
          id: '77777777-7777-4777-8777-777777777777',
          sequence: 0,
        }),
      ),
    ).toThrow();
  });

  it('lets SQLite reject invalid message roles', () => {
    const { database, conversations } = setup();
    conversations.insert(conversation());

    expect(() =>
      database
        .prepare(
          `INSERT INTO messages
           (id, conversation_id, sequence, role, content_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          '88888888-8888-4888-8888-888888888888',
          '11111111-1111-4111-8111-111111111111',
          0,
          'system',
          '[]',
          1000,
          1000,
        ),
    ).toThrow();
  });
});
