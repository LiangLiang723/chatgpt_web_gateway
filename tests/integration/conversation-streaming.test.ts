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
import type { ConversationQueue } from '../../src/conversations/conversation-queue.js';
import { createPersistenceContext, type PersistenceContext } from '../../src/persistence/index.js';
import type { ConversationAggregate } from '../../src/persistence/types.js';
import { TextStreamAbortedError } from '../../src/stream/errors.js';
import type { AssistantSnapshot, StreamClock } from '../../src/stream/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const resources: TempPersistencePaths[] = [];
const contexts: PersistenceContext[] = [];
const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const oldUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const oldAssistantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

function streamRequest(
  conversationKey = 'stream-thread',
  messages: NormalizedRequest['messages'] = [
    { role: 'user', content: [{ type: 'text', text: 'stream this reply' }] },
  ],
): NormalizedRequest {
  return {
    requestId: 'stream-request',
    conversationKey,
    instructions: [{ role: 'system', content: 'system-v1' }],
    messages,
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: true },
    diagnostics: { ignoredParameters: [] },
  };
}

function seedStoredConversation(db: PersistenceContext, conversationKey = 'stream-thread'): void {
  const aggregate: ConversationAggregate = {
    conversation: {
      id: conversationId,
      conversationKey,
      instructions: [{ role: 'system', content: 'system-v1' }],
      tools: [],
      toolChoice: { mode: 'auto' },
      chatgptConversationUrl: 'https://chatgpt.com/c/stored-thread',
      sync: { status: 'clean', syncedMessageCount: 2 },
      createdAt: 100,
      updatedAt: 200,
      lastUsedAt: 200,
    },
    messages: [
      {
        id: oldUserId,
        conversationId,
        role: 'user',
        content: [{ type: 'text', text: 'old user' }],
        createdAt: 100,
        sequence: 0,
      },
      {
        id: oldAssistantId,
        conversationId,
        role: 'assistant',
        content: [{ type: 'text', text: 'old assistant' }],
        createdAt: 150,
        sequence: 1,
      },
    ],
    toolCalls: [],
    attachments: [],
    generatedImages: [],
  };
  db.conversationStore.save(aggregate);
}

class FakePage {
  isClosed(): boolean {
    return false;
  }
}

class FakePageRegistry implements ConversationPageRegistry {
  readonly completed: Array<string | undefined> = [];
  readonly failed: Array<string | undefined> = [];
  affinity = false;

  hasAffinity(): boolean {
    return this.affinity;
  }

  async acquire(conversationIdValue?: string): Promise<ConversationPageSession> {
    let done = false;
    return {
      page: new FakePage() as unknown as Page,
      complete: async () => {
        if (done) return;
        done = true;
        this.completed.push(conversationIdValue);
      },
      fail: async () => {
        if (done) return;
        done = true;
        this.failed.push(conversationIdValue);
      },
    };
  }

  async close(): Promise<void> {}
}

class DirectQueue implements ConversationQueue {
  readonly keys: string[] = [];
  closed = false;
  get pendingKeyCount(): number {
    return 0;
  }
  async run<T>(conversationKey: string, work: () => Promise<T>): Promise<T> {
    this.keys.push(conversationKey);
    return work();
  }
  close(): void {
    this.closed = true;
  }
}

class FakeStreamingDriver implements ChatGptStreamingTextDriver {
  readonly snapshots: AssistantSnapshot[] = [];
  readonly prompts: string[] = [];
  readonly restoredUrls: string[] = [];
  openFreshCalls = 0;
  onStart?: () => void;
  stopCalls = 0;
  conversationUrlValue = 'https://chatgpt.com/c/stream-thread';

  async openFresh(): Promise<void> {
    this.openFreshCalls += 1;
  }

  async openConversation(_page: Page, conversationUrl: string): Promise<'restored'> {
    this.restoredUrls.push(conversationUrl);
    return 'restored';
  }

  async startText(_page: Page, request: { prompt: string }): Promise<ChatGptTextTurn> {
    this.prompts.push(request.prompt);
    this.onStart?.();
    let index = 0;
    return {
      observe: async () => this.snapshots[Math.min(index++, this.snapshots.length - 1)]!,
      stop: async () => {
        this.stopCalls += 1;
        return 'stopped';
      },
      conversationUrl: async () => this.conversationUrlValue,
    };
  }

