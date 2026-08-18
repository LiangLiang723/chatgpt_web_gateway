import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/persistence/database.js';
import { MigrationError, PersistenceError } from '../../src/persistence/errors.js';
import { runMigrations } from '../../src/persistence/migrations.js';
import { transaction } from '../../src/persistence/transaction.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const resources: TempPersistencePaths[] = [];

afterEach(() => {
  while (resources.length) resources.pop()?.cleanup();
});

function temp(options?: { copyMigrations?: boolean }): TempPersistencePaths {
  const paths = createTempPersistencePaths(options);
  resources.push(paths);
  return paths;
}

function tableNames(database: ReturnType<typeof openDatabase>): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

describe('SQLite database and migrations', () => {
  it('opens a file database with required pragmas and applies all schema migrations once', () => {
    const paths = temp();
    const database = openDatabase(paths.databasePath);

    expect(database.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(database.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });

    const applied = runMigrations(database, {
      migrationsDir: paths.migrationsDir,
      now: () => 1_786_714_000_000,
    });

    expect(applied).toEqual([
      expect.objectContaining({
        version: 1,
        name: 'initial',
        appliedAt: 1_786_714_000_000,
      }),
      expect.objectContaining({
        version: 2,
        name: 'add_conversation_sync_checkpoint',
        appliedAt: 1_786_714_000_000,
      }),
      expect.objectContaining({
        version: 3,
        name: 'add_file_blob_lifecycle',
        appliedAt: 1_786_714_000_000,
      }),
    ]);
    expect(applied.map((migration) => migration.checksum)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(
      database
        .prepare('PRAGMA table_info(conversations)')
        .all()
        .map((row) => String(row.name)),
    ).toEqual(expect.arrayContaining(['sync_status', 'synced_message_count', 'sync_started_at']));
    expect(tableNames(database)).toEqual(
      expect.arrayContaining([
        'attachments',
        'conversations',
        'file_blobs',
        'files',
        'generated_images',
        'messages',
        'schema_migrations',
        'tool_calls',
      ]),
    );
    expect(
      database
        .prepare('PRAGMA table_info(files)')
        .all()
        .map((row) => String(row.name)),
    ).toEqual(expect.arrayContaining(['public_id', 'blob_id', 'purpose', 'deleted_at']));

    expect(
      runMigrations(database, {
        migrationsDir: paths.migrationsDir,
        now: () => 1_786_714_000_001,
      }),
    ).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toMatchObject(
      {
        count: 3,
      },
    );

    closeDatabase(database);
  });

  it('migrates legacy duplicate-hash Files into one Blob while preserving logical ids and Attachment FKs', () => {
    const paths = temp({ copyMigrations: false });
    mkdirSync(paths.migrationsDir, { recursive: true });
    for (const filename of ['001_initial.sql', '002_add_conversation_sync_checkpoint.sql']) {
      writeFileSync(
        join(paths.migrationsDir, filename),
        readFileSync(join(process.cwd(), 'migrations', filename)),
      );
    }
    const database = openDatabase(paths.databasePath);
    runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 1000 });

    const conversationId = '11111111-1111-4111-8111-111111111111';
    const messageId = '22222222-2222-4222-8222-222222222222';
    const firstFileId = '33333333-3333-4333-8333-333333333333';
    const secondFileId = '44444444-4444-4444-8444-444444444444';
    database
      .prepare(
        `INSERT INTO conversations
         (id, conversation_key, chatgpt_conversation_url, instructions_json, tools_json,
          tool_choice_json, tool_fingerprint, created_at, updated_at, last_used_at,
          sync_status, synced_message_count, sync_started_at)
         VALUES (?, NULL, NULL, '[]', '[]', '{"mode":"auto"}', NULL, 1, 1, 1, 'clean', 1, NULL)`,
      )
      .run(conversationId);
    database
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, sequence, role, content_json, tool_call_id, created_at, updated_at)
         VALUES (?, ?, 0, 'user', '[{"type":"attachment","attachmentId":"attachment-1"}]', NULL, 1, 1)`,
      )
      .run(messageId, conversationId);
    const insertFile = database.prepare(
      `INSERT INTO files
       (id, filename, mime_type, size_bytes, sha256, storage_path, created_at, updated_at)
       VALUES (?, ?, 'text/plain', 4, 'samehash', ?, 1, 1)`,
    );
    insertFile.run(firstFileId, 'first.txt', '/data/files/first.txt');
    insertFile.run(secondFileId, 'second.txt', '/data/files/second.txt');
    database
      .prepare(
        `INSERT INTO attachments
         (id, conversation_id, message_id, local_attachment_id, kind, source_json, file_id, created_at)
         VALUES ('55555555-5555-4555-8555-555555555555', ?, ?, 'attachment-1', 'file',
                 '{"type":"file_id","fileId":"public-old"}', ?, 1)`,
      )
      .run(conversationId, messageId, secondFileId);

    writeFileSync(
      join(paths.migrationsDir, '003_add_file_blob_lifecycle.sql'),
      readFileSync(join(process.cwd(), 'migrations', '003_add_file_blob_lifecycle.sql')),
    );
    expect(
      runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 2000 }),
    ).toEqual([expect.objectContaining({ version: 3, name: 'add_file_blob_lifecycle' })]);

    const files = database
      .prepare(
        `SELECT f.id, f.blob_id AS blobId, b.sha256, b.size_bytes AS sizeBytes
         FROM files f JOIN file_blobs b ON b.id = f.blob_id ORDER BY f.id`,
      )
      .all();
    expect(files).toEqual([
      expect.objectContaining({ id: firstFileId, sha256: 'samehash', sizeBytes: 4 }),
      expect.objectContaining({ id: secondFileId, sha256: 'samehash', sizeBytes: 4 }),
    ]);
    expect(files[0]?.blobId).toBe(files[1]?.blobId);
    expect(database.prepare('SELECT file_id AS fileId FROM attachments').get()).toMatchObject({
      fileId: secondFileId,
    });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    closeDatabase(database);
  });

  it('rolls back migration 003 when one legacy hash has conflicting sizes', () => {
    const paths = temp({ copyMigrations: false });
    mkdirSync(paths.migrationsDir, { recursive: true });
    for (const filename of ['001_initial.sql', '002_add_conversation_sync_checkpoint.sql']) {
      writeFileSync(
        join(paths.migrationsDir, filename),
        readFileSync(join(process.cwd(), 'migrations', filename)),
      );
    }
    const database = openDatabase(paths.databasePath);
    runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 1000 });
    const insertFile = database.prepare(
      `INSERT INTO files
       (id, filename, size_bytes, sha256, storage_path, created_at, updated_at)
       VALUES (?, ?, ?, 'conflict', ?, 1, 1)`,
    );
    insertFile.run('66666666-6666-4666-8666-666666666666', 'a.bin', 1, '/data/files/a.bin');
    insertFile.run('77777777-7777-4777-8777-777777777777', 'b.bin', 2, '/data/files/b.bin');
    writeFileSync(
      join(paths.migrationsDir, '003_add_file_blob_lifecycle.sql'),
      readFileSync(join(process.cwd(), 'migrations', '003_add_file_blob_lifecycle.sql')),
    );

    expect(() =>
      runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 2000 }),
    ).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({
        name: 'MigrationError',
        code: 'migration_sql_error',
      }),
    );
    expect(tableNames(database)).not.toContain('file_blobs');
    expect(database.prepare('SELECT COUNT(*) AS count FROM files').get()).toMatchObject({
      count: 2,
    });
    expect(
      database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([expect.objectContaining({ version: 1 }), expect.objectContaining({ version: 2 })]);

    closeDatabase(database);
  });

  it.each([
    '001_initial.sql',
    '002_add_conversation_sync_checkpoint.sql',
    '003_add_file_blob_lifecycle.sql',
  ])('rejects a previously applied migration whose SQL bytes changed: %s', (migrationFilename) => {
    const paths = temp();
    const database = openDatabase(paths.databasePath);
    runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 1000 });

    const migrationPath = join(paths.migrationsDir, migrationFilename);
    writeFileSync(migrationPath, `${readFileSync(migrationPath, 'utf8')}\n-- tampered\n`);

    expect(() =>
      runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 2000 }),
    ).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({
        name: 'MigrationError',
        code: 'migration_checksum_mismatch',
      }),
    );

    closeDatabase(database);
  });

  it('rejects malformed or non-contiguous migration versions before applying them', () => {
    const paths = temp({ copyMigrations: false });
    mkdirSync(paths.migrationsDir, { recursive: true });
    writeFileSync(
      join(paths.migrationsDir, '001_initial.sql'),
      'CREATE TABLE one (id TEXT) STRICT;\n',
    );
    writeFileSync(
      join(paths.migrationsDir, '003_gap.sql'),
      'CREATE TABLE three (id TEXT) STRICT;\n',
    );
    const database = openDatabase(paths.databasePath);

    expect(() =>
      runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 1000 }),
    ).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({
        name: 'MigrationError',
        code: 'migration_sequence_error',
      }),
    );
    expect(tableNames(database)).not.toContain('one');

    closeDatabase(database);
  });

  it('rejects async transaction callbacks and rolls back their synchronous writes', () => {
    const paths = temp();
    const database = openDatabase(paths.databasePath);
    runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 1000 });
    database.exec('CREATE TABLE transaction_probe (value TEXT) STRICT;');

    expect(() =>
      transaction(database, async () => {
        database.prepare('INSERT INTO transaction_probe (value) VALUES (?)').run('should-rollback');
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PersistenceError>>({
        code: 'async_transaction_callback',
      }),
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM transaction_probe').get()).toMatchObject(
      {
        count: 0,
      },
    );

    closeDatabase(database);
  });

  it('rolls back a failed migration and does not write its history row', () => {
    const paths = temp({ copyMigrations: false });
    mkdirSync(paths.migrationsDir, { recursive: true });
    writeFileSync(
      join(paths.migrationsDir, '001_initial.sql'),
      'CREATE TABLE baseline (id TEXT PRIMARY KEY) STRICT;\n',
    );
    writeFileSync(
      join(paths.migrationsDir, '002_broken.sql'),
      'CREATE TABLE should_rollback (id TEXT PRIMARY KEY) STRICT;\nTHIS IS INVALID SQL;\n',
    );
    const database = openDatabase(paths.databasePath);

    expect(() =>
      runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 1000 }),
    ).toThrowError(
      expect.objectContaining<Partial<MigrationError>>({
        name: 'MigrationError',
        code: 'migration_sql_error',
      }),
    );

    expect(tableNames(database)).toContain('baseline');
    expect(tableNames(database)).not.toContain('should_rollback');
    expect(
      database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([expect.objectContaining({ version: 1 })]);

    closeDatabase(database);
  });
});
