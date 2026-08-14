import { describe, expect, it } from 'vitest';

import { authenticateBearer } from '../../src/api/auth.js';
import { AuthenticationError } from '../../src/api/errors.js';

describe('authenticateBearer', () => {
  it('accepts the exact configured Bearer token', () => {
    expect(() => authenticateBearer('Bearer test-key', 'test-key')).not.toThrow();
  });

  it('rejects a missing Authorization header without leaking the key', () => {
    expect(() => authenticateBearer(undefined, 'super-secret')).toThrow(AuthenticationError);

    try {
      authenticateBearer(undefined, 'super-secret');
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
    }
  });

  it('rejects unsupported authorization schemes', () => {
    expect(() => authenticateBearer('Basic abc', 'test-key')).toThrow(/Bearer/);
  });

  it('rejects a wrong Bearer token without leaking either secret', () => {
    try {
      authenticateBearer('Bearer supplied-secret', 'configured-secret');
      throw new Error('authentication unexpectedly succeeded');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(String(error)).not.toContain('supplied-secret');
      expect(String(error)).not.toContain('configured-secret');
    }
  });
});
