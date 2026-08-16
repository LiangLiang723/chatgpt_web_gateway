import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import {
  browserMaintenanceModeExecution,
  browserMaintenanceModeStreamingExecution,
  type ConversationExecutionEngine,
} from './api/execution.js';
import { buildServer } from './api/server.js';
import {
  createBrowserManager as defaultCreateBrowserManager,
  type CreateBrowserManagerOptions,
} from './browser/browser-manager.js';
import type { BrowserManager } from './browser/types.js';
import { createChatGptDriver, type ChatGptTextDriver } from './chatgpt/driver.js';
import type { AppConfig } from './config/index.js';
import { createConversationExecutionEngine } from './conversations/conversation-engine.js';
import {
  createConversationPageRegistry as defaultCreateConversationPageRegistry,
  type ConversationPageRegistry,
  type CreateConversationPageRegistryOptions,
} from './conversations/page-registry.js';
import {
  createConversationQueue as defaultCreateConversationQueue,
  type ConversationQueue,
} from './conversations/conversation-queue.js';
import { createPersistenceContext, type PersistenceContext } from './persistence/index.js';

export interface CreateGatewayRuntimeOptions {
  config: AppConfig;
  logger?: boolean;
  migrationsDir?: string;
  browserProfileDir?: string;
  createBrowserManager?: (options: CreateBrowserManagerOptions) => Promise<BrowserManager>;
  createConversationPageRegistry?: (
    options: CreateConversationPageRegistryOptions,
  ) => ConversationPageRegistry;
  createConversationQueue?: () => ConversationQueue;
  driver?: ChatGptTextDriver;
}

export interface GatewayRuntime {
  readonly app: FastifyInstance;
  readonly persistence: PersistenceContext;
  readonly browser?: BrowserManager;
  readonly pageRegistry?: ConversationPageRegistry;
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
  let pageRegistry: ConversationPageRegistry | undefined;
  let conversationQueue: ConversationQueue | undefined;

  const closeExecutionResources = async (): Promise<void> => {
    try {
      conversationQueue?.close();
    } finally {
      try {
        await pageRegistry?.close();
      } finally {
        await browser?.close();
      }
    }
  };

  try {
    if (options.config.uiMode === 'headless') {
      browser = await (options.createBrowserManager ?? defaultCreateBrowserManager)({
        profileDir: options.browserProfileDir ?? join(options.config.dataDir, 'browser-profile'),
        maxActivePages: options.config.maxActivePages,
        ...(options.config.chatgptProxyServer
          ? { proxyServer: options.config.chatgptProxyServer }
          : {}),
      });
      pageRegistry = (
        options.createConversationPageRegistry ?? defaultCreateConversationPageRegistry
      )({
        pagePool: browser.pages,
        idleTimeoutMs: options.config.pageIdleTimeoutMinutes * 60_000,
      });
      conversationQueue = (options.createConversationQueue ?? defaultCreateConversationQueue)();
    }
  } catch (error) {
    try {
      await closeExecutionResources();
    } finally {
      persistence.close();
    }
    throw error;
  }

  const execution: ConversationExecutionEngine =
    browser === undefined || pageRegistry === undefined || conversationQueue === undefined
      ? {
          execute: browserMaintenanceModeExecution,
          stream: browserMaintenanceModeStreamingExecution,
        }
      : createConversationExecutionEngine({
          pageRegistry,
          queue: conversationQueue,
          driver: options.driver ?? createChatGptDriver(),
          conversationStore: persistence.conversationStore,
        });

  let app: FastifyInstance;
  try {
    app = buildServer({
      config: options.config,
      execute: execution.execute,
      stream: execution.stream,
      logger: options.logger ?? false,
    });
  } catch (error) {
    try {
      await closeExecutionResources();
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
    ...(pageRegistry === undefined ? {} : { pageRegistry }),
    async close() {
      if (closed) return;
      closed = true;
      try {
        await app.close();
      } finally {
        try {
          await closeExecutionResources();
        } finally {
          persistence.close();
        }
      }
    },
  };
}
