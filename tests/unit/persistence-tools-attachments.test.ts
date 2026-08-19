import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/persistence/database.js';
import { DataIntegrityError } from '../../src/persistence/errors.js';
import { runMigrations } from '../../src/persistence/migrations.js';
import { AttachmentRepository } from '../../src/persistence/repositories/attachments.js';
import { ConversationRepository } from '../../src/persistence/repositories/conversations.js';
import { MessageRepository } from '../../src/persistence/repositories/messages.js';
import { ToolCallRepository } from '../../src/persistence/repositories/tool-calls.js';
import type {
  AttachmentRecord,
  ConversationRecord,
  MessageRecord,
  ToolCallRecord,
} from '../../src/persistence/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

interface TestContext {
  paths: TempPersistencePaths;
  database: ReturnType<typeof openDatabase>;
  conversations: ConversationRepository;
  messages: MessageRepository;
  toolCalls: ToolCallRepository;
  attachments: AttachmentRepository;
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
  database
    .prepare(
      `INSERT INTO file_blobs (id, sha256, size_bytes, storage_path, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('98989898-9898-4989-8989-989898989898', 'abc123', 3, '/data/files/blobs/abc123', 1000);
  database
    .prepare(
      `INSERT INTO files
       (id, public_id, blob_id, filename, mime_type, purpose, deleted_at, created_at, updated_at)
       VALUES (?, NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      '99999999-9999-4999-8999-999999999999',
      '98989898-9898-4989-8989-989898989898',
      'notes.txt',
      1000,
      1000,
    );
  const context = {
    paths,
    database,
    conversations: new ConversationRepository(database),
    messages: new MessageRepository(database),
    toolCalls: new ToolCallRepository(database),
    attachments: new AttachmentRepository(database),
  };
  contexts.push(context);
  return context;
}

function conversation(id = '11111111-1111-4111-8111-111111111111'): ConversationRecord {
  return {
    id,
    instructions: [],
    tools: [],
    toolChoice: { mode: 'auto' },
    sync: { status: 'clean', syncedMessageCount: 0 },
    createdAt: 1000,
    updatedAt: 1000,
    lastUsedAt: 1000,
  };
}

function message(
  id = '22222222-2222-4222-8222-222222222222',
  conversationId = '11111111-1111-4111-8111-111111111111',
): MessageRecord {
  return {
    id,
    conversationId,
    sequence: 0,
    role: 'assistant',
    content: [{ type: 'text', text: 'Calling a tool' }],
    createdAt: 2000,
    updatedAt: 2000,
  };
}

function toolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    conversationId: '11111111-1111-4111-8111-111111111111',
    messageId: '22222222-2222-4222-8222-222222222222',
    externalCallId: 'call_weather_1',
    name: 'lookup_weather',
    argumentsText: '{"city":"Tokyo"}',
    createdAt: 3000,
    ...overrides,
  };
}

function attachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    conversationId: '11111111-1111-4111-8111-111111111111',
    messageId: '22222222-2222-4222-8222-222222222222',
    localAttachmentId: 'attachment-1',
    kind: 'image',
    source: { type: 'url' },
    fileId: '99999999-9999-4999-8999-999999999999',
    createdAt: 3000,
    ...overrides,
  };
}

function insertBaseConversation(context: TestContext): void {
  context.conversations.insert(conversation());
  context.messages.insert(message());
}

describe('ToolCallRepository', () => {
  it('round-trips raw tool arguments without requiring valid JSON', () => {
    const context = setup();
    insertBaseConversation(context);
    const valid = toolCall();
    const malformed = toolCall({
      id: '55555555-5555-4555-8555-555555555555',
      externalCallId: 'call_malformed_2',
      argumentsText: '{',
      createdAt: 4000,
    });

    context.toolCalls.insert(valid);
    context.toolCalls.insert(malformed);

    expect(context.toolCalls.listByConversation(valid.conversationId)).toEqual([valid, malformed]);
  });

  it('rejects duplicate external call ids within one conversation', () => {
    const context = setup();
    insertBaseConversation(context);
    context.toolCalls.insert(toolCall());

    expect(() =>
      context.toolCalls.insert(toolCall({ id: '66666666-6666-4666-8666-666666666666' })),
    ).toThrow();
  });

  it('rejects a tool call whose message belongs to another conversation', () => {
    const context = setup();
    insertBaseConversation(context);
    const secondConversationId = '77777777-7777-4777-8777-777777777777';
    const secondMessageId = '88888888-8888-4888-8888-888888888888';
    context.conversations.insert(conversation(secondConversationId));
    context.messages.insert(message(secondMessageId, secondConversationId));

    expect(() => context.toolCalls.insert(toolCall({ messageId: secondMessageId }))).toThrowError(
      DataIntegrityError,
    );
  });
});

describe('AttachmentRepository', () => {
  it('round-trips redacted URL, file-id, and base64 source provenance in stable order', () => {
    const context = setup();
    insertBaseConversation(context);
    const urlImage = attachment();
    const fileImage = attachment({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localAttachmentId: 'attachment-2',
      source: { type: 'file_id' },
      fileId: '99999999-9999-4999-8999-999999999999',
      createdAt: 4000,
    });
    const base64File = attachment({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      localAttachmentId: 'attachment-3',
      kind: 'file',
      source: { type: 'base64' },
      fileId: '99999999-9999-4999-8999-999999999999',
      createdAt: 5000,
    });

    context.attachments.insert(urlImage);
    context.attachments.insert(fileImage);
    context.attachments.insert(base64File);

    expect(context.attachments.listByConversation(urlImage.conversationId)).toEqual([
      urlImage,
      fileImage,
      base64File,
    ]);
  });

  it('rejects source payload fields instead of persisting URL/Base64/file-id secrets', () => {
    const context = setup();
    insertBaseConversation(context);

    expect(() =>
      context.attachments.insert({
        ...attachment(),
        source: {
          type: 'url',
          url: 'https://example.com/private?token=secret',
        } as unknown as AttachmentRecord['source'],
      }),
    ).toThrowError(DataIntegrityError);
    expect(context.attachments.listByConversation(attachment().conversationId)).toEqual([]);
  });

  it('rejects duplicate local attachment ids and unknown file foreign keys', () => {
    const context = setup();
    insertBaseConversation(context);
    context.attachments.insert(attachment());

    expect(() =>
      context.attachments.insert(attachment({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })),
    ).toThrow();
    expect(() =>
      context.attachments.insert(
        attachment({
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          localAttachmentId: 'attachment-2',
          source: { type: 'file_id' },
          fileId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        }),
      ),
    ).toThrow();
  });

  it('rejects message/conversation mismatches and invalid raw kinds', () => {
    const context = setup();
    insertBaseConversation(context);
    const secondConversationId = '77777777-7777-4777-8777-777777777777';
    const secondMessageId = '88888888-8888-4888-8888-888888888888';
    context.conversations.insert(conversation(secondConversationId));
    context.messages.insert(message(secondMessageId, secondConversationId));

    expect(() =>
      context.attachments.insert(attachment({ messageId: secondMessageId })),
    ).toThrowError(DataIntegrityError);

    expect(() =>
      context.database
        .prepare(
          `INSERT INTO attachments
           (id, conversation_id, message_id, local_attachment_id, kind, source_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'attachment-video',
          'video',
          '{}',
          1000,
        ),
    ).toThrow();
  });
});
