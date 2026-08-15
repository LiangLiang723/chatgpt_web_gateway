import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import type { NormalizedMessage, NormalizedRequest } from '../../src/api/normalized.js';
import type {
  ChatGptTextDriver,
  ChatGptTextRequest,
  ChatGptTextResult,
} from '../../src/chatgpt/driver.js';
import { createConversationEngine } from '../../src/conversations/conversation-engine.js';
import type { ConversationPageRegistry, ConversationPageSession } from '../../src/conversations/page-registry.js';
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
}): NormalizedRequest {
  return {
    requestId: `req-${options.messages.length}-${options.conversationKey ?? 'none'}`,
    ...(options.conversationKey === undefined ? {} : { conversationKey: options.conversationKey }),
    instructions: [{ role: 'system', content: options.system ?? 'system-v1' }],
    messages: options.messages,
    tools: [],
    toolChoice: { mode: 'auto' },
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
  onOpenFresh?: () => void;
  onSend?: (request: ChatGptTextRequest, index: number) => void;

  async openFresh(page: Page): Promise<void> {
    this.calls.push({ type: 'openFresh', page });
    this.onOpenFresh?.();
  }

  async openConversation(page: Page, url: string): Promise<'restored' | 'not_restorable'> {
    this.calls.push({ type: 'openConversation', page, url });
    return 'restored';
  }

  async sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
    const sendIndex = this.calls.filter((call) => call.type === 'sendText').length;
    this.calls.push({ type: 'sendText', page, request });
    this.onSend?.(request, sendIndex);
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
      secondMessages: [
        user('u1-unique-old-token'),
        assistant('a1-unique-old-token'),
        user('u2'),
      ],
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
