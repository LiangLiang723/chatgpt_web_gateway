import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cloneRealE2EProfile } from '../e2e/profile.js';

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('real ChatGPT E2E Profile clone', () => {
  it('copies authenticated Profile state without Chromium Singleton markers', () => {
    const source = join(tempRoot('cwg-e2e-source-'), 'profile');
    const stateFile = join(source, 'Default', 'state.txt');
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, 'authenticated-state');
    symlinkSync('old-container-1', join(source, 'SingletonLock'));
    symlinkSync('/tmp/missing-singleton-socket', join(source, 'SingletonSocket'));
    writeFileSync(join(source, 'SingletonCookie'), 'stale-cookie');

    const clone = cloneRealE2EProfile(source);
    tempRoots.push(clone.rootDir);

    expect(readFileSync(join(clone.profileDir, 'Default', 'state.txt'), 'utf8')).toBe(
      'authenticated-state',
    );
    expect(existsSync(join(clone.profileDir, 'SingletonLock'))).toBe(false);
    expect(existsSync(join(clone.profileDir, 'SingletonSocket'))).toBe(false);
    expect(existsSync(join(clone.profileDir, 'SingletonCookie'))).toBe(false);

    clone.cleanup();
    expect(existsSync(clone.rootDir)).toBe(false);
    expect(readFileSync(stateFile, 'utf8')).toBe('authenticated-state');
  });
});
