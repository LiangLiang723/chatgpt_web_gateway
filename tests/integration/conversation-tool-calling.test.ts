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
import { TOOL_PROTOCOL_END, TOOL_PROTOCOL_START } from '../../src/tools/protocol.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const resources: TempPersistencePaths[] = [];
const contexts: PersistenceContext[] = [];

afterEach(() => {
  while (contexts.length > 0) contexts.pop()?.close();
  while (resources.length > 0) resources.pop()?.cleanup();
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

const weather: NormalizedTool = {
  type: 'function',
  name: 'get_weather',
  description: 'Get deterministic weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

const time: NormalizedTool = {
  type: 'function',
  name: 'get_time',
  description: 'Get deterministic local time for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

function user(text: string): NormalizedMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function toolResult(id: string, text: string): NormalizedMessage {
  return { role: 'tool', toolCallId: id, content: [{ type: 'text', text }] };
}

function request(options: {
  messages: NormalizedMessage[];
  conversationKey?: string;
  tools?: NormalizedTool[];
  toolChoice?: NormalizedToolChoice;
}): NormalizedRequest {
  return {
    requestId: `req-${options.messages.length}-${options.conversationKey ?? 'none'}`,
    ...(options.conversationKey === undefined ? {} : { conversationKey: options.conversationKey }),
    instructions: [{ role: 'system', content: 'Use tools only when the policy requires them.' }],
    messages: options.messages,
    tools: options.tools ?? [],
    toolChoice: options.toolChoice ?? { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: false },
    diagnostics: { ignoredParameters: [] },
  };
}

function protocol(calls: Array<{ name: string; arguments: Record<string, unknown> }>): string {
  return `${TOOL_PROTOCOL_START}\n${JSON.stringify({ requests: calls })}\n${TOOL_PROTOCOL_END}`;
}

class FakePage {
  isClosed(): boolean {
    return false;
  }
}

class FakePageRegistry implements ConversationPageRegistry {
  private readonly retained = new Map<string, FakePage>();

  hasAffinity(conversationId: string): boolean {
    return this.retained.has(conversationId);
  }

  async acquire(conversationId?: string): Promise<ConversationPageSession> {
    const page =
      (conversationId === undefined ? undefined : this.retained.get(conversationId)) ??
      new FakePage();
    let settled = false;
    return {
      page: page as unknown as Page,
      complete: async () => {
        if (settled) return;
        settled = true;
        if (conversationId !== undefined) this.retained.set(conversationId, page);
      },
      fail: async () => {
        if (settled) return;
        settled = true;
        if (conversationId !== undefined) this.retained.delete(conversationId);
      },
    };
  }

  async close(): Promise<void> {
    this.retained.clear();
  }
}

class ImmediateQueue implements ConversationQueue {
  get pendingKeyCount(): number {
    return 0;
  }

  async run<T>(_conversationKey: string, work: () => Promise<T>): Promise<T> {
    return work();
  }

  close(): void {}
}

class FakeDriver implements ChatGptTextDriver {
  readonly prompts: string[] = [];
  readonly results: ChatGptTextResult[] = [];
  readonly openedFresh: number[] = [];
  readonly openedConversation: string[] = [];

  async openFresh(page: Page): Promise<void> {
    void page;
    this.openedFresh.push(this.prompts.length);
  }

  async openConversation(page: Page, url: string): Promise<'restored' | 'not_restorable'> {
    void page;
    this.openedConversation.push(url);
    return 'restored';
  }

  async sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
    void page;
    this.prompts.push(request.prompt);
    const result = this.results.shift();
    if (!result) throw new Error('No fake tool result configured');
    return result;
  }
}

function uuidSequence(): () => string {
  const values = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ];
  let index = 0;
  return () => values[index++] ?? `eeeeeeee-eeee-4eee-8eee-${String(index).padStart(12, '0')}`;
}

function payload(prompt: string): Record<string, unknown> {
  return JSON.parse(prompt.slice(prompt.indexOf('{'))) as Record<string, unknown>;
}

describe('Conversation Engine tool calling', () => {
  it('persists a Gateway-owned tool call and REBUILDs when the function policy changes to none', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    const registry = new FakePageRegistry();
    driver.results.push(
      {
        text: protocol([{ name: 'get_weather', arguments: { city: 'Xiamen' } }]),
        conversationUrl: 'https://chatgpt.com/c/tool-one',
      },
      { text: 'The weather result is sunny.', conversationUrl: 'https://chatgpt.com/c/tool-one' },
    );
    const execute = createConversationEngine({
      pageRegistry: registry,
      queue: new ImmediateQueue(),
      driver,
      conversationStore: db.conversationStore,
      now: () => 10_000,
      randomUuid: uuidSequence(),
    });

    const first = await execute(
      request({
        conversationKey: 'tool-thread',
        messages: [user('What is the weather in Xiamen?')],
        tools: [weather],
        toolChoice: { mode: 'required' },
      }),
    );
    expect(first.type).toBe('tool_calls');
    if (first.type !== 'tool_calls') throw new Error('Expected tool call result');
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]).toMatchObject({
      id: 'call_bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb',
      name: 'get_weather',
      arguments: '{"city":"Xiamen"}',
    });

    const persisted = db.conversationStore.loadByKey('tool-thread');
    expect(persisted?.conversation.sync.status).toBe('clean');
    expect(persisted?.toolCalls).toHaveLength(1);
    expect(persisted?.toolCalls[0]).toMatchObject({
      externalCallId: first.toolCalls[0]!.id,
      name: 'get_weather',
      argumentsText: '{"city":"Xiamen"}',
    });
    expect(persisted?.messages.at(-1)).toMatchObject({ role: 'assistant', content: [] });

    const second = await execute(
      request({
        conversationKey: 'tool-thread',
        messages: [toolResult(first.toolCalls[0]!.id, '{"condition":"sunny"}')],
        tools: [weather],
        toolChoice: { mode: 'none' },
      }),
    );
    expect(second).toMatchObject({ type: 'text', text: 'The weather result is sunny.' });

    expect(driver.openedFresh).toEqual([0, 1]);
    expect(driver.openedConversation).toEqual([]);
    const rebuilt = payload(driver.prompts[1]!);
    expect(rebuilt).toMatchObject({
      version: 2,
      function_policy: {
        mode: 'none',
        require_function_request: false,
        allowed_functions: [],
      },
      history: [
        { role: 'user', text: 'What is the weather in Xiamen?' },
        {
          role: 'assistant',
          external_function_requests: [
            {
              request_id: first.toolCalls[0]!.id,
              name: 'get_weather',
              arguments: '{"city":"Xiamen"}',
            },
          ],
        },
      ],
      pending: [
        {
          role: 'external_function_result',
          request_id: first.toolCalls[0]!.id,
          name: 'get_weather',
          result: '{"condition":"sunny"}',
        },
      ],
    });
    expect(rebuilt).not.toHaveProperty('external_functions');
    expect(driver.prompts[1]).toContain(
      'Continue the prior user request using the pending external function result data now.',
    );
    expect(driver.prompts[1]).toContain(
      'The current function_policy overrides earlier function-request instructions for this turn. Do not create or repeat any external function request.',
    );
    expect(driver.prompts[1]).not.toContain('Answer the final pending user message now.');

    const final = db.conversationStore.loadByKey('tool-thread');
    expect(final?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(final?.messages[2]).toMatchObject({ toolCallId: first.toolCalls[0]!.id });
    expect(final?.toolCalls[0]?.externalCallId).toBe(first.toolCalls[0]!.id);
  });

  it('returns multiple calls with distinct Gateway ids', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.results.push({
      text: protocol([
        { name: 'get_weather', arguments: { city: 'Xiamen' } },
        { name: 'get_time', arguments: { city: 'Tokyo' } },
      ]),
      conversationUrl: 'https://chatgpt.com/c/tool-many',
    });
    const execute = createConversationEngine({
      pageRegistry: new FakePageRegistry(),
      queue: new ImmediateQueue(),
      driver,
      conversationStore: db.conversationStore,
      now: () => 20_000,
      randomUuid: uuidSequence(),
    });

    const result = await execute(
      request({
        conversationKey: 'tool-many',
        messages: [user('Call both tools.')],
        tools: [weather, time],
        toolChoice: { mode: 'required' },
      }),
    );
    expect(result.type).toBe('tool_calls');
    if (result.type !== 'tool_calls') throw new Error('Expected tool call result');
    expect(result.toolCalls.map((call) => call.id)).toEqual([
      'call_bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb',
      'call_cccccccccccc4ccc8ccccccccccccccc',
    ]);
    expect(new Set(result.toolCalls.map((call) => call.id)).size).toBe(2);
  });

  it('keeps the checkpoint in_flight when the private protocol is malformed', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.results.push({
      text: `${TOOL_PROTOCOL_START}\n{"requests":[`,
      conversationUrl: 'https://chatgpt.com/c/tool-bad',
    });
    const execute = createConversationEngine({
      pageRegistry: new FakePageRegistry(),
      queue: new ImmediateQueue(),
      driver,
      conversationStore: db.conversationStore,
      now: () => 30_000,
      randomUuid: uuidSequence(),
    });

    await expect(
      execute(
        request({
          conversationKey: 'tool-bad',
          messages: [user('Use the weather tool.')],
          tools: [weather],
          toolChoice: { mode: 'required' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'chatgpt_tool_protocol_invalid' });
    expect(db.conversationStore.loadByKey('tool-bad')?.conversation.sync).toMatchObject({
      status: 'in_flight',
      syncedMessageCount: 0,
    });
  });

  it('REBUILDs when the tool schema changes and rejects an unknown incremental tool result', async () => {
    const db = persistence();
    const driver = new FakeDriver();
    driver.results.push(
      { text: 'first text', conversationUrl: 'https://chatgpt.com/c/schema-old' },
      { text: 'second text', conversationUrl: 'https://chatgpt.com/c/schema-new' },
    );
    const registry = new FakePageRegistry();
    const execute = createConversationEngine({
      pageRegistry: registry,
      queue: new ImmediateQueue(),
      driver,
      conversationStore: db.conversationStore,
      now: () => 40_000,
      randomUuid: uuidSequence(),
    });

    await execute(
      request({
        conversationKey: 'schema-change',
        messages: [user('Answer without a call if possible.')],
        tools: [weather],
        toolChoice: { mode: 'auto' },
      }),
    );
    await execute(
      request({
        conversationKey: 'schema-change',
        messages: [user('Use the updated context.')],
        tools: [{ ...weather, description: 'Changed weather semantics' }],
        toolChoice: { mode: 'auto' },
      }),
    );
    expect(driver.openedFresh).toHaveLength(2);
    expect(driver.prompts[1]).toContain('Changed weather semantics');

    await expect(
      execute(
        request({
          conversationKey: 'schema-change',
          messages: [toolResult('call_missing', 'bad')],
          tools: [{ ...weather, description: 'Changed weather semantics' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_conversation_request' });
  });
});
