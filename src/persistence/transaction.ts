import type { DatabaseSync } from 'node:sqlite';

import { PersistenceError } from './errors.js';

function asyncTransactionError(): PersistenceError {
  return new PersistenceError(
    'SQLite transaction callbacks must be synchronous',
    'async_transaction_callback',
  );
}

export function transaction<T>(database: DatabaseSync, work: () => T): T {
  if (work.constructor.name === 'AsyncFunction') {
    throw asyncTransactionError();
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    if (
      typeof result === 'object' &&
      result !== null &&
      'then' in result &&
      typeof result.then === 'function'
    ) {
      void Promise.resolve(result).catch(() => undefined);
      throw asyncTransactionError();
    }
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}
