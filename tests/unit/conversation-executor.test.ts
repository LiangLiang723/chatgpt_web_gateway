import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import type { NormalizedMessage, NormalizedRequest } from '../../src/api/normalized.js';
import type { PageLease, PagePool } from '../../src/browser/types.js';
import type { ChatGptDriver, ChatGptTextRequest } from '../../src/chatgpt/driver.js';
import { ChatGptDriverError } from '../../src/chatgpt/errors.js';
import {
  createConversationExecutor,
  type ConversationExecutorPageManager,
} from '../../src/conversations/conversation-executor.js';
import { createConversationQueue } from '../../src/conversations/conversation-queue.js';
import { createPersistenceContext, type PersistenceContext } from '../../src/persistence/index.js';
import type { ConversationAggregate } from '../../src/persistence/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const pathsToCleanup: TempPersistencePaths[] = [];
const persistenceToClose: PersistenceContext[] = [];

afterEach(() => {
  while (persistenceToClose.length) persistenceToClose.pop()?.close();
  while (pathsToCleanup.length) pathsToCleanup.pop()?.cleanup();
});

function persistence(): PersistenceContext {
  const paths = createTempPersistencePaths();
  pathsToCleanup.push(paths);
  const context = createPersistenceContext({
    databasePath: paths.databasePath,
    migrationsDir: paths.migrationsDir,
  });
  persistenceToClose.push(context);
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

function request(
  messages: NormalizedMessage[],
  conversationKey: string | null = 'thread-a',
): NormalizedRequest {
  return {
    requestId: `req-${messages.length}`,
    ...(conversationKey === null ? {} : { conversationKey }),
    instructions: [{ role: 'system', content: 'Remember exact context.' }],
    messages,
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: false },
    diagnostics: { ignoredParameters: [] },
  };
}

interface DriverCall {
  page: Page;
  request: ChatGptTextRequest;
}

class FakeDriver implements ChatGptDriver {
  readonly calls: DriverCall[] = [];
  readonly actions: Array<
    { type: 'success'; text: string; conversationUrl: string } | { type: 'error'; error: Error }
  > = [];

  async sendText(page: Page, request: ChatGptTextRequest) {
    this.calls.push({ page, request });
    const action = this.actions.shift();
    if (!action) throw new Error('No fake Driver action configured');
    if (action.type === 'error') throw action.error;
    return { text: action.text, conversationUrl: action.conversationUrl };
  }
}

class FakeConversationPages implements ConversationExecutorPageManager {
  readonly page = {} as Page;
  warm = false;
  readonly releases: Array<{ discard?: boolean }> = [];

  async acquire() {
    const reused = this.warm;
    this.warm = true;
    let released = false;
    return {
      page: this.page,
      reused,
      release: async (options: { discard?: boolean } = {}) => {
        if (released) return;
        released = true;
        this.releases.push(options);
        if (options.discard) this.warm = false;
      },
    };
  }
}

class FakePagePool implements Pick<PagePool, 'acquire'> {
  readonly page = {} as Page;
  releaseCalls = 0;

  async acquire(): Promise<PageLease> {
    let state: 'active' | 'released' | 'closed' = 'active';
    return {
      page: this.page,
      release: async () => {
        if (state !== 'active') return;
        state = 'released';
        this.releaseCalls += 1;
      },
      close: async () => {
        if (state !== 'active') return;
        state = 'closed';
      },
    };
  }
}

function executor(options: {
  persistence: PersistenceContext;
  driver: FakeDriver;
  pages?: FakeConversationPages;
  pagePool?: FakePagePool;
  now?: number;
}) {
  const pages = options.pages ?? new FakeConversationPages();
  const pagePool = options.pagePool ?? new FakePagePool();
  return {
    execute: createConversationExecutor({
      pagePool,
      pageManager: pages,
      queue: createConversationQueue(),
      driver: options.driver,
      conversationStore: options.persistence.conversationStore,
      now: () => options.now ?? 5_000,
    }),
    pages,
    pagePool,
  };
}

function textMessages(aggregate: ConversationAggregate): Array<{ role: string; text: string }> {
  return aggregate.messages.map((message) => ({
    role: message.role,
    text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
  }));
}

