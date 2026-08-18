import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime } from '../../src/runtime.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const resources: TempPersistencePaths[] = [];

afterEach(() => {
  while (resources.length) resources.pop()?.cleanup();
});

describe('Gateway persistence startup', () => {
  it('migrates the runtime database before readiness and closes idempotently', async () => {
    const paths = createTempPersistencePaths();
    resources.push(paths);
    const dataDir = join(paths.root, 'data');
    const config = loadConfig({
      GATEWAY_API_KEY: 'test-key',
      DATA_DIR: dataDir,
      UI_MODE: 'novnc',
    });

    const runtime = await createGatewayRuntime({
      config,
      migrationsDir: paths.migrationsDir,
      logger: false,
    });
    const databasePath = join(dataDir, 'gateway.db');

    expect(existsSync(databasePath)).toBe(true);
    expect(
      runtime.persistence.database
        .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual([
      expect.objectContaining({ version: 1, name: 'initial' }),
      expect.objectContaining({ version: 2, name: 'add_conversation_sync_checkpoint' }),
      expect.objectContaining({ version: 3, name: 'add_file_blob_lifecycle' }),
    ]);

    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(() => runtime.persistence.database.prepare('SELECT 1').get()).toThrow();
  });
});
