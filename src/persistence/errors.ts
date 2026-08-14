export class PersistenceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'PersistenceError';
  }
}

export class MigrationError extends PersistenceError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, code, cause);
    this.name = 'MigrationError';
  }
}

export class DataIntegrityError extends PersistenceError {
  constructor(message: string, cause?: unknown) {
    super(message, 'data_integrity_error', cause);
    this.name = 'DataIntegrityError';
  }
}
