import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { MigrationError } from './errors.js';
import { transaction } from './transaction.js';

const MIGRATION_FILE = /^([0-9]{3})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  appliedAt: number;
}

export interface RunMigrationsOptions {
  migrationsDir: string;
  now?: () => number;
}

interface MigrationFile {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  const files = readdirSync(migrationsDir, { withFileTypes: true });
  const migrations: MigrationFile[] = [];

  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.sql')) continue;

    const match = MIGRATION_FILE.exec(entry.name);
    if (!match) {
      throw new MigrationError(
        `Invalid migration filename: ${entry.name}`,
        'migration_filename_error',
      );
    }

    const version = Number(match[1]);
    const name = match[2] ?? '';
    const bytes = readFileSync(join(migrationsDir, entry.name));
    migrations.push({
      version,
      name,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      sql: bytes.toString('utf8'),
    });
  }

  migrations.sort((left, right) => left.version - right.version);
  for (let index = 0; index < migrations.length; index += 1) {
    const expected = index + 1;
    if (migrations[index]?.version !== expected) {
      throw new MigrationError(
        `Migration sequence must be contiguous from 001; expected ${String(expected).padStart(3, '0')}`,
        'migration_sequence_error',
      );
    }
  }

  return migrations;
}

function bootstrapMigrationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
}

function appliedMigrations(database: DatabaseSync): MigrationRecord[] {
  return database
    .prepare(
      'SELECT version, name, checksum, applied_at AS appliedAt FROM schema_migrations ORDER BY version ASC',
    )
    .all()
    .map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
      appliedAt: Number(row.appliedAt),
    }));
}

export function runMigrations(
  database: DatabaseSync,
  options: RunMigrationsOptions,
): MigrationRecord[] {
  const now = options.now ?? Date.now;
  const files = loadMigrationFiles(options.migrationsDir);
  bootstrapMigrationTable(database);

  const applied = appliedMigrations(database);
  for (const record of applied) {
    const file = files.find((candidate) => candidate.version === record.version);
    if (!file) {
      throw new MigrationError(
        `Applied migration ${record.version} is missing from the repository`,
        'migration_missing_error',
      );
    }
    if (file.checksum !== record.checksum) {
      throw new MigrationError(
        `Checksum mismatch for applied migration ${record.version}_${record.name}`,
        'migration_checksum_mismatch',
      );
    }
  }

  const appliedVersions = new Set(applied.map((record) => record.version));
  const insertHistory = database.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );
  const newlyApplied: MigrationRecord[] = [];

  for (const file of files) {
    if (appliedVersions.has(file.version)) continue;

    const appliedAt = now();
    try {
      transaction(database, () => {
        database.exec(file.sql);
        insertHistory.run(file.version, file.name, file.checksum, appliedAt);
      });
    } catch (error) {
      throw new MigrationError(
        `Failed to apply migration ${String(file.version).padStart(3, '0')}_${file.name}`,
        'migration_sql_error',
        error,
      );
    }

    newlyApplied.push({
      version: file.version,
      name: file.name,
      checksum: file.checksum,
      appliedAt,
    });
  }

  return newlyApplied;
}
