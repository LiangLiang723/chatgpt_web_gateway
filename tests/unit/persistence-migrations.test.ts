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
  it('opens a file database with required pragmas and applies the initial schema once', () => {
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
    ]);
    expect(applied[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(tableNames(database)).toEqual(
      expect.arrayContaining([
        'attachments',
        'conversations',
        'files',
        'generated_images',
        'messages',
        'schema_migrations',
        'tool_calls',
      ]),
    );

    expect(
      runMigrations(database, {
        migrationsDir: paths.migrationsDir,
        now: () => 1_786_714_000_001,
      }),
    ).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toMatchObject(
      {
        count: 1,
      },
    );

    closeDatabase(database);
  });

  it('rejects a previously applied migration whose SQL bytes changed', () => {
    const paths = temp();
    const database = openDatabase(paths.databasePath);
    runMigrations(database, { migrationsDir: paths.migrationsDir, now: () => 1000 });

    const migrationPath = join(paths.migrationsDir, '001_initial.sql');
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
