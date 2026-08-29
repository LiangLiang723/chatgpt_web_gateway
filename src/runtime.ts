import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { FileService } from './attachments/file-service.js';
import { AttachmentResolver } from './attachments/resolver.js';
import { AttachmentStager } from './attachments/staging.js';
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
import { createChatGptImageDriver, type ChatGptImageDriver } from './chatgpt/image-driver.js';
import type { AppConfig } from './config/index.js';
import { createConversationExecutionEngine } from './conversations/conversation-engine.js';
import {
  createRuntimeDiagnosticsProvider,
  type RuntimeDiagnosticsProvider,
} from './diagnostics/runtime.js';
import {
  createConversationPageRegistry as defaultCreateConversationPageRegistry,
  type ConversationPageRegistry,
  type CreateConversationPageRegistryOptions,
} from './conversations/page-registry.js';
import {
  createConversationQueue as defaultCreateConversationQueue,
  type ConversationQueue,
} from './conversations/conversation-queue.js';
import { ImageGenerationService } from './images/service.js';
import { ImageStorage } from './images/storage.js';
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
  imageDriver?: ChatGptImageDriver;
  onBrowserFatal?: () => void;
}

export interface GatewayRuntime {
  readonly app: FastifyInstance;
  readonly persistence: PersistenceContext;
  readonly fileService: FileService;
  readonly attachmentResolver: AttachmentResolver;
  readonly imageService: ImageGenerationService;
  readonly diagnostics: RuntimeDiagnosticsProvider;
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
  const fileService = new FileService({
    dataDir: options.config.dataDir,
    attachments: persistence.attachments,
    files: persistence.files,
    fileBlobs: persistence.fileBlobs,
    fileLifecycleStore: persistence.fileLifecycleStore,
  });
  const attachmentResolver = new AttachmentResolver({
    fileService,
    stager: new AttachmentStager({ dataDir: options.config.dataDir }),
  });
  const imageStorage = new ImageStorage({ dataDir: options.config.dataDir });
  try {
    await fileService.cleanup();
    await imageStorage.initialize();
  } catch (error) {
    persistence.close();
    throw error;
  }

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
        ...(options.onBrowserFatal === undefined
          ? {}
          : { onUnexpectedClose: options.onBrowserFatal }),
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

  const imageService = new ImageGenerationService({
    storage: imageStorage,
    repository: persistence.generatedImages,
    ...(browser === undefined
      ? {}
      : {
          pagePool: browser.pages,
          driver: options.imageDriver ?? createChatGptImageDriver(),
        }),
  });

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
          attachmentResolver,
        });

  const diagnostics = createRuntimeDiagnosticsProvider({
    config: options.config,
    ...(browser === undefined ? {} : { browser }),
  });

  let app: FastifyInstance;
  try {
    app = buildServer({
      config: options.config,
      execute: execution.execute,
      stream: execution.stream,
      fileService,
      imageService,
      diagnostics,
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
    fileService,
    attachmentResolver,
    imageService,
    diagnostics,
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