describe('ConversationExecutor', () => {
  it('persists a first keyed FRESH turn then APPENDs only one new user turn on the warm page', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.actions.push(
      { type: 'success', text: 'reply one', conversationUrl: 'https://chatgpt.com/c/alpha' },
      { type: 'success', text: 'reply two', conversationUrl: 'https://chatgpt.com/c/alpha' },
    );
    const { execute, pages } = executor({ persistence: db, driver });

    await expect(execute(request([user('turn one')]))).resolves.toMatchObject({
      type: 'text',
      text: 'reply one',
      conversationUrl: 'https://chatgpt.com/c/alpha',
      completedAt: 5_000,
    });

    const first = db.conversationStore.loadByKey('thread-a');
    expect(first).toBeDefined();
    expect(first?.conversation.conversationKey).toBe('thread-a');
    expect(first?.conversation.chatgptConversationUrl).toBe('https://chatgpt.com/c/alpha');
    expect(textMessages(first!)).toEqual([
      { role: 'user', text: 'turn one' },
      { role: 'assistant', text: 'reply one' },
    ]);
    expect(driver.calls[0]!.request.target).toEqual({ kind: 'fresh' });
    expect(driver.calls[0]!.request.prompt).toContain('turn one');

    await execute(request([user('turn one'), assistant('reply one'), user('turn two')]));

    const second = db.conversationStore.loadByKey('thread-a');
    expect(second?.conversation.id).toBe(first?.conversation.id);
    expect(textMessages(second!)).toEqual([
      { role: 'user', text: 'turn one' },
      { role: 'assistant', text: 'reply one' },
      { role: 'user', text: 'turn two' },
      { role: 'assistant', text: 'reply two' },
    ]);
    expect(driver.calls[1]!.request.target).toEqual({
      kind: 'current',
      conversationUrl: 'https://chatgpt.com/c/alpha',
    });
    expect(driver.calls[1]!.request.prompt).toContain('turn two');
    expect(driver.calls[1]!.request.prompt).not.toContain('turn one');
    expect(pages.releases).toEqual([{}, {}]);
  });

  it('uses RESTORE after the warm page is lost while keeping the persisted URL', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.actions.push(
      { type: 'success', text: 'reply one', conversationUrl: 'https://chatgpt.com/c/alpha' },
      { type: 'success', text: 'reply two', conversationUrl: 'https://chatgpt.com/c/alpha' },
    );
    const { execute, pages } = executor({ persistence: db, driver });

    await execute(request([user('turn one')]));
    pages.warm = false;
    await execute(request([user('turn one'), assistant('reply one'), user('turn two')]));

    expect(driver.calls[1]!.request.target).toEqual({
      kind: 'restore',
      conversationUrl: 'https://chatgpt.com/c/alpha',
    });
    expect(driver.calls[1]!.request.prompt).not.toContain('turn one');
  });

  it('REBUILDs when the synchronized history changed while preserving the local id/key', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.actions.push(
      { type: 'success', text: 'reply one', conversationUrl: 'https://chatgpt.com/c/alpha' },
      { type: 'success', text: 'rebuilt reply', conversationUrl: 'https://chatgpt.com/c/beta' },
    );
    const { execute } = executor({ persistence: db, driver });

    await execute(request([user('turn one')]));
    const before = db.conversationStore.loadByKey('thread-a')!;

    await execute(request([user('edited turn one'), assistant('reply one'), user('turn two')]));

    const after = db.conversationStore.loadByKey('thread-a')!;
    expect(after.conversation.id).toBe(before.conversation.id);
    expect(after.conversation.conversationKey).toBe('thread-a');
    expect(after.conversation.chatgptConversationUrl).toBe('https://chatgpt.com/c/beta');
    expect(driver.calls[1]!.request.target).toEqual({ kind: 'fresh' });
    expect(driver.calls[1]!.request.prompt).toContain('edited turn one');
  });

  it('REBUILDs a keyed snapshot whose persisted URL is missing even if a warm page exists', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.actions.push(
      { type: 'success', text: 'reply one', conversationUrl: 'https://chatgpt.com/c/alpha' },
      { type: 'success', text: 'rebuilt reply', conversationUrl: 'https://chatgpt.com/c/beta' },
    );
    const { execute } = executor({ persistence: db, driver });

    await execute(request([user('turn one')]));
    const saved = db.conversationStore.loadByKey('thread-a')!;
    db.conversationStore.save({
      ...saved,
      conversation: { ...saved.conversation, chatgptConversationUrl: undefined },
    });

    await execute(request([user('turn one'), assistant('reply one'), user('turn two')]));

    expect(driver.calls[1]!.request.target).toEqual({ kind: 'fresh' });
    expect(driver.calls[1]!.request.prompt).toContain('turn one');
  });

  it('falls back from RESTORE identity failure to exactly one Fresh REBUILD on the same Page', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.actions.push(
      { type: 'success', text: 'reply one', conversationUrl: 'https://chatgpt.com/c/alpha' },
      {
        type: 'error',
        error: new ChatGptDriverError({
          code: 'conversation_restore_failed',
          message: 'gone',
        }),
      },
      { type: 'success', text: 'rebuilt', conversationUrl: 'https://chatgpt.com/c/beta' },
    );
    const { execute, pages } = executor({ persistence: db, driver });

    await execute(request([user('turn one')]));
    pages.warm = false;
    await execute(request([user('turn one'), assistant('reply one'), user('turn two')]));

    expect(driver.calls.slice(1).map((call) => call.request.target)).toEqual([
      { kind: 'restore', conversationUrl: 'https://chatgpt.com/c/alpha' },
      { kind: 'fresh' },
    ]);
    expect(driver.calls[1]!.page).toBe(driver.calls[2]!.page);
    expect(driver.calls[2]!.request.prompt).toContain('turn one');
    expect(db.conversationStore.loadByKey('thread-a')?.conversation.chatgptConversationUrl).toBe(
      'https://chatgpt.com/c/beta',
    );
  });

  it('tries saved-URL RESTORE after a warm current identity failure before rebuilding', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.actions.push(
      { type: 'success', text: 'reply one', conversationUrl: 'https://chatgpt.com/c/alpha' },
      {
        type: 'error',
        error: new ChatGptDriverError({
          code: 'conversation_restore_failed',
          message: 'warm page moved',
        }),
      },
      { type: 'success', text: 'reply two', conversationUrl: 'https://chatgpt.com/c/alpha' },
    );
    const { execute } = executor({ persistence: db, driver });

    await execute(request([user('turn one')]));
    await execute(request([user('turn one'), assistant('reply one'), user('turn two')]));

    expect(driver.calls.slice(1).map((call) => call.request.target)).toEqual([
      { kind: 'current', conversationUrl: 'https://chatgpt.com/c/alpha' },
      { kind: 'restore', conversationUrl: 'https://chatgpt.com/c/alpha' },
    ]);
    expect(driver.calls[2]!.request.prompt).not.toContain('turn one');
  });

  it('preserves the previous snapshot and discards the affinity on non-restore execution failure', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.actions.push(
      { type: 'success', text: 'reply one', conversationUrl: 'https://chatgpt.com/c/alpha' },
      {
        type: 'error',
        error: new ChatGptDriverError({ code: 'auth_required', message: 'login' }),
      },
    );
    const { execute, pages } = executor({ persistence: db, driver });

    await execute(request([user('turn one')]));
    const before = db.conversationStore.loadByKey('thread-a')!;

    await expect(
      execute(request([user('turn one'), assistant('reply one'), user('turn two')])),
    ).rejects.toMatchObject({ code: 'auth_required' });

    expect(db.conversationStore.loadByKey('thread-a')).toEqual(before);
    expect(driver.calls).toHaveLength(2);
    expect(pages.releases.at(-1)).toEqual({ discard: true });
  });

  it('executes unkeyed history as ephemeral FRESH without creating a durable Conversation', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.actions.push({
      type: 'success',
      text: 'ephemeral reply',
      conversationUrl: 'https://chatgpt.com/c/ephemeral',
    });
    const pagePool = new FakePagePool();
    const { execute } = executor({ persistence: db, driver, pagePool });

    await execute(request([user('one'), assistant('reply one'), user('two')], null));

    expect(driver.calls[0]!.request.target).toEqual({ kind: 'fresh' });
    expect(driver.calls[0]!.request.prompt).toContain('one');
    expect(driver.calls[0]!.request.prompt).toContain('reply one');
    expect(pagePool.releaseCalls).toBe(1);
    expect(db.conversations.getByKey('thread-a')).toBeUndefined();
  });
});
