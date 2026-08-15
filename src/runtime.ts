import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { browserMaintenanceModeExecution } from './api/execution.js';
import { buildServer } from './api/server.js';
import {
  createBrowserManager as defaultCreateBrowserManager,
  type CreateBrowserManagerOptions,
} from './browser/browser-manager.js';
import type { BrowserManager } from './browser/types.js';
import { createChatGptDriver, type ChatGptDriver } from './chatgpt/driver.js';
import type { AppConfig } from './config/index.js';
import { createConversationExecutor } from './conversations/conversation-executor.js';
import {
  createConversationPageManager as defaultCreateConversationPageManager,
  type ConversationPageManager,
  type CreateConversationPageManagerOptions,
} from './conversations/conversation-pages.js';
import { createConversationQueue } from './conversations/conversation-queue.js';
import { createPersistenceContext, type PersistenceContext } from './persistence/index.js';

export interface CreateGatewayRuntimeOptions {
  config: AppConfig;
  logger?: boolean;
  migrationsDir?: string;
  browserProfileDir?: string;
  createBrowserManager?: (options: CreateBrowserManagerOptions) => Promise<BrowserManager>;
  createConversationPageManager?: (
    options: CreateConversationPageManagerOptions,
  ) => ConversationPageManager;
  driver?: ChatGptDriver;
}

export interface GatewayRuntime {
  readonly app: FastifyInstance;
  readonly persistence: PersistenceContext;
  readonly browser?: BrowserManager;
  readonly conversationPages?: ConversationPageManager;
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
  let conversationPages: ConversationPageManager | undefined;
  try {
    if (options.config.uiMode === 'headless') {
      browser = await (options.createBrowserManager ?? defaultCreateBrowserManager)({
        profileDir: options.browserProfileDir ?? join(options.config.dataDir, 'browser-profile'),
        maxActivePages: options.config.maxActivePages,
        ...(options.config.chatgptProxyServer
          ? { proxyServer: options.config.chatgptProxyServer }
          : {}),
      });
      conversationPages = (
        options.createConversationPageManager ?? defaultCreateConversationPageManager
      )({
        pagePool: browser.pages,
        idleTimeoutMs: options.config.pageIdleTimeoutMinutes * 60_000,
      });
    }
  } catch (error) {
    try {
      await conversationPages?.close();
    } finally {
      try {
        await browser?.close();
      } finally {
        persistence.close();
      }
    }
    throw error;
  }

  const execute =
    browser === undefined || conversationPages === undefined
      ? browserMaintenanceModeExecution
      : createConversationExecutor({
          pagePool: browser.pages,
          pageManager: conversationPages,
          queue: createConversationQueue(),
          driver: options.driver ?? createChatGptDriver(),
          conversationStore: persistence.conversationStore,
        });

  let app: FastifyInstance;
  try {
    app = buildServer({ config: options.config, execute, logger: options.logger ?? false });
  } catch (error) {
    try {
      await conversationPages?.close();
    } finally {
      try {
        await browser?.close();
      } finally {
        persistence.close();
      }
    }
    throw error;
  }

  let closed = false;
  return {
    app,
    persistence,
    ...(browser === undefined ? {} : { browser }),
    ...(conversationPages === undefined ? {} : { conversationPages }),
    async close() {
      if (closed) return;
      closed = true;
      try {
        await app.close();
      } finally {
        try {
          await conversationPages?.close();
        } finally {
          try {
            await browser?.close();
          } finally {
            persistence.close();
          }
        }
      }
    },
  };
}
