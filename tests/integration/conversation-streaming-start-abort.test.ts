import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import type { NormalizedRequest } from '../../src/api/normalized.js';
import type {
  ChatGptStreamingTextDriver,
  ChatGptTextResult,
  ChatGptTextTurn,
} from '../../src/chatgpt/driver.js';
import { createConversationExecutionEngine } from '../../src/conversations/conversation-engine.js';
import type {
  ConversationPageRegistry,
  ConversationPageSession,
} from '../../src/conversations/page-registry.js';
import { createConversationQueue } from '../../src/conversations/conversation-queue.js';
import { createPersistenceContext, type PersistenceContext } from '../../src/persistence/index.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const resources: TempPersistencePaths[] = [];
const contexts: PersistenceContext[] = [];

afterEach(() => {
  while (contexts.length) contexts.pop()?.close();
  while (resources.length) resources.pop()?.cleanup();
});

function persistence(): PersistenceContext {
  const paths = createTempPersistencePaths();
  resources.push(paths);
  const context = createPersistenceContext({
    databasePath: paths.databasePath,
    migrationsDir: paths.migrationsDir,
  });
  contexts.push(context);
  return context;
}

class Registry implements ConversationPageRegistry {
  failed = 0;
  hasAffinity(): boolean {
    return false;
  }
  async acquire(): Promise<ConversationPageSession> {
    return {
      page: { isClosed: () => false } as unknown as Page,
      complete: async () => {},
      fail: async () => {
        this.failed += 1;
      },
    };
  }
  async close(): Promise<void> {}
}

class Driver implements ChatGptStreamingTextDriver {
  startCalls = 0;
  stopCalls = 0;
  async openFresh(): Promise<void> {}
  async openConversation(): Promise<'restored'> {
    return 'restored';
  }
  async startText(): Promise<ChatGptTextTurn> {
    this.startCalls += 1;
    return {
      observe: async () => ({
        exists: true,
        text: 'should not start',
        completionMarkerPresent: false,
      }),
      stop: async () => {
        this.stopCalls += 1;
        return 'stopped';
      },
      conversationUrl: async () => 'https://chatgpt.com/c/should-not-start',
    };
  }
  async sendText(): Promise<ChatGptTextResult> {
    throw new Error('non-stream path must not run');
  }
}

function request(): NormalizedRequest {
  return {
    requestId: 'abort-at-start',
    conversationKey: 'abort-at-start',
    instructions: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: true },
    diagnostics: { ignoredParameters: [] },
  };
}

describe('Streaming start abort boundary', () => {
  it('does not create a checkpoint or submit a web turn when the client aborts after started', async () => {
    const db = persistence();
    const driver = new Driver();
    const registry = new Registry();
    const controller = new AbortController();
    const execution = createConversationExecutionEngine({
      pageRegistry: registry,
      queue: createConversationQueue(),
      driver,
      conversationStore: db.conversationStore,
      randomUuid: () => '11111111-1111-4111-8111-111111111111',
      now: () => 1000,
    });

    await expect(
      execution.stream(request(), {
        signal: controller.signal,
        sink: async (event) => {
          if (event.type === 'started') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'stream_aborted' });

    expect(driver.startCalls).toBe(0);
    expect(driver.stopCalls).toBe(0);
    expect(db.conversationStore.loadByKey('abort-at-start')).toBeUndefined();
    expect(registry.failed).toBe(1);
  });
});
