import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserManager, PagePool } from '../../src/browser/types.js';
import { loadConfig } from '../../src/config/index.js';
import type { ConversationPageManager } from '../../src/conversations/conversation-pages.js';
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

function fakeConversationPageManager(
  close: () => Promise<void> = vi.fn(async (): Promise<void> => undefined),
): ConversationPageManager {
  return {
    affinityCount: 0,
    hasWarmPage: vi.fn(() => false),
    acquire: vi.fn(async () => {
      throw new Error('not used by runtime composition test');
    }),
    sweepIdle: vi.fn(async () => undefined),
    close,
  };
}

function fakeBrowserManager(
  close: () => Promise<void> = vi.fn(async (): Promise<void> => undefined),
): BrowserManager {
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
  it('opens persistence before BrowserManager and wires configured Conversation Page idle timeout', async () => {
    const paths = temp();
    const dataDir = join(paths.root, 'data');
    const browser = fakeBrowserManager();
    const createBrowserManager = vi.fn(async () => {
      expect(existsSync(join(dataDir, 'gateway.db'))).toBe(true);
      return browser;
    });
    const conversationPages = fakeConversationPageManager();
    const createConversationPageManager = vi.fn(() => conversationPages);
    const config = loadConfig({
      GATEWAY_API_KEY: 'test-key',
      DATA_DIR: dataDir,
      CHATGPT_PROXY_SERVER: 'http://proxy.example:7890',
      PAGE_IDLE_TIMEOUT_MINUTES: '12',
    });

    const runtime = await createGatewayRuntime({
      config,
      migrationsDir: paths.migrationsDir,
      createBrowserManager,
      createConversationPageManager,
      logger: false,
    });
    runtimes.push(runtime);

    expect(createBrowserManager).toHaveBeenCalledWith({
      profileDir: join(dataDir, 'browser-profile'),
      maxActivePages: 4,
      proxyServer: 'http://proxy.example:7890',
    });
    expect(createConversationPageManager).toHaveBeenCalledWith({
      pagePool: browser.pages,
      idleTimeoutMs: 12 * 60_000,
    });
    expect(runtime.browser).toBe(browser);
    expect(runtime.conversationPages).toBe(conversationPages);
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
      createConversationPageManager: () => fakeConversationPageManager(),
      logger: false,
    });
    runtimes.push(runtime);

    expect(createBrowserManager).toHaveBeenCalledWith({
      profileDir,
      maxActivePages: 4,
    });
  });

  it('does not start BrowserManager or Conversation Pages in noVNC maintenance mode', async () => {
    const paths = temp();
    const createBrowserManager = vi.fn(async () => fakeBrowserManager());
    const createConversationPageManager = vi.fn(() => fakeConversationPageManager());
    const config = loadConfig({
      GATEWAY_API_KEY: 'test-key',
      DATA_DIR: join(paths.root, 'data'),
      UI_MODE: 'novnc',
    });

    const runtime = await createGatewayRuntime({
      config,
      migrationsDir: paths.migrationsDir,
      createBrowserManager,
      createConversationPageManager,
      logger: false,
    });
    runtimes.push(runtime);

    expect(createBrowserManager).not.toHaveBeenCalled();
    expect(createConversationPageManager).not.toHaveBeenCalled();
    expect(runtime.browser).toBeUndefined();
    expect(runtime.conversationPages).toBeUndefined();

    const response = await runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-key' },
      payload: { model: 'chatgpt-web', messages: [{ role: 'user', content: 'Hello' }] },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('browser_maintenance_mode');
  });

  it('closes Fastify, Conversation Pages, Browser, then persistence and remains idempotent', async () => {
    const paths = temp();
    const order: string[] = [];
    let runtime!: Awaited<ReturnType<typeof createGatewayRuntime>>;
    const closePages = vi.fn(async () => {
      order.push('pages');
      expect(runtime.persistence.database.prepare('SELECT 1').get()).toBeDefined();
    });
    const closeBrowser = vi.fn(async () => {
      order.push('browser');
      expect(runtime.persistence.database.prepare('SELECT 1').get()).toBeDefined();
    });
    const browser = fakeBrowserManager(closeBrowser);
    const config = loadConfig({ GATEWAY_API_KEY: 'test-key', DATA_DIR: join(paths.root, 'data') });
    runtime = await createGatewayRuntime({
      config,
      migrationsDir: paths.migrationsDir,
      createBrowserManager: async () => browser,
      createConversationPageManager: () => fakeConversationPageManager(closePages),
      logger: false,
    });
    runtime.app.addHook('onClose', async () => {
      order.push('app');
    });

    await runtime.close();
    await runtime.close();

    expect(order).toEqual(['app', 'pages', 'browser']);
    expect(closePages).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
    expect(() => runtime.persistence.database.prepare('SELECT 1').get()).toThrow();
  });
});
