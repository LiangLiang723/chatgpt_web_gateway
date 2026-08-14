import { DataIntegrityError } from './errors.js';

export function encodeJson(value: unknown): string {
  if (value === undefined) {
    throw new DataIntegrityError('Cannot persist undefined as a top-level JSON value');
  }

  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new DataIntegrityError('Value cannot be represented as JSON');
  }
  return encoded;
}

export function decodeJson<T>(context: string, value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new DataIntegrityError(`Invalid persisted JSON in ${context}`, error);
  }
}
