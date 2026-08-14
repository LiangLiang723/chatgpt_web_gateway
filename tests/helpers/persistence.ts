import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TempPersistencePaths {
  root: string;
  databasePath: string;
  migrationsDir: string;
  cleanup(): void;
}

export function createTempPersistencePaths(
  options: { copyMigrations?: boolean } = {},
): TempPersistencePaths {
  const root = mkdtempSync(join(tmpdir(), 'chatgpt-web-gateway-persistence-'));
  const migrationsDir = join(root, 'migrations');

  if (options.copyMigrations ?? true) {
    const sourceMigrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
    cpSync(sourceMigrations, migrationsDir, { recursive: true });
  }

  return {
    root,
    databasePath: join(root, 'gateway.db'),
    migrationsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
