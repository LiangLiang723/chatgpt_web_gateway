import { createHash, timingSafeEqual } from 'node:crypto';

import { AuthenticationError } from './errors.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function authenticateBearer(header: string | undefined, expectedKey: string): void {
  if (!header) {
    throw new AuthenticationError('Missing Authorization: Bearer token');
  }

  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    throw new AuthenticationError('Authorization header must use the Bearer scheme');
  }

  const suppliedKey = match[1];
  if (!timingSafeEqual(digest(suppliedKey), digest(expectedKey))) {
    throw new AuthenticationError('Invalid API key');
  }
}
