import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const CHROMIUM_SINGLETON_MARKERS = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);

export interface RealE2EProfileClone {
  rootDir: string;
  profileDir: string;
  cleanup(): void;
}

export function cloneRealE2EProfile(sourceProfileDir: string): RealE2EProfileClone {
  const rootDir = mkdtempSync(join(tmpdir(), 'cwg-real-e2e-profile-'));
  const profileDir = join(rootDir, 'profile');

  try {
    cpSync(sourceProfileDir, profileDir, {
      recursive: true,
      filter: (source) => !CHROMIUM_SINGLETON_MARKERS.has(basename(source)),
    });
  } catch (error) {
    rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  return {
    rootDir,
    profileDir,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
