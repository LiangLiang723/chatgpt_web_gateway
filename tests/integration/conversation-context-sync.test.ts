import { join } from 'node:path';

import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserRuntimeError } from '../../src/browser/errors.js';
import type { BrowserManager, PageLease, PagePool } from '../../src/browser/types.js';
import type {
  ChatGptDriver,
  ChatGptTextRequest,
  ChatGptTextResult,
} from '../../src/chatgpt/driver.js';
import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../src/runtime.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const resources: TempPersistencePaths[] = [];
const runtimes: GatewayRuntime[] = [];

const auth = { authorization: 'Bearer test-key' };

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()?.close();
  while (resources.length) resources.pop()?.cleanup();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakePage {
  closed = false;

  isClosed(): boolean {
    return this.closed;
  }
}

function fakeBrowserManager(capacity = 4): BrowserManager {
  const tracked = new Set<FakePage>();
  let leasedCount = 0;
  let closed = false;

  const pages: PagePool = {
    get openCount() {
      return tracked.size;
    },
    get leasedCount() {
      return leasedCount;
    },
    get idleCount() {
      return 0;
    },
    async acquire(): Promise<PageLease> {
      if (closed) throw new BrowserRuntimeError('browser_unavailable', 'closed');
      if (tracked.size >= capacity) {
        throw new BrowserRuntimeError('page_capacity_exceeded', 'capacity');
      }
      const page = new FakePage();
      tracked.add(page);
      leasedCount += 1;
      let state: 'active' | 'released' | 'closed' = 'active';
      return {
        page: page as unknown as Page,
        async release() {
          if (state !== 'active') return;
          state = 'released';
          leasedCount -= 1;
        },
        async close() {
          if (state !== 'active') return;
          state = 'closed';
          leasedCount -= 1;
          page.closed = true;
          tracked.delete(page);
        },
      };
    },
    async close() {
      closed = true;
      for (const page of tracked) page.closed = true;
      tracked.clear();
      leasedCount = 0;
    },
  };

  return {
    context: {} as BrowserContext,
    pages,
    async close() {
      await pages.close();
    },
  };
}

interface DriverCall {
  page: Page;
  request: ChatGptTextRequest;
}

type NavigationCall =
  { type: 'fresh'; page: Page } | { type: 'conversation'; page: Page; conversationUrl: string };

class ControlledDriver implements ChatGptDriver {
  readonly calls: DriverCall[] = [];
  readonly navigationCalls: NavigationCall[] = [];

  async openFresh(page: Page): Promise<void> {
    this.navigationCalls.push({ type: 'fresh', page });
  }

  async openConversation(
    page: Page,
    conversationUrl: string,
  ): Promise<'restored' | 'not_restorable'> {
    this.navigationCalls.push({ type: 'conversation', page, conversationUrl });
    return 'restored';
  }

  constructor(
    private readonly handler: (
      call: DriverCall,
      index: number,
    ) => Promise<ChatGptTextResult> | ChatGptTextResult,
  ) {}

  async sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
    const call = { page, request };
    this.calls.push(call);
    return this.handler(call, this.calls.length - 1);
  }
}

function temp(): TempPersistencePaths {
  const paths = createTempPersistencePaths();
  resources.push(paths);
  return paths;
}

async function runtime(
  paths: TempPersistencePaths,
  driver: ChatGptDriver,
): Promise<GatewayRuntime> {
  const instance = await createGatewayRuntime({
    config: loadConfig({
      GATEWAY_API_KEY: 'test-key',
      DATA_DIR: join(paths.root, 'data'),
      MAX_ACTIVE_PAGES: '4',
      PAGE_IDLE_TIMEOUT_MINUTES: '30',
    }),
    migrationsDir: paths.migrationsDir,
    createBrowserManager: async () => fakeBrowserManager(),
    driver,
    logger: false,
  });
  runtimes.push(instance);
  return instance;
}

function chatPayload(messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  return { model: 'chatgpt-web', stream: false, messages };
}

