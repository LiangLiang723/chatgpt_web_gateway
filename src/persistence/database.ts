import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PersistenceError } from './errors.js';

function readPragmaNumber(database: DatabaseSync, sql: string, key: string): number {
  const row = database.prepare(sql).get();
  const value = row?.[key];
  return typeof value === 'number' ? value : Number(value);
}

export function openDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA busy_timeout = 5000;');

    const foreignKeys = readPragmaNumber(database, 'PRAGMA foreign_keys', 'foreign_keys');
    const journalMode = String(database.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '');
    const busyTimeout = readPragmaNumber(database, 'PRAGMA busy_timeout', 'timeout');

    if (
      foreignKeys !== 1 ||
      (databasePath !== ':memory:' && journalMode.toLowerCase() !== 'wal') ||
      busyTimeout !== 5000
    ) {
      throw new PersistenceError(
        'SQLite runtime pragmas do not match the required persistence configuration',
        'database_configuration_error',
      );
    }

    return database;
  } catch (error) {
    database.close();
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError(
      'Failed to configure SQLite database',
      'database_configuration_error',
      error,
    );
  }
}

export function closeDatabase(database: DatabaseSync): void {
  database.close();
}
