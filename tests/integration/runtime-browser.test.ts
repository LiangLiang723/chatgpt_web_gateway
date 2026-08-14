import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserManager, PagePool } from '../../src/browser/types.js';
import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime } from '../../src/runtime.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const resources: TempPersistencePaths[] = [];
const runtimes: Array<Awaited<ReturnType<typeof createGatewayRuntime>>> = [];

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()?.close();
  while (resources.length) resources.pop()?.cleanup();
});

function temp() {
  const paths = createTempPersistencePaths();
  resources.push(paths);
  return paths;
}

function fakeBrowserManager(close = vi.fn(async () => undefined)): BrowserManager {
  const pages: PagePool = {
    openCount: 0,
    leasedCount: 0,
    idleCount: 0,
    acquire: vi.fn(async () => ({
      page: {} as Page,
      release: vi.fn(async () => undefined),
    })),
    close: vi.fn(async () => undefined),
  };
  return {
    context: {} as BrowserContext,
    pages,
    close,
  };
}

describe('Gateway Browser runtime composition', () => {
  it('opens persistence before launching the headless product BrowserManager', async () => {
    const paths = temp();
    const dataDir = join(paths.root, 'data');
    const browser = fakeBrowserManager();
    const createBrowserManager = vi.fn(async () => {
      expect(existsSync(join(dataDir, 'gateway.db'))).toBe(true);
      return browser;
    });
    const config = loadConfig({ GATEWAY_API_KEY: 'test-key', DATA_DIR: dataDir });

    const runtime = await createGatewayRuntime({
      config,
      migrationsDir: paths.migrationsDir,
      createBrowserManager,
      logger: false,
    });
    runtimes.push(runtime);

    expect(createBrowserManager).toHaveBeenCalledWith({
      profileDir: join(dataDir, 'browser-profile'),
      maxActivePages: 4,
    });
    expect(runtime.browser).toBe(browser);
  });

  it('supports an explicit test-only Browser Profile override', async () => {
    const paths = temp();
    const profileDir = join(paths.root, 'isolated-e2e-profile');
    const createBrowserManager = vi.fn(async () => fakeBrowserManager());
    const config = loadConfig({ GATEWAY_API_KEY: 'test-key', DATA_DIR: join(paths.root, 'data') });

    const runtime = await createGatewayRuntime({
      config,
      migrationsDir: paths.migrationsDir,
      browserProfileDir: profileDir,
      createBrowserManager,
      logger: false,
    });
    runtimes.push(runtime);

    expect(createBrowserManager).toHaveBeenCalledWith({
      profileDir,
      maxActivePages: 4,
    });
  });

  it('does not start the product BrowserManager in noVNC maintenance mode', async () => {
    const paths = temp();
    const createBrowserManager = vi.fn(async () => fakeBrowserManager());
    const config = loadConfig({
      GATEWAY_API_KEY: 'test-key',
      DATA_DIR: join(paths.root, 'data'),
      UI_MODE: 'novnc',
    });

    const runtime = await createGatewayRuntime({
      config,
      migrationsDir: paths.migrationsDir,
      createBrowserManager,
      logger: false,
    });
    runtimes.push(runtime);

    expect(createBrowserManager).not.toHaveBeenCalled();
    expect(runtime.browser).toBeUndefined();

    const response = await runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-key' },
      payload: { model: 'chatgpt-web', messages: [{ role: 'user', content: 'Hello' }] },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('browser_maintenance_mode');
  });

  it('closes Fastify and Browser before persistence and remains idempotent', async () => {
    const paths = temp();
    const closeBrowser = vi.fn(async () => undefined);
    const browser = fakeBrowserManager(closeBrowser);
    const config = loadConfig({ GATEWAY_API_KEY: 'test-key', DATA_DIR: join(paths.root, 'data') });
    const runtime = await createGatewayRuntime({
      config,
      migrationsDir: paths.migrationsDir,
      createBrowserManager: async () => browser,
      logger: false,
    });

    await runtime.close();
    await runtime.close();

    expect(closeBrowser).toHaveBeenCalledTimes(1);
    expect(() => runtime.persistence.database.prepare('SELECT 1').get()).toThrow();
  });
});