describe('Phase 4 Conversation + Context Sync HTTP integration', () => {
  it('APPENDs only the second Chat Completions user turn on a keyed warm Conversation', async () => {
    const paths = temp();
    const driver = new ControlledDriver((_call, index) => ({
      text: index === 0 ? 'reply one' : 'reply two',
      conversationUrl: 'https://chatgpt.com/c/chat-alpha',
    }));
    const gateway = await runtime(paths, driver);
    const headers = { ...auth, 'x-conversation-key': 'chat-thread' };

    const first = await gateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload([{ role: 'user', content: 'chat turn one' }]),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().choices[0].message.content).toBe('reply one');

    const second = await gateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload([
        { role: 'user', content: 'chat turn one' },
        { role: 'assistant', content: 'reply one' },
        { role: 'user', content: 'chat turn two' },
      ]),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().choices[0].message.content).toBe('reply two');

    expect(driver.navigationCalls).toEqual([
      { type: 'fresh', page: driver.calls[0]!.page },
      {
        type: 'conversation',
        page: driver.calls[1]!.page,
        conversationUrl: 'https://chatgpt.com/c/chat-alpha',
      },
    ]);
    expect(driver.calls[1]!.request.prompt).toContain('chat turn two');
    expect(driver.calls[1]!.request.prompt).not.toContain('chat turn one');
  });

  it('uses the shared APPEND behavior for Responses', async () => {
    const paths = temp();
    const driver = new ControlledDriver((_call, index) => ({
      text: index === 0 ? 'response one' : 'response two',
      conversationUrl: 'https://chatgpt.com/c/response-alpha',
    }));
    const gateway = await runtime(paths, driver);
    const headers = { ...auth, 'x-conversation-key': 'response-thread' };

    const first = await gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: { model: 'chatgpt-web', input: 'response turn one' },
    });
    expect(first.statusCode).toBe(200);

    const second = await gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'chatgpt-web',
        input: [
          { role: 'user', content: 'response turn one' },
          { role: 'assistant', content: 'response one' },
          { role: 'user', content: 'response turn two' },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().output[0].content[0].text).toBe('response two');
    expect(driver.navigationCalls[1]).toEqual({
      type: 'conversation',
      page: driver.calls[1]!.page,
      conversationUrl: 'https://chatgpt.com/c/response-alpha',
    });
    expect(driver.calls[1]!.request.prompt).not.toContain('response turn one');
  });

  it('serializes same-key HTTP requests while allowing different keys to overlap', async () => {
    const paths = temp();
    const firstGate = deferred();
    const sameFirstStarted = deferred();
    const sameSecondStarted = deferred();
    let sameCalls = 0;
    const gatewayRef: { current?: GatewayRuntime } = {};
    const sameDriver = new ControlledDriver(async (call) => {
      sameCalls += 1;
      if (sameCalls === 1) {
        sameFirstStarted.resolve();
        await firstGate.promise;
      }
      if (sameCalls === 2) {
        const stored = gatewayRef.current!.persistence.conversationStore.loadByKey('same-key');
        expect(stored?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
        expect(call.request.prompt).toContain('same two');
        expect(call.request.prompt).not.toContain('same one');
        expect(call.request.prompt).not.toContain('same reply one');
        sameSecondStarted.resolve();
      }
      return {
        text: sameCalls === 1 ? 'same reply one' : 'same reply two',
        conversationUrl: 'https://chatgpt.com/c/same',
      };
    });
    const gateway = await runtime(paths, sameDriver);
    gatewayRef.current = gateway;
    const sameHeaders = { ...auth, 'x-conversation-key': 'same-key' };

    const first = gateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: sameHeaders,
      payload: chatPayload([{ role: 'user', content: 'same one' }]),
    });
    const second = gateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: sameHeaders,
      payload: chatPayload([{ role: 'user', content: 'same two' }]),
    });

    await sameFirstStarted.promise;
    expect(sameDriver.calls).toHaveLength(1);
    firstGate.resolve();
    await sameSecondStarted.promise;
    await Promise.all([first, second]);
    expect(sameDriver.calls).toHaveLength(2);

    await gateway.close();
    runtimes.splice(runtimes.indexOf(gateway), 1);

    const alphaGate = deferred();
    const betaGate = deferred();
    const bothStarted = deferred();
    const started = new Set<string>();
    const parallelDriver = new ControlledDriver(async (call) => {
      const alpha = call.request.prompt.includes('parallel alpha');
      started.add(alpha ? 'alpha' : 'beta');
      if (started.size === 2) bothStarted.resolve();
      await (alpha ? alphaGate.promise : betaGate.promise);
      return {
        text: alpha ? 'alpha reply' : 'beta reply',
        conversationUrl: alpha ? 'https://chatgpt.com/c/alpha' : 'https://chatgpt.com/c/beta',
      };
    });
    const parallelGateway = await runtime(paths, parallelDriver);

    const alpha = parallelGateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...auth, 'x-conversation-key': 'parallel-alpha' },
      payload: chatPayload([{ role: 'user', content: 'parallel alpha' }]),
    });
    const beta = parallelGateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...auth, 'x-conversation-key': 'parallel-beta' },
      payload: chatPayload([{ role: 'user', content: 'parallel beta' }]),
    });

    await bothStarted.promise;
    expect(started).toEqual(new Set(['alpha', 'beta']));
    alphaGate.resolve();
    betaGate.resolve();
    await Promise.all([alpha, beta]);
  });

  it('RESTOREs the saved URL after runtime restart with the same SQLite state', async () => {
    const paths = temp();
    const firstDriver = new ControlledDriver(() => ({
      text: 'restart reply one',
      conversationUrl: 'https://chatgpt.com/c/restart-alpha',
    }));
    const firstRuntime = await runtime(paths, firstDriver);
    const headers = { ...auth, 'x-conversation-key': 'restart-thread' };

    const first = await firstRuntime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload([{ role: 'user', content: 'restart one' }]),
    });
    expect(first.statusCode).toBe(200);
    await firstRuntime.close();
    runtimes.splice(runtimes.indexOf(firstRuntime), 1);

    const secondDriver = new ControlledDriver(() => ({
      text: 'restart reply two',
      conversationUrl: 'https://chatgpt.com/c/restart-alpha',
    }));
    const secondRuntime = await runtime(paths, secondDriver);
    const second = await secondRuntime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload([{ role: 'user', content: 'restart two' }]),
    });

    expect(second.statusCode).toBe(200);
    expect(secondDriver.navigationCalls[0]).toEqual({
      type: 'conversation',
      page: secondDriver.calls[0]!.page,
      conversationUrl: 'https://chatgpt.com/c/restart-alpha',
    });
    expect(secondDriver.calls[0]!.request.prompt).not.toContain('restart one');
  });

  it('shares one persisted Conversation across Chat Completions and Responses with the same key', async () => {
    const paths = temp();
    const driver = new ControlledDriver((_call, index) => ({
      text: index === 0 ? 'cross reply one' : 'cross reply two',
      conversationUrl: 'https://chatgpt.com/c/cross-protocol',
    }));
    const gateway = await runtime(paths, driver);
    const headers = { ...auth, 'x-conversation-key': 'cross-protocol-thread' };

    const first = await gateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload([{ role: 'user', content: 'cross turn one' }]),
    });
    expect(first.statusCode).toBe(200);

    const second = await gateway.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: { model: 'chatgpt-web', input: 'cross turn two' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().output[0].content[0].text).toBe('cross reply two');

    expect(driver.navigationCalls[1]).toEqual({
      type: 'conversation',
      page: driver.calls[1]!.page,
      conversationUrl: 'https://chatgpt.com/c/cross-protocol',
    });
    expect(driver.calls[1]!.request.prompt).toContain('cross turn two');
    expect(driver.calls[1]!.request.prompt).not.toContain('cross turn one');
    const saved = gateway.persistence.conversationStore.loadByKey('cross-protocol-thread')!;
    expect(saved.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(saved.conversation.chatgptConversationUrl).toBe('https://chatgpt.com/c/cross-protocol');
  });

  it('REBUILDs through HTTP when the caller edits previously synchronized history', async () => {
    const paths = temp();
    const driver = new ControlledDriver((_call, index) => ({
      text: index === 0 ? 'original reply' : 'rebuilt reply',
      conversationUrl:
        index === 0 ? 'https://chatgpt.com/c/original' : 'https://chatgpt.com/c/rebuilt',
    }));
    const gateway = await runtime(paths, driver);
    const headers = { ...auth, 'x-conversation-key': 'rebuild-thread' };

    await gateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload([{ role: 'user', content: 'original user' }]),
    });
    const rebuilt = await gateway.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload([
        { role: 'user', content: 'edited original user' },
        { role: 'assistant', content: 'original reply' },
        { role: 'user', content: 'new user' },
      ]),
    });

    expect(rebuilt.statusCode).toBe(200);
    expect(driver.navigationCalls[1]).toEqual({
      type: 'fresh',
      page: driver.calls[1]!.page,
    });
    expect(driver.calls[1]!.request.prompt).toContain('edited original user');
    expect(
      gateway.persistence.conversationStore.loadByKey('rebuild-thread')?.conversation
        .chatgptConversationUrl,
    ).toBe('https://chatgpt.com/c/rebuilt');
  });
});
