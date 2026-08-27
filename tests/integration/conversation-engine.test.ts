import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedTool,
  NormalizedToolChoice,
} from '../../src/api/normalized.js';
import type {
  ChatGptTextDriver,
  ChatGptTextRequest,
  ChatGptTextResult,
} from '../../src/chatgpt/driver.js';
import { createConversationEngine } from '../../src/conversations/conversation-engine.js';
import type {
  ConversationPageRegistry,
  ConversationPageSession,
} from '../../src/conversations/page-registry.js';
import type { ConversationQueue } from '../../src/conversations/conversation-queue.js';
import { createPersistenceContext, type PersistenceContext } from '../../src/persistence/index.js';
import type { ConversationAggregate } from '../../src/persistence/types.js';
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

const user = (text: string): NormalizedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});
const assistant = (text: string): NormalizedMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

function request(options: {
  messages: NormalizedMessage[];
  conversationKey?: string;
  system?: string;
  tools?: NormalizedTool[];
  toolChoice?: NormalizedToolChoice;
}): NormalizedRequest {
  return {
    requestId: `req-${options.messages.length}-${options.conversationKey ?? 'none'}`,
    ...(options.conversationKey === undefined ? {} : { conversationKey: options.conversationKey }),
    instructions: [{ role: 'system', content: options.system ?? 'system-v1' }],
    messages: options.messages,
    tools: options.tools ?? [],
    toolChoice: options.toolChoice ?? { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: false },
    diagnostics: { ignoredParameters: [] },
  };
}

class FakePage {
  constructor(readonly id: string) {}
  isClosed(): boolean {
    return false;
  }
}

class FakePageRegistry implements ConversationPageRegistry {
  private readonly retained = new Map<string, FakePage>();
  private nextPage = 1;
  readonly completed: Array<string | undefined> = [];
  readonly failed: Array<string | undefined> = [];

  hasAffinity(conversationId: string): boolean {
    return this.retained.has(conversationId);
  }

  async acquire(conversationId?: string): Promise<ConversationPageSession> {
    const page =
      (conversationId === undefined ? undefined : this.retained.get(conversationId)) ??
      new FakePage(`page-${this.nextPage++}`);
    let done = false;
    return {
      page: page as unknown as Page,
      complete: async () => {
        if (done) return;
        done = true;
        this.completed.push(conversationId);
        if (conversationId !== undefined) this.retained.set(conversationId, page);
      },
      fail: async () => {
        if (done) return;
        done = true;
        this.failed.push(conversationId);
        if (conversationId !== undefined) this.retained.delete(conversationId);
      },
    };
  }

  async close(): Promise<void> {
    this.retained.clear();
  }
}

class RecordingQueue implements ConversationQueue {
  readonly keys: string[] = [];
  closed = false;
  get pendingKeyCount(): number {
    return 0;
  }
  async run<T>(conversationKey: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('closed');
    this.keys.push(conversationKey);
    return work();
  }
  close(): void {
    this.closed = true;
  }
}

type DriverCall =
  | { type: 'openFresh'; page: Page }
  | { type: 'openConversation'; page: Page; url: string }
  | { type: 'sendText'; page: Page; request: ChatGptTextRequest };

class FakeDriver implements ChatGptTextDriver {
  readonly calls: DriverCall[] = [];
  readonly results: ChatGptTextResult[] = [];
  readonly openConversationResults: Array<'restored' | 'not_restorable' | Error> = [];
  nextSendError?: Error;
  onOpenFresh?: () => void;
  onSend?: (request: ChatGptTextRequest, index: number) => void;

  async openFresh(page: Page): Promise<void> {
    this.calls.push({ type: 'openFresh', page });
    this.onOpenFresh?.();
  }

  async openConversation(page: Page, url: string): Promise<'restored' | 'not_restorable'> {
    this.calls.push({ type: 'openConversation', page, url });
    const result = this.openConversationResults.shift();
    if (result instanceof Error) throw result;
    return result ?? 'restored';
  }

