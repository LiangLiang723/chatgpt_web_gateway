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

function streamRequest(conversationKey = 'stream-thread'): NormalizedRequest {
  return {
    requestId: 'stream-request',
    conversationKey,
    instructions: [{ role: 'system', content: 'system-v1' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'stream this reply' }] }],
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: true },
    diagnostics: { ignoredParameters: [] },
  };
}

class FakePage {
  isClosed(): boolean {
    return false;
  }
}

class FakePageRegistry implements ConversationPageRegistry {
  readonly completed: Array<string | undefined> = [];
  readonly failed: Array<string | undefined> = [];

  hasAffinity(): boolean {
    return false;
  }

  async acquire(conversationId?: string): Promise<ConversationPageSession> {
    let done = false;
    return {
      page: new FakePage() as unknown as Page,
      complete: async () => {
        if (done) return;
        done = true;
        this.completed.push(conversationId);
      },
      fail: async () => {
        if (done) return;
        done = true;
        this.failed.push(conversationId);
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
  onStart?: () => void;
  stopCalls = 0;

  async openFresh(): Promise<void> {}

  async openConversation(): Promise<'restored'> {
    return 'restored';
  }

  async startText(): Promise<ChatGptTextTurn> {
    this.onStart?.();
    let index = 0;
    return {
      observe: async () => this.snapshots[Math.min(index++, this.snapshots.length - 1)]!,
      stop: async () => {
        this.stopCalls += 1;
        return 'stopped';
      },
      conversationUrl: async () => 'https://chatgpt.com/c/stream-thread',
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

describe('Conversation true Streaming', () => {
  it('starts SSE before the checkpoint, streams stable deltas, then commits clean before completed', async () => {
    const db = persistence();
    const driver = new FakeStreamingDriver();
    const registry = new FakePageRegistry();
    const queue = new DirectQueue();
    driver.snapshots.push(
      { exists: false, text: '', completionMarkerPresent: false },
      { exists: true, text: 'H', completionMarkerPresent: false },
      { exists: true, text: 'He', completionMarkerPresent: false },
      { exists: true, text: 'Hel', completionMarkerPresent: false },
      { exists: true, text: 'Hell', completionMarkerPresent: false },
      { exists: true, text: 'Hello', completionMarkerPresent: true },
      { exists: true, text: 'Hello!', completionMarkerPresent: true },
      { exists: true, text: 'Hello!', completionMarkerPresent: true },
      { exists: true, text: 'Hello!', completionMarkerPresent: true },
      { exists: true, text: 'Hello!', completionMarkerPresent: true },
    );

    const engine = createConversationExecutionEngine({
      pageRegistry: registry,
      queue,
      driver,
      conversationStore: db.conversationStore,
      now: () => 1000,
      randomUuid: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      streamClock: clock(),
      streamPollIntervalMs: 10,
      streamTimeoutMs: 200,
    });
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
    expect(registry.completed).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);

    const saved = db.conversationStore.loadByKey('stream-thread')!;
    expect(saved.conversation.sync).toEqual({ status: 'clean', syncedMessageCount: 2 });
    expect(saved.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Hello!' }]);
  });
});
