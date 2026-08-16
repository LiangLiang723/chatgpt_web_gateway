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
import type { AssistantSnapshot, StreamClock } from '../../src/stream/types.js';
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

function request(key: string, text: string): NormalizedRequest {
  return {
    requestId: `${key}-${text}`,
    conversationKey: key,
    instructions: [],
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: true },
    diagnostics: { ignoredParameters: [] },
  };
}

class FakeRegistry implements ConversationPageRegistry {
  completed = 0;
  failed = 0;

  hasAffinity(): boolean {
    return false;
  }

  async acquire(): Promise<ConversationPageSession> {
    let done = false;
    return {
      page: { isClosed: () => false } as unknown as Page,
      complete: async () => {
        if (done) return;
        done = true;
        this.completed += 1;
      },
      fail: async () => {
        if (done) return;
        done = true;
        this.failed += 1;
      },
    };
  }

  async close(): Promise<void> {}
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class GatedDriver implements ChatGptStreamingTextDriver {
  readonly gates: Array<Deferred | undefined> = [];
  readonly started: number[] = [];
  startCount = 0;

  async openFresh(): Promise<void> {}

  async openConversation(): Promise<'restored'> {
    return 'restored';
  }

  async startText(): Promise<ChatGptTextTurn> {
    const index = this.startCount++;
    this.started.push(index);
    const gate = this.gates[index];
    let firstObservation = true;
    const snapshot: AssistantSnapshot = {
      exists: true,
      text: `assistant-${index + 1}`,
      completionMarkerPresent: true,
    };
    return {
      observe: async () => {
        if (firstObservation) {
          firstObservation = false;
          await gate?.promise;
        }
        return snapshot;
      },
      stop: async () => 'already_complete',
      conversationUrl: async () => `https://chatgpt.com/c/stream-${index + 1}`,
    };
  }

  async sendText(): Promise<ChatGptTextResult> {
    throw new Error('non-stream path must not run');
  }
}

function clock(): StreamClock {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

function engine(options: {
  db: PersistenceContext;
  driver: GatedDriver;
  registry: FakeRegistry;
}) {
  let id = 0;
  return createConversationExecutionEngine({
    pageRegistry: options.registry,
    queue: createConversationQueue(),
    driver: options.driver,
    conversationStore: options.db.conversationStore,
    randomUuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    now: () => 1000 + id,
    streamClock: clock(),
    streamPollIntervalMs: 1,
    streamTimeoutMs: 100,
  });
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function discard() {}

describe('Streaming Conversation consistency', () => {
  it('holds same-key FIFO until the first stream has fully finalized', async () => {
    const db = persistence();
    const driver = new GatedDriver();
    const registry = new FakeRegistry();
    const firstGate = deferred();
    driver.gates.push(firstGate, undefined);
    const execution = engine({ db, driver, registry });

    const first = execution.stream(request('same-key', 'first'), {
      signal: new AbortController().signal,
      sink: discard,
    });
    await tick();
    expect(driver.startCount).toBe(1);

    const second = execution.stream(request('same-key', 'second'), {
      signal: new AbortController().signal,
      sink: discard,
    });
    await tick();
    expect(driver.startCount).toBe(1);

    firstGate.resolve();
    await first;
    await second;

    expect(driver.startCount).toBe(2);
    expect(registry.completed).toBe(2);
    expect(db.conversationStore.loadByKey('same-key')?.conversation.sync.status).toBe('clean');
  });

  it('allows different-key streams to enter the Driver concurrently', async () => {
    const db = persistence();
    const driver = new GatedDriver();
    const registry = new FakeRegistry();
    const firstGate = deferred();
    const secondGate = deferred();
    driver.gates.push(firstGate, secondGate);
    const execution = engine({ db, driver, registry });

    const first = execution.stream(request('key-a', 'first'), {
      signal: new AbortController().signal,
      sink: discard,
    });
    const second = execution.stream(request('key-b', 'second'), {
      signal: new AbortController().signal,
      sink: discard,
    });
    await tick();

    expect(driver.startCount).toBe(2);
    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([first, second]);
    expect(registry.completed).toBe(2);
  });

  it('keeps in_flight and never emits completed when the final clean save fails', async () => {
    const db = persistence();
    const driver = new GatedDriver();
    const registry = new FakeRegistry();
    const execution = engine({ db, driver, registry });
    const originalSave = db.conversationStore.save.bind(db.conversationStore);
    db.conversationStore.save = (aggregate) => {
      if (aggregate.conversation.sync.status === 'clean') {
        throw new Error('final-save-failure');
      }
      originalSave(aggregate);
    };
    const events: string[] = [];

    await expect(
      execution.stream(request('save-failure', 'first'), {
        signal: new AbortController().signal,
        sink: async (event) => {
          events.push(event.type);
        },
      }),
    ).rejects.toThrow('final-save-failure');

    expect(events).toContain('started');
    expect(events).not.toContain('completed');
    expect(registry.completed).toBe(0);
    expect(registry.failed).toBe(1);
    expect(db.conversationStore.loadByKey('save-failure')?.conversation.sync.status).toBe(
      'in_flight',
    );
  });
});
