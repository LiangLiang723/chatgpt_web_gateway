import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/persistence/database.js';
import { runMigrations } from '../../src/persistence/migrations.js';
import { FileBlobRepository } from '../../src/persistence/repositories/file-blobs.js';
import { FileRepository } from '../../src/persistence/repositories/files.js';
import type { FileBlobRecord, FileRecord } from '../../src/persistence/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

interface TestContext {
  paths: TempPersistencePaths;
  database: ReturnType<typeof openDatabase>;
  blobs: FileBlobRepository;
  files: FileRepository;
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
    blobs: new FileBlobRepository(database),
    files: new FileRepository(database),
  };
  contexts.push(context);
  return context;
}

function blob(overrides: Partial<FileBlobRecord> = {}): FileBlobRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    sizeBytes: 12,
    storagePath: '/data/files/blobs/' + 'a'.repeat(64),
    createdAt: 1000,
    ...overrides,
  };
}

function file(blobRecord: FileBlobRecord, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    publicId: 'file-33333333-3333-4333-8333-333333333333',
    blobId: blobRecord.id,
    filename: 'notes.txt',
    mimeType: 'text/plain',
    purpose: 'user_data',
    sizeBytes: blobRecord.sizeBytes,
    sha256: blobRecord.sha256,
    storagePath: blobRecord.storagePath,
    createdAt: 2000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('FileBlobRepository', () => {
  it('round-trips a Blob and finds it by SHA-256', () => {
    const context = setup();
    const record = blob();

    context.blobs.insert(record);

    expect(context.blobs.getById(record.id)).toEqual(record);
    expect(context.blobs.getBySha256(record.sha256)).toEqual(record);
    expect(context.blobs.getBySha256('missing')).toBeUndefined();
    expect(context.blobs.countReferences(record.id)).toBe(0);
  });

  it('enforces one physical Blob per SHA and storage path', () => {
    const context = setup();
    const record = blob();
    context.blobs.insert(record);

    expect(() =>
      context.blobs.insert(
        blob({
          id: '44444444-4444-4444-8444-444444444444',
          storagePath: '/data/files/blobs/other',
        }),
      ),
    ).toThrow();
    expect(() =>
      context.blobs.insert(
        blob({
          id: '55555555-5555-4555-8555-555555555555',
          sha256: 'b'.repeat(64),
        }),
      ),
    ).toThrow();
  });
});

describe('FileRepository blob projection', () => {
  it('joins logical File metadata to Blob metadata and counts references', () => {
    const context = setup();
    const blobRecord = blob();
    const fileRecord = file(blobRecord);
    context.blobs.insert(blobRecord);

    context.files.insert(fileRecord);

    expect(context.files.getById(fileRecord.id)).toEqual(fileRecord);
    expect(context.files.getByPublicId(fileRecord.publicId!)).toEqual(fileRecord);
    expect(context.files.findBySha256(blobRecord.sha256)).toEqual([fileRecord]);
    expect(context.blobs.countReferences(blobRecord.id)).toBe(1);
  });

  it('keeps distinct logical Files on one Blob and supports tombstone/delete', () => {
    const context = setup();
    const blobRecord = blob();
    const first = file(blobRecord);
    const second = file(blobRecord, {
      id: '66666666-6666-4666-8666-666666666666',
      publicId: undefined,
      filename: 'private.txt',
      purpose: undefined,
      createdAt: 3000,
      updatedAt: 3000,
    });
    context.blobs.insert(blobRecord);
    context.files.insert(first);
    context.files.insert(second);

    expect(context.files.findBySha256(blobRecord.sha256)).toEqual([first, second]);
    expect(context.files.countByBlobId(blobRecord.id)).toBe(2);

    context.files.markDeleted(first.id, 4000);
    expect(context.files.getById(first.id)).toEqual({
      ...first,
      deletedAt: 4000,
      updatedAt: 4000,
    });
    expect(context.files.getByPublicId(first.publicId!)).toBeUndefined();

    context.files.deleteById(second.id);
    expect(context.files.getById(second.id)).toBeUndefined();
    expect(context.files.countByBlobId(blobRecord.id)).toBe(1);
  });
});
