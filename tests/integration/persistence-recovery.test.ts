import { afterEach, describe, expect, it } from 'vitest';

import { DataIntegrityError } from '../../src/persistence/errors.js';
import { createPersistenceContext } from '../../src/persistence/index.js';
import type { ConversationAggregate, FileRecord } from '../../src/persistence/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const resources: TempPersistencePaths[] = [];

afterEach(() => {
  while (resources.length) resources.pop()?.cleanup();
});

function temp(): TempPersistencePaths {
  const paths = createTempPersistencePaths();
  resources.push(paths);
  return paths;
}

const conversationId = '11111111-1111-4111-8111-111111111111';
const userMessageId = '22222222-2222-4222-8222-222222222222';
const toolCallMessageId = '33333333-3333-4333-8333-333333333333';
const toolResultMessageId = '44444444-4444-4444-8444-444444444444';
const finalMessageId = '55555555-5555-4555-8555-555555555555';
const fileId = '66666666-6666-4666-8666-666666666666';

function fileRecord(): FileRecord {
  return {
    id: fileId,
    filename: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    sha256: 'filehash',
    storagePath: '/data/files/notes.txt',
    createdAt: 900,
    updatedAt: 900,
  };
}

function aggregate(): ConversationAggregate {
  return {
    conversation: {
      id: conversationId,
      conversationKey: 'agent-thread-1',
      chatgptConversationUrl: 'https://chatgpt.com/c/recover-me',
      instructions: [
        { role: 'system', content: 'You are persistent.' },
        { role: 'developer', content: 'Keep state exact.' },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup_weather',
          description: 'Look up weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
      toolChoice: { mode: 'required' },
      toolFingerprint: 'weather-v1',
      createdAt: 1000,
      updatedAt: 8000,
      lastUsedAt: 8000,
    },
    messages: [
      {
        id: userMessageId,
        conversationId,
        sequence: 0,
        role: 'user',
        content: [
          { type: 'text', text: 'Use these attachments.' },
          { type: 'attachment', attachmentId: 'attachment-1' },
          { type: 'attachment', attachmentId: 'attachment-2' },
        ],
        createdAt: 2000,
        updatedAt: 2000,
      },
      {
        id: toolCallMessageId,
        conversationId,
        sequence: 1,
        role: 'assistant',
        content: [{ type: 'text', text: 'Checking.' }],
        createdAt: 3000,
        updatedAt: 3000,
      },
      {
        id: toolResultMessageId,
        conversationId,
        sequence: 2,
        role: 'tool',
        content: [{ type: 'text', text: '{"temperature":30}' }],
        toolCallId: 'call_weather_1',
        createdAt: 4000,
        updatedAt: 4000,
      },
      {
        id: finalMessageId,
        conversationId,
        sequence: 3,
        role: 'assistant',
        content: [{ type: 'text', text: 'It is warm.' }],
        createdAt: 5000,
        updatedAt: 5000,
      },
    ],
    toolCalls: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        conversationId,
        messageId: toolCallMessageId,
        externalCallId: 'call_weather_1',
        name: 'lookup_weather',
        argumentsText: '{"city":"Tokyo"}',
        createdAt: 3000,
      },
    ],
    attachments: [
      {
        id: '88888888-8888-4888-8888-888888888888',
        conversationId,
        messageId: userMessageId,
        localAttachmentId: 'attachment-1',
        kind: 'image',
        source: { type: 'url', url: 'https://example.com/cat.png' },
        createdAt: 2000,
      },
      {
        id: '99999999-9999-4999-8999-999999999999',
        conversationId,
        messageId: userMessageId,
        localAttachmentId: 'attachment-2',
        kind: 'file',
        source: { type: 'file_id', fileId },
        fileId,
        createdAt: 2100,
      },
    ],
    generatedImages: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        conversationId,
        messageId: finalMessageId,
        prompt: 'A persisted diagram',
        mimeType: 'image/png',
        sizeBytes: 2048,
        sha256: 'imagehash',
        storagePath: '/data/generated/persisted.png',
        createdAt: 6000,
      },
    ],
  };
}

describe('Conversation persistence recovery', () => {
  it('restores a complete conversation aggregate and independent File after close/reopen', () => {
    const paths = temp();
    const expectedAggregate = aggregate();
    const expectedFile = fileRecord();

    const first = createPersistenceContext({
      databasePath: paths.databasePath,
      migrationsDir: paths.migrationsDir,
    });
    first.files.insert(expectedFile);
    first.conversationStore.save(expectedAggregate);
    first.close();

    const second = createPersistenceContext({
      databasePath: paths.databasePath,
      migrationsDir: paths.migrationsDir,
    });
    expect(second.conversationStore.loadById(conversationId)).toEqual(expectedAggregate);
    expect(second.conversationStore.loadByKey('agent-thread-1')).toEqual(expectedAggregate);
    expect(second.files.getById(fileId)).toEqual(expectedFile);
    second.close();
  });

  it('keeps the previous snapshot unchanged when aggregate validation fails', () => {
    const paths = temp();
    const original = aggregate();
    const context = createPersistenceContext({
      databasePath: paths.databasePath,
      migrationsDir: paths.migrationsDir,
    });
    context.files.insert(fileRecord());
    context.conversationStore.save(original);

    const invalid = aggregate();
    invalid.messages = invalid.messages.map((message) =>
      message.id === toolResultMessageId ? { ...message, toolCallId: 'missing_call' } : message,
    );
    invalid.conversation = { ...invalid.conversation, updatedAt: 9000 };

    expect(() => context.conversationStore.save(invalid)).toThrowError(DataIntegrityError);
    expect(context.conversationStore.loadById(conversationId)).toEqual(original);
    context.close();
  });

  it('rejects generated images that are not owned by the aggregate conversation', () => {
    const paths = temp();
    const context = createPersistenceContext({
      databasePath: paths.databasePath,
      migrationsDir: paths.migrationsDir,
    });
    context.files.insert(fileRecord());
    const original = aggregate();
    context.conversationStore.save(original);

    const invalid = aggregate();
    invalid.generatedImages = invalid.generatedImages.map((image) => ({
      ...image,
      conversationId: undefined,
    }));

    expect(() => context.conversationStore.save(invalid)).toThrowError(DataIntegrityError);
    expect(context.conversationStore.loadById(conversationId)).toEqual(original);
    context.close();
  });

  it('rejects duplicate sequences and child references outside the aggregate before replacement', () => {
    const paths = temp();
    const context = createPersistenceContext({
      databasePath: paths.databasePath,
      migrationsDir: paths.migrationsDir,
    });
    context.files.insert(fileRecord());
    const original = aggregate();
    context.conversationStore.save(original);

    const duplicateSequence = aggregate();
    duplicateSequence.messages = duplicateSequence.messages.map((message) =>
      message.id === finalMessageId ? { ...message, sequence: 2 } : message,
    );
    expect(() => context.conversationStore.save(duplicateSequence)).toThrowError(
      DataIntegrityError,
    );

    const badAttachment = aggregate();
    badAttachment.attachments = badAttachment.attachments.map((item, index) =>
      index === 0 ? { ...item, messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } : item,
    );
    expect(() => context.conversationStore.save(badAttachment)).toThrowError(DataIntegrityError);
    expect(context.conversationStore.loadById(conversationId)).toEqual(original);

    context.close();
  });
});