  async sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
    const sendIndex = this.calls.filter((call) => call.type === 'sendText').length;
    this.calls.push({ type: 'sendText', page, request });
    this.onSend?.(request, sendIndex);
    if (this.nextSendError) {
      const error = this.nextSendError;
      this.nextSendError = undefined;
      throw error;
    }
    const result = this.results.shift();
    if (!result) throw new Error('No fake Driver result configured');
    return result;
  }
}

function textMessages(aggregate: ConversationAggregate): Array<{ role: string; text: string }> {
  return aggregate.messages.map((record) => ({
    role: record.role,
    text: record.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
  }));
}

function sendCalls(driver: FakeDriver): Array<Extract<DriverCall, { type: 'sendText' }>> {
  return driver.calls.filter(
    (call): call is Extract<DriverCall, { type: 'sendText' }> => call.type === 'sendText',
  );
}

describe('Conversation Engine FRESH + APPEND', () => {
  it('persists keyed FRESH with an in-flight checkpoint before send and a clean final aggregate', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    const registry = new FakePageRegistry();
    const queue = new RecordingQueue();
    driver.results.push({ text: 'a1', conversationUrl: 'https://chatgpt.com/c/one' });
    driver.onOpenFresh = () => {
      expect(db.conversationStore.loadByKey('thread-1')).toBeUndefined();
    };
    driver.onSend = () => {
      const inFlight = db.conversationStore.loadByKey('thread-1')!;
      expect(inFlight.conversation.sync).toEqual({
        status: 'in_flight',
        syncedMessageCount: 0,
        startedAt: 1000,
      });
      expect(inFlight.conversation.chatgptConversationUrl).toBeUndefined();
      expect(inFlight.messages).toEqual([]);
    };

    const execute = createConversationEngine({
      pageRegistry: registry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 1000,
      randomUuid: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    await expect(
      execute(request({ messages: [user('u1')], conversationKey: 'thread-1' })),
    ).resolves.toEqual({
      type: 'text',
      text: 'a1',
      conversationUrl: 'https://chatgpt.com/c/one',
      completedAt: 1000,
    });

    expect(queue.keys).toEqual(['thread-1']);
    expect(driver.calls.map((call) => call.type)).toEqual(['openFresh', 'sendText']);
    const saved = db.conversationStore.loadByKey('thread-1')!;
    expect(saved.conversation.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(saved.conversation.sync).toEqual({ status: 'clean', syncedMessageCount: 2 });
    expect(textMessages(saved)).toEqual([
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: 'a1' },
    ]);
    expect(registry.completed).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  });

  it.each([
    {
      name: 'full history',
      secondMessages: [user('u1-unique-old-token'), assistant('a1-unique-old-token'), user('u2')],
    },
    {
      name: 'single-user incremental',
      secondMessages: [user('u2')],
    },
  ])('APPENDs only current user for $name clients', async ({ secondMessages }) => {
    const db = persistence();
    const driver = new FakeDriver();
    const registry = new FakePageRegistry();
    const queue = new RecordingQueue();
    driver.results.push(
      { text: 'a1-unique-old-token', conversationUrl: 'https://chatgpt.com/c/one' },
      { text: 'a2', conversationUrl: 'https://chatgpt.com/c/one' },
    );

    const execute = createConversationEngine({
      pageRegistry: registry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 1000,
      randomUuid: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    await execute(
      request({
        messages: [user('u1-unique-old-token')],
        conversationKey: 'thread-1',
      }),
    );
    driver.onSend = (_request, index) => {
      if (index !== 1) return;
      const inFlight = db.conversationStore.loadByKey('thread-1')!;
      expect(inFlight.conversation.sync).toEqual({
        status: 'in_flight',
        syncedMessageCount: 2,
        startedAt: 1000,
      });
      expect(textMessages(inFlight)).toEqual([
        { role: 'user', text: 'u1-unique-old-token' },
        { role: 'assistant', text: 'a1-unique-old-token' },
      ]);
    };

    await execute(request({ messages: secondMessages, conversationKey: 'thread-1' }));

    const sends = sendCalls(driver);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.request.prompt).toContain('u2');
    expect(sends[1]!.request.prompt).not.toContain('u1-unique-old-token');
    expect(sends[1]!.request.prompt).not.toContain('a1-unique-old-token');
    expect(driver.calls.filter((call) => call.type === 'openConversation')).toHaveLength(1);

    const saved = db.conversationStore.loadByKey('thread-1')!;
    expect(textMessages(saved)).toEqual([
      { role: 'user', text: 'u1-unique-old-token' },
      { role: 'assistant', text: 'a1-unique-old-token' },
      { role: 'user', text: 'u2' },
      { role: 'assistant', text: 'a2' },
    ]);
    expect(saved.conversation.sync).toEqual({ status: 'clean', syncedMessageCount: 4 });
  });

  it('persists an unkeyed full-history FRESH Conversation without queue or retained affinity', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    const registry = new FakePageRegistry();
    const queue = new RecordingQueue();
    driver.results.push({ text: 'a2', conversationUrl: 'https://chatgpt.com/c/unkeyed' });

    const execute = createConversationEngine({
      pageRegistry: registry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 2000,
      randomUuid: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });

    await execute(
      request({
        messages: [user('u1'), assistant('a1'), user('u2')],
      }),
    );

    expect(queue.keys).toEqual([]);
    expect(registry.completed).toEqual([undefined]);
    const row = db.database
      .prepare('SELECT id FROM conversations WHERE conversation_key IS NULL')
      .get() as { id: string } | undefined;
    expect(row?.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const saved = db.conversationStore.loadById(row!.id)!;
    expect(saved.conversation.conversationKey).toBeUndefined();
    expect(saved.conversation.sync).toEqual({ status: 'clean', syncedMessageCount: 4 });
    expect(textMessages(saved)).toEqual([
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'u2' },
      { role: 'assistant', text: 'a2' },
    ]);
  });
});

describe('Conversation Engine RESTORE + REBUILD + crash convergence', () => {
  it('RESTOREs a clean persisted Conversation when a fresh Registry has no affinity', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    const queue = new RecordingQueue();
    const firstRegistry = new FakePageRegistry();
    driver.results.push(
      { text: 'a1', conversationUrl: 'https://chatgpt.com/c/restore-one' },
      { text: 'a2', conversationUrl: 'https://chatgpt.com/c/restore-one' },
    );
    const first = createConversationEngine({
      pageRegistry: firstRegistry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 3000,
      randomUuid: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    await first(request({ messages: [user('u1')], conversationKey: 'restore-thread' }));

    const secondRegistry = new FakePageRegistry();
    const second = createConversationEngine({
      pageRegistry: secondRegistry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 3100,
      randomUuid: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    const before = driver.calls.length;
    await second(request({ messages: [user('u2')], conversationKey: 'restore-thread' }));
    const secondCalls = driver.calls.slice(before);

    expect(secondCalls.map((call) => call.type)).toEqual(['openConversation', 'sendText']);
    expect(secondCalls[0]).toMatchObject({
      type: 'openConversation',
      url: 'https://chatgpt.com/c/restore-one',
    });
    const send = secondCalls[1] as Extract<DriverCall, { type: 'sendText' }>;
    expect(send.request.prompt).toContain('u2');
    expect(send.request.prompt).not.toContain('u1');
    expect(
      db.conversationStore.loadByKey('restore-thread')?.conversation.chatgptConversationUrl,
    ).toBe('https://chatgpt.com/c/restore-one');
  });

  it('falls back from not_restorable RESTORE to one Fresh REBUILD with confirmed history', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    const queue = new RecordingQueue();
    const firstRegistry = new FakePageRegistry();
    driver.results.push(
      { text: 'a1-restore-token', conversationUrl: 'https://chatgpt.com/c/old-url' },
      { text: 'a2', conversationUrl: 'https://chatgpt.com/c/new-url' },
    );
    const first = createConversationEngine({
      pageRegistry: firstRegistry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 4000,
      randomUuid: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });
    await first(
      request({ messages: [user('u1-restore-token')], conversationKey: 'rebuild-thread' }),
    );
    const originalId = db.conversationStore.loadByKey('rebuild-thread')!.conversation.id;

    const secondRegistry = new FakePageRegistry();
    driver.openConversationResults.push('not_restorable');
    const second = createConversationEngine({
      pageRegistry: secondRegistry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 4100,
      randomUuid: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });
    const before = driver.calls.length;
    await second(request({ messages: [user('u2-current')], conversationKey: 'rebuild-thread' }));
    const calls = driver.calls.slice(before);

    expect(calls.map((call) => call.type)).toEqual(['openConversation', 'openFresh', 'sendText']);
    const send = calls[2] as Extract<DriverCall, { type: 'sendText' }>;
    expect(send.request.prompt).toContain('u1-restore-token');
    expect(send.request.prompt).toContain('a1-restore-token');
    expect(send.request.prompt).toContain('u2-current');
    const saved = db.conversationStore.loadByKey('rebuild-thread')!;
    expect(saved.conversation.id).toBe(originalId);
    expect(saved.conversation.chatgptConversationUrl).toBe('https://chatgpt.com/c/new-url');
  });

  it('REBUILDs full history divergence using client history as authoritative', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    const registry = new FakePageRegistry();
    const queue = new RecordingQueue();
    driver.results.push(
      { text: 'a1-original', conversationUrl: 'https://chatgpt.com/c/diverge-old' },
      { text: 'a2', conversationUrl: 'https://chatgpt.com/c/diverge-new' },
    );
    const execute = createConversationEngine({
      pageRegistry: registry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 5000,
      randomUuid: () => '12121212-1212-4212-8212-121212121212',
    });
    await execute(request({ messages: [user('u1-original')], conversationKey: 'diverge' }));
    const before = driver.calls.length;
    await execute(
      request({
        messages: [user('u1-edited'), assistant('a1-original'), user('u2')],
        conversationKey: 'diverge',
      }),
    );
    const calls = driver.calls.slice(before);

    expect(calls.map((call) => call.type)).toEqual(['openFresh', 'sendText']);
    const send = calls[1] as Extract<DriverCall, { type: 'sendText' }>;
    expect(send.request.prompt).toContain('u1-edited');
    expect(send.request.prompt).not.toContain('u1-original');
    expect(db.conversationStore.loadByKey('diverge')?.conversation.chatgptConversationUrl).toBe(
      'https://chatgpt.com/c/diverge-new',
    );
  });

  it('REBUILDs incremental instructions change with confirmed stored history and new instructions', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    const registry = new FakePageRegistry();
    const queue = new RecordingQueue();
    driver.results.push(
      { text: 'a1-instruction-token', conversationUrl: 'https://chatgpt.com/c/instruction-old' },
      { text: 'a2', conversationUrl: 'https://chatgpt.com/c/instruction-new' },
    );
    const execute = createConversationEngine({
      pageRegistry: registry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 6000,
      randomUuid: () => '34343434-3434-4434-8434-343434343434',
    });
    await execute(
      request({
        messages: [user('u1-instruction-token')],
        conversationKey: 'instructions',
        system: 'system-v1',
      }),
    );
    const before = driver.calls.length;
    await execute(
      request({
        messages: [user('u2-current')],
        conversationKey: 'instructions',
        system: 'system-v2',
      }),
    );
    const calls = driver.calls.slice(before);

    expect(calls.map((call) => call.type)).toEqual(['openFresh', 'sendText']);
    const send = calls[1] as Extract<DriverCall, { type: 'sendText' }>;
    expect(send.request.prompt).toContain('system-v2');
    expect(send.request.prompt).toContain('u1-instruction-token');
    expect(send.request.prompt).toContain('a1-instruction-token');
    expect(send.request.prompt).toContain('u2-current');
  });

  it.each([
    { status: 'in_flight' as const, count: 2, startedAt: 123, reason: 'uncertain' },
    { status: 'clean' as const, count: 1, startedAt: undefined, reason: 'mismatch' },
  ])('REBUILDs checkpoint $reason using only confirmed stored prefix', async (checkpoint) => {
    const db = persistence();
    const driver = new FakeDriver();
    const registry = new FakePageRegistry();
    const queue = new RecordingQueue();
    driver.results.push(
      { text: 'a1-checkpoint-token', conversationUrl: 'https://chatgpt.com/c/checkpoint-old' },
      { text: 'a2', conversationUrl: 'https://chatgpt.com/c/checkpoint-new' },
    );
    const execute = createConversationEngine({
      pageRegistry: registry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 7000,
      randomUuid: () => '56565656-5656-4656-8656-565656565656',
    });
    await execute(
      request({ messages: [user('u1-checkpoint-token')], conversationKey: 'checkpoint' }),
    );
    const saved = db.conversationStore.loadByKey('checkpoint')!;
    db.conversationStore.save({
      ...saved,
      conversation: {
        ...saved.conversation,
        sync:
          checkpoint.status === 'in_flight'
            ? {
                status: 'in_flight',
                syncedMessageCount: checkpoint.count,
                startedAt: checkpoint.startedAt!,
              }
            : { status: 'clean', syncedMessageCount: checkpoint.count },
      },
    });

    const before = driver.calls.length;
    await execute(request({ messages: [user('u2-current')], conversationKey: 'checkpoint' }));
    const calls = driver.calls.slice(before);
    expect(calls.map((call) => call.type)).toEqual(['openFresh', 'sendText']);
    const send = calls[1] as Extract<DriverCall, { type: 'sendText' }>;
    expect(send.request.prompt).toContain('u1-checkpoint-token');
    if (checkpoint.count === 2) expect(send.request.prompt).toContain('a1-checkpoint-token');
    else expect(send.request.prompt).not.toContain('a1-checkpoint-token');
    expect(send.request.prompt).toContain('u2-current');
  });

  it('keeps the persisted checkpoint in_flight after a post-checkpoint send failure and reopen', async () => {
    const paths = createTempPersistencePaths();
    resources.push(paths);
    const firstDb = createPersistenceContext({
      databasePath: paths.databasePath,
      migrationsDir: paths.migrationsDir,
    });
    contexts.push(firstDb);
    const driver = new FakeDriver();
    const registry = new FakePageRegistry();
    const queue = new RecordingQueue();
    driver.results.push({ text: 'a1', conversationUrl: 'https://chatgpt.com/c/crash' });
    const execute = createConversationEngine({
      pageRegistry: registry,
      queue,
      driver,
      conversationStore: firstDb.conversationStore,
      now: () => 8000,
      randomUuid: () => '78787878-7878-4787-8787-787878787878',
    });
    await execute(request({ messages: [user('u1')], conversationKey: 'crash' }));

    driver.nextSendError = new Error('simulated post-checkpoint failure');
    await expect(
      execute(request({ messages: [user('u2')], conversationKey: 'crash' })),
    ).rejects.toThrow('simulated post-checkpoint failure');
    const failed = firstDb.conversationStore.loadByKey('crash')!;
    expect(failed.conversation.sync).toEqual({
      status: 'in_flight',
      syncedMessageCount: 2,
      startedAt: 8000,
    });
    expect(textMessages(failed)).toEqual([
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: 'a1' },
    ]);
    firstDb.close();
    contexts.splice(contexts.indexOf(firstDb), 1);

    const reopened = createPersistenceContext({
      databasePath: paths.databasePath,
      migrationsDir: paths.migrationsDir,
    });
    contexts.push(reopened);
    expect(reopened.conversationStore.loadByKey('crash')?.conversation.sync).toEqual({
      status: 'in_flight',
      syncedMessageCount: 2,
      startedAt: 8000,
    });
  });
});