  async sendText(): Promise<ChatGptTextResult> {
    throw new Error('non-stream sendText should not be used');
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

function setCompleteSnapshots(driver: FakeStreamingDriver, finalText = 'Hello!'): void {
  driver.snapshots.splice(
    0,
    driver.snapshots.length,
    { exists: false, text: '', completionMarkerPresent: false },
    { exists: true, text: finalText.slice(0, 1), completionMarkerPresent: false },
    { exists: true, text: finalText.slice(0, 2), completionMarkerPresent: false },
    { exists: true, text: finalText.slice(0, 3), completionMarkerPresent: false },
    { exists: true, text: finalText, completionMarkerPresent: true },
    { exists: true, text: finalText, completionMarkerPresent: true },
    { exists: true, text: finalText, completionMarkerPresent: true },
    { exists: true, text: finalText, completionMarkerPresent: true },
  );
}

function createEngine(options: {
  db: PersistenceContext;
  driver: FakeStreamingDriver;
  registry: FakePageRegistry;
  queue: DirectQueue;
}) {
  return createConversationExecutionEngine({
    pageRegistry: options.registry,
    queue: options.queue,
    driver: options.driver,
    conversationStore: options.db.conversationStore,
    now: () => 1000,
    randomUuid: () => conversationId,
    streamClock: clock(),
    streamPollIntervalMs: 10,
    streamTimeoutMs: 200,
  });
}

async function discardEvents() {}

describe('Conversation true Streaming', () => {
  it('starts SSE before the checkpoint, streams stable deltas, then commits clean before completed', async () => {
    const db = persistence();
    const driver = new FakeStreamingDriver();
    const registry = new FakePageRegistry();
    const queue = new DirectQueue();
    setCompleteSnapshots(driver);
    const engine = createEngine({ db, driver, registry, queue });
    const events: Array<{ type: string; delta?: string }> = [];
    driver.onStart = () => {
      expect(db.conversationStore.loadByKey('stream-thread')?.conversation.sync.status).toBe(
        'in_flight',
      );
    };

    const result = await engine.stream(streamRequest(), {
      signal: new AbortController().signal,
      sink: async (event) => {
        if (event.type === 'started') {
          expect(db.conversationStore.loadByKey('stream-thread')).toBeUndefined();
        }
        if (event.type === 'completed') {
          expect(db.conversationStore.loadByKey('stream-thread')?.conversation.sync.status).toBe(
            'clean',
          );
        }
        events.push(
          event.type === 'text.delta'
            ? { type: event.type, delta: event.delta }
            : { type: event.type },
        );
      },
    });

    expect(result.text).toBe('Hello!');
    expect(events[0]).toEqual({ type: 'started' });
    expect(events.at(-1)).toEqual({ type: 'completed' });
    expect(
      events
        .filter((event) => event.type === 'text.delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe('Hello!');
    expect(queue.keys).toEqual(['stream-thread']);
    expect(registry.completed).toEqual([conversationId]);

    const saved = db.conversationStore.loadByKey('stream-thread')!;
    expect(saved.conversation.sync).toEqual({ status: 'clean', syncedMessageCount: 2 });
    expect(saved.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Hello!' }]);
  });

  it('streams a warm full-history APPEND without replaying the stored history in the prompt', async () => {
    const db = persistence();
    seedStoredConversation(db);
    const driver = new FakeStreamingDriver();
    setCompleteSnapshots(driver, 'new assistant');
    const registry = new FakePageRegistry();
    registry.affinity = true;
    const engine = createEngine({ db, driver, registry, queue: new DirectQueue() });

    await engine.stream(
      streamRequest('stream-thread', [
        { role: 'user', content: [{ type: 'text', text: 'old user' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'old assistant' }] },
        { role: 'user', content: [{ type: 'text', text: 'new user' }] },
      ]),
      { signal: new AbortController().signal, sink: discardEvents },
    );

    expect(driver.openFreshCalls).toBe(0);
    expect(driver.restoredUrls).toEqual(['https://chatgpt.com/c/stored-thread']);
    expect(driver.prompts).toHaveLength(1);
    expect(driver.prompts[0]).toContain('new user');
    expect(driver.prompts[0]).not.toContain('old user');
    expect(driver.prompts[0]).not.toContain('old assistant');
    expect(db.conversationStore.loadByKey('stream-thread')?.messages).toHaveLength(4);
  });

  it('RESTOREs a clean Conversation without affinity and streams the incremental user turn', async () => {
    const db = persistence();
    seedStoredConversation(db);
    const driver = new FakeStreamingDriver();
    setCompleteSnapshots(driver, 'restored assistant');
    const registry = new FakePageRegistry();
    registry.affinity = false;
    const engine = createEngine({ db, driver, registry, queue: new DirectQueue() });

    await engine.stream(
      streamRequest('stream-thread', [
        { role: 'user', content: [{ type: 'text', text: 'incremental user' }] },
      ]),
      {
        signal: new AbortController().signal,
        sink: discardEvents,
      },
    );

    expect(driver.openFreshCalls).toBe(0);
    expect(driver.restoredUrls).toEqual(['https://chatgpt.com/c/stored-thread']);
    expect(driver.prompts[0]).toContain('incremental user');
    expect(driver.prompts[0]).not.toContain('old user');
    expect(db.conversationStore.loadByKey('stream-thread')?.messages).toHaveLength(4);
  });

  it('REBUILDs divergent full history while preserving the local Conversation identity', async () => {
    const db = persistence();
    seedStoredConversation(db);
    const driver = new FakeStreamingDriver();
    driver.conversationUrlValue = 'https://chatgpt.com/c/rebuilt-thread';
    setCompleteSnapshots(driver, 'rebuilt assistant');
    const registry = new FakePageRegistry();
    registry.affinity = true;
    const engine = createEngine({ db, driver, registry, queue: new DirectQueue() });

    await engine.stream(
      streamRequest('stream-thread', [
        { role: 'user', content: [{ type: 'text', text: 'corrected user' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'corrected assistant' }] },
        { role: 'user', content: [{ type: 'text', text: 'new user' }] },
      ]),
      { signal: new AbortController().signal, sink: discardEvents },
    );

    expect(driver.openFreshCalls).toBe(1);
    expect(driver.restoredUrls).toEqual([]);
    expect(driver.prompts[0]).toContain('corrected user');
    expect(driver.prompts[0]).toContain('corrected assistant');
    const saved = db.conversationStore.loadByKey('stream-thread')!;
    expect(saved.conversation.id).toBe(conversationId);
    expect(saved.conversation.chatgptConversationUrl).toBe('https://chatgpt.com/c/rebuilt-thread');
    expect(saved.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'corrected user' },
      { type: 'text', text: 'corrected assistant' },
      { type: 'text', text: 'new user' },
      { type: 'text', text: 'rebuilt assistant' },
    ]);
  });

  it('best-effort stops generation and keeps the checkpoint in_flight when the client aborts', async () => {
    const db = persistence();
    const driver = new FakeStreamingDriver();
    const registry = new FakePageRegistry();
    const queue = new DirectQueue();
    driver.snapshots.push(
      { exists: true, text: 'A', completionMarkerPresent: false },
      { exists: true, text: 'AB', completionMarkerPresent: false },
      { exists: true, text: 'ABC', completionMarkerPresent: false },
      { exists: true, text: 'ABCD', completionMarkerPresent: false },
    );
    const engine = createEngine({ db, driver, registry, queue });
    const controller = new AbortController();

    await expect(
      engine.stream(streamRequest(), {
        signal: controller.signal,
        sink: async (event) => {
          if (event.type === 'text.delta') controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'stream_aborted' });

    expect(driver.stopCalls).toBe(1);
    expect(registry.completed).toEqual([]);
    expect(registry.failed).toEqual([conversationId]);
    const saved = db.conversationStore.loadByKey('stream-thread')!;
    expect(saved.conversation.sync.status).toBe('in_flight');
    expect(saved.messages).toEqual([]);
  });

  it('does not stop or undo a clean turn when the terminal protocol write closes after commit', async () => {
    const db = persistence();
    const driver = new FakeStreamingDriver();
    const registry = new FakePageRegistry();
    const queue = new DirectQueue();
    setCompleteSnapshots(driver);
    const engine = createEngine({ db, driver, registry, queue });

    await expect(
      engine.stream(streamRequest(), {
        signal: new AbortController().signal,
        sink: async (event) => {
          if (event.type === 'completed') throw new TextStreamAbortedError();
        },
      }),
    ).resolves.toMatchObject({ text: 'Hello!' });

    expect(driver.stopCalls).toBe(0);
    expect(registry.completed).toEqual([conversationId]);
    const saved = db.conversationStore.loadByKey('stream-thread')!;
    expect(saved.conversation.sync.status).toBe('clean');
    expect(saved.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Hello!' }]);
  });
});
