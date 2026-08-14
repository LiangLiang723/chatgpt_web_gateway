import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { browserMaintenanceModeExecution } from './api/execution.js';
import { buildServer } from './api/server.js';
import {
  createBrowserManager as defaultCreateBrowserManager,
  type CreateBrowserManagerOptions,
} from './browser/browser-manager.js';
import type { BrowserManager } from './browser/types.js';
import { createChatGptDriver } from './chatgpt/driver.js';
import type { AppConfig } from './config/index.js';
import { createPhase3Executor } from './conversations/phase3-executor.js';
import { createPersistenceContext, type PersistenceContext } from './persistence/index.js';

export interface CreateGatewayRuntimeOptions {
  config: AppConfig;
  logger?: boolean;
  migrationsDir?: string;
  browserProfileDir?: string;
  createBrowserManager?: (options: CreateBrowserManagerOptions) => Promise<BrowserManager>;
}

export interface GatewayRuntime {
  readonly app: FastifyInstance;
  readonly persistence: PersistenceContext;
  readonly browser?: BrowserManager;
  close(): Promise<void>;
}

export async function createGatewayRuntime(
  options: CreateGatewayRuntimeOptions,
): Promise<GatewayRuntime> {
  const persistence = createPersistenceContext({
    databasePath: join(options.config.dataDir, 'gateway.db'),
    ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir }),
  });

  let browser: BrowserManager | undefined;
  try {
    if (options.config.uiMode === 'headless') {
      browser = await (options.createBrowserManager ?? defaultCreateBrowserManager)({
        profileDir: options.browserProfileDir ?? join(options.config.dataDir, 'browser-profile'),
        maxActivePages: options.config.maxActivePages,
      });
    }
  } catch (error) {
    persistence.close();
    throw error;
  }

  const execute =
    browser === undefined
      ? browserMaintenanceModeExecution
      : createPhase3Executor({
          pagePool: browser.pages,
          driver: createChatGptDriver(),
        });

  let app: FastifyInstance;
  try {
    app = buildServer({ config: options.config, execute, logger: options.logger ?? false });
  } catch (error) {
    try {
      await browser?.close();
    } finally {
      persistence.close();
    }
    throw error;
  }

  let closed = false;
  return {
    app,
    persistence,
    ...(browser === undefined ? {} : { browser }),
    async close() {
      if (closed) return;
      closed = true;
      try {
        await app.close();
      } finally {
        try {
          await browser?.close();
        } finally {
          persistence.close();
        }
      }
    },
  };
}
