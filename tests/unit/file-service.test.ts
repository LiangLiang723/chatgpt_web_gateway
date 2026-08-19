import { Readable } from 'node:stream';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileService } from '../../src/attachments/file-service.js';
import { createPersistenceContext } from '../../src/persistence/index.js';
import type { PersistenceContext } from '../../src/persistence/index.js';
import type { ConversationRecord, MessageRecord } from '../../src/persistence/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

interface TestContext {
  paths: TempPersistencePaths;
  persistence: PersistenceContext;
  service: FileService;
}

const contexts: TestContext[] = [];

afterEach(async () => {
  while (contexts.length) {
    const context = contexts.pop();
    if (!context) continue;
    context.persistence.close();
    context.paths.cleanup();
  }
});

function setup(): TestContext {
  const paths = createTempPersistencePaths();
  const persistence = createPersistenceContext({
    databasePath: paths.databasePath,
    migrationsDir: paths.migrationsDir,
  });
  const service = new FileService({
    dataDir: paths.root,
    attachments: persistence.attachments,
    files: persistence.files,
    fileBlobs: persistence.fileBlobs,
    fileLifecycleStore: persistence.fileLifecycleStore,
  });
  const context = { paths, persistence, service };
  contexts.push(context);
  return context;
}

function source(value: string | Buffer): Readable {
  return Readable.from([typeof value === 'string' ? Buffer.from(value) : value]);
}

describe('FileService', () => {
  it('stores equal bytes once while creating distinct public logical Files', async () => {
    const context = setup();

    const first = await context.service.createPublicFile({
      filename: 'a.txt',
      purpose: 'user_data',
      mimeType: 'text/plain',
      source: source('same bytes'),
    });
    const second = await context.service.createPublicFile({
      filename: 'b.txt',
      purpose: 'vision',
      mimeType: 'text/plain',
      source: source('same bytes'),
    });

    expect(first.publicId).toMatch(/^file-[0-9a-f-]{36}$/);
    expect(second.publicId).toMatch(/^file-[0-9a-f-]{36}$/);
    expect(first.publicId).not.toBe(second.publicId);
    expect(first.blobId).toBe(second.blobId);
    expect(first.sha256).toBe(second.sha256);
    expect(await readFile(first.storagePath, 'utf8')).toBe('same bytes');
    expect(await readdir(join(context.paths.root, 'files', 'blobs'))).toEqual([first.sha256]);
    expect(context.persistence.fileBlobs.countReferences(first.blobId)).toBe(2);
  });

  it('rejects a stream above 32 MiB and removes the partial temp file', async () => {
    const context = setup();
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1, 0x61);

    await expect(
      context.service.createPublicFile({
        filename: 'too-large.bin',
        purpose: 'user_data',
        source: source(oversized),
      }),
    ).rejects.toMatchObject({ code: 'file_too_large' });

    expect(
      context.persistence.database.prepare('SELECT COUNT(*) AS count FROM files').get(),
    ).toMatchObject({ count: 0 });
    expect(
      context.persistence.database.prepare('SELECT COUNT(*) AS count FROM file_blobs').get(),
    ).toMatchObject({ count: 0 });
    expect(await readdir(join(context.paths.root, 'temp'))).toEqual([]);
  });

  it('tombstones immediately but keeps bytes until an active lease is released', async () => {
    const context = setup();
    const created = await context.service.createPublicFile({
      filename: 'leased.txt',
      purpose: 'user_data',
      source: source('leased'),
    });
    const lease = context.service.acquirePublicFile(created.publicId!);

    const deleted = await context.service.deletePublicFile(created.publicId!);

    expect(deleted).toMatchObject({ id: created.id, deletedAt: expect.any(Number) });
    expect(context.service.getPublicFile(created.publicId!)).toBeUndefined();
    expect(context.persistence.files.getById(created.id)).toBeDefined();
    await expect(stat(created.storagePath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });

    await lease.release();

    expect(context.persistence.files.getById(created.id)).toBeUndefined();
    expect(context.persistence.fileBlobs.getById(created.blobId)).toBeUndefined();
    await expect(stat(created.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a deleted File while Conversation Attachment history references it', async () => {
    const context = setup();
    const created = await context.service.createPublicFile({
      filename: 'history.txt',
      purpose: 'user_data',
      source: source('history bytes'),
    });
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const messageId = '22222222-2222-4222-8222-222222222222';
    const conversation: ConversationRecord = {
      id: conversationId,
      instructions: [],
      tools: [],
      toolChoice: { mode: 'auto' },
      sync: { status: 'clean', syncedMessageCount: 1 },
      createdAt: 1000,
      updatedAt: 1000,
      lastUsedAt: 1000,
    };
    const message: MessageRecord = {
      id: messageId,
      conversationId,
      sequence: 0,
      role: 'user',
      content: [{ type: 'attachment', attachmentId: 'attachment-1' }],
      createdAt: 1000,
      updatedAt: 1000,
    };
    context.persistence.conversations.insert(conversation);
    context.persistence.messages.insert(message);
    context.persistence.attachments.insert({
      id: '33333333-3333-4333-8333-333333333333',
      conversationId,
      messageId,
      localAttachmentId: 'attachment-1',
      kind: 'file',
      source: { type: 'file_id' },
      fileId: created.id,
      createdAt: 1000,
    });

    await context.service.deletePublicFile(created.publicId!);

    expect(context.persistence.files.getById(created.id)).toMatchObject({
      id: created.id,
      deletedAt: expect.any(Number),
    });
    await expect(readFile(created.storagePath, 'utf8')).resolves.toBe('history bytes');

    context.persistence.database
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(conversationId);
    await context.service.cleanup();

    expect(context.persistence.files.getById(created.id)).toBeUndefined();
    expect(context.persistence.fileBlobs.getById(created.blobId)).toBeUndefined();
  });

  it('cleans orphan part files and unreferenced Blob files without touching referenced bytes', async () => {
    const context = setup();
    const created = await context.service.createPrivateFile({
      filename: 'keep.txt',
      mimeType: 'text/plain',
      source: source('keep'),
    });
    const tempDir = join(context.paths.root, 'temp');
    const blobDir = join(context.paths.root, 'files', 'blobs');
    await mkdir(tempDir, { recursive: true });
    await mkdir(blobDir, { recursive: true });
    await writeFile(join(tempDir, 'orphan.part'), 'partial');
    const orphanHash = 'e'.repeat(64);
    await writeFile(join(blobDir, orphanHash), 'orphan');

    await context.service.cleanup();

    expect(await readdir(tempDir)).toEqual([]);
    expect(await readFile(created.storagePath, 'utf8')).toBe('keep');
    await expect(stat(join(blobDir, orphanHash))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
