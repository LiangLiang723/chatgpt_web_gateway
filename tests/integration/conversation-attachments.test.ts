import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedRequest } from '../../src/api/normalized.js';
import { AttachmentResolver } from '../../src/attachments/resolver.js';
import { AttachmentStager } from '../../src/attachments/staging.js';
import { FileService } from '../../src/attachments/file-service.js';
import type {
  ChatGptStreamingTextDriver,
  ChatGptTextRequest,
  ChatGptTextResult,
  ChatGptTextTurn,
} from '../../src/chatgpt/driver.js';
import { ChatGptDriverError } from '../../src/chatgpt/errors.js';
import { createConversationExecutionEngine } from '../../src/conversations/conversation-engine.js';
import type {
  ConversationPageRegistry,
  ConversationPageSession,
} from '../../src/conversations/page-registry.js';
import type { ConversationQueue } from '../../src/conversations/conversation-queue.js';
import { createPersistenceContext, type PersistenceContext } from '../../src/persistence/index.js';
import { TextStreamAbortedError } from '../../src/stream/errors.js';
import type { AssistantSnapshot } from '../../src/stream/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

interface TestContext {
  paths: TempPersistencePaths;
  persistence: PersistenceContext;
  fileService: FileService;
  resolver: AttachmentResolver;
}

const contexts: TestContext[] = [];

afterEach(() => {
  while (contexts.length) {
    const context = contexts.pop();
    context?.persistence.close();
    context?.paths.cleanup();
  }
});

function setup(): TestContext {
  const paths = createTempPersistencePaths();
  const persistence = createPersistenceContext({
    databasePath: paths.databasePath,
    migrationsDir: paths.migrationsDir,
  });
  const fileService = new FileService({
    dataDir: paths.root,
    attachments: persistence.attachments,
    files: persistence.files,
    fileBlobs: persistence.fileBlobs,
    fileLifecycleStore: persistence.fileLifecycleStore,
  });
  const resolver = new AttachmentResolver({
    fileService,
    stager: new AttachmentStager({ dataDir: paths.root }),
  });
  const context = { paths, persistence, fileService, resolver };
  contexts.push(context);
  return context;
}

function attachmentRequest(
  options: {
    conversationKey?: string;
    stream?: boolean;
    data?: string;
    attachmentId?: string;
    filename?: string;
    text?: string;
    requestId?: string;
  } = {},
): NormalizedRequest {
  const attachmentId = options.attachmentId ?? 'attachment-1';
  return {
    requestId: options.requestId ?? `req-${attachmentId}`,
    ...(options.conversationKey === undefined ? {} : { conversationKey: options.conversationKey }),
    instructions: [{ role: 'system', content: 'Read attached files.' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: options.text ?? 'Return the token.' },
          { type: 'attachment', attachmentId },
        ],
      },
    ],
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [
      {
        id: attachmentId,
        kind: 'file',
        source: {
          type: 'base64',
          data: options.data ?? Buffer.from('PHASE6_CONVERSATION_TOKEN').toString('base64'),
          filename: options.filename ?? 'notes.txt',
        },
      },
    ],
    output: { mode: 'text', stream: options.stream ?? false },
    diagnostics: { ignoredParameters: [] },
  };
}

class RecordingQueue implements ConversationQueue {
  readonly events: string[];
  closed = false;

  constructor(events: string[]) {
    this.events = events;
  }

  get pendingKeyCount(): number {
    return 0;
  }

  async run<T>(conversationKey: string, work: () => Promise<T>): Promise<T> {
    this.events.push(`queue:${conversationKey}:start`);
    const result = await work();
    this.events.push(`queue:${conversationKey}:end`);
    return result;
  }

  close(): void {
    this.closed = true;
  }
}

class RecordingRegistry implements ConversationPageRegistry {
  readonly events: string[];
  readonly failed: string[] = [];
  readonly completed: string[] = [];
  private readonly affinity = new Set<string>();

  constructor(events: string[]) {
    this.events = events;
  }

  hasAffinity(conversationId: string): boolean {
    return this.affinity.has(conversationId);
  }

  async acquire(conversationId?: string): Promise<ConversationPageSession> {
    this.events.push('page:acquire');
    let done = false;
    return {
      page: { id: 'page-1' } as unknown as Page,
      complete: async () => {
        if (done) return;
        done = true;
        this.completed.push(conversationId ?? 'anonymous');
        if (conversationId !== undefined) this.affinity.add(conversationId);
      },
      fail: async () => {
        if (done) return;
        done = true;
        this.failed.push(conversationId ?? 'anonymous');
        if (conversationId !== undefined) this.affinity.delete(conversationId);
      },
    };
  }

  async close(): Promise<void> {}
}

class RecordingDriver implements ChatGptStreamingTextDriver {
  readonly events: string[];
  readonly sent: ChatGptTextRequest[] = [];
  nextStartError?: Error;
  onSend?: (request: ChatGptTextRequest) => void;

  constructor(events: string[]) {
    this.events = events;
  }

  async openFresh(): Promise<void> {
    this.events.push('driver:openFresh');
  }

  async openConversation(): Promise<'restored'> {
    this.events.push('driver:openConversation');
    return 'restored';
  }

  async sendText(_page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
    this.events.push('driver:send');
    this.sent.push(request);
    this.onSend?.(request);
    return { text: 'PHASE6_CONVERSATION_TOKEN', conversationUrl: 'https://chatgpt.com/c/phase6' };
  }

  async startText(_page: Page, request: ChatGptTextRequest): Promise<ChatGptTextTurn> {
    this.events.push('driver:start');
    this.sent.push(request);
    if (this.nextStartError) throw this.nextStartError;
    const snapshot: AssistantSnapshot = {
      exists: true,
      text: 'PHASE6_CONVERSATION_TOKEN',
      completionMarkerPresent: true,
    };
    return {
      observe: async () => snapshot,
      stop: async () => 'already_complete',
      conversationUrl: async () => 'https://chatgpt.com/c/phase6',
    };
  }
}

function wrapResolver(resolver: AttachmentResolver, events: string[]) {
  return {
    resolveAll: async (...args: Parameters<AttachmentResolver['resolveAll']>) => {
      events.push('resolver:resolve');
      return resolver.resolveAll(...args);
    },
    retainStored: async (...args: Parameters<AttachmentResolver['retainStored']>) => {
      events.push('resolver:retainStored');
      return resolver.retainStored(...args);
    },
  };
}

describe('Conversation attachment lifecycle', () => {
  it('resolves inside the same-key queue before Page acquire, checkpoints before Browser upload, persists redacted AttachmentRecords, and cleans staging', async () => {
    const context = setup();
    const events: string[] = [];
    const registry = new RecordingRegistry(events);
    const queue = new RecordingQueue(events);
    const driver = new RecordingDriver(events);
    driver.onSend = (request) => {
      const inFlight = context.persistence.conversationStore.loadByKey('thread-attachment');
      expect(inFlight?.conversation.sync.status).toBe('in_flight');
      expect(request.attachments).toHaveLength(1);
      expect(request.attachments?.[0]).toMatchObject({
        localAttachmentId: 'attachment-1',
        kind: 'file',
        displayFilename: 'notes.txt',
      });
      expect(existsSync(request.attachments?.[0]?.path ?? '')).toBe(true);
    };

    const execution = createConversationExecutionEngine({
      pageRegistry: registry,
      queue,
      driver,
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, events),
      now: () => 10_000,
      randomUuid: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    } as Parameters<typeof createConversationExecutionEngine>[0] & {
      attachmentResolver: ReturnType<typeof wrapResolver>;
    });

    await expect(
      execution.execute(attachmentRequest({ conversationKey: 'thread-attachment' })),
    ).resolves.toMatchObject({
      type: 'text',
      text: 'PHASE6_CONVERSATION_TOKEN',
    });

    expect(events.indexOf('resolver:resolve')).toBeGreaterThan(
      events.indexOf('queue:thread-attachment:start'),
    );
    expect(events.indexOf('resolver:resolve')).toBeLessThan(events.indexOf('page:acquire'));
    expect(events.indexOf('driver:send')).toBeGreaterThan(events.indexOf('driver:openFresh'));

    const saved = context.persistence.conversationStore.loadByKey('thread-attachment');
    expect(saved?.conversation.sync).toEqual({ status: 'clean', syncedMessageCount: 2 });
    expect(saved?.messages[0]?.content).toEqual([
      { type: 'text', text: 'Return the token.' },
      { type: 'attachment', attachmentId: 'attachment-1' },
    ]);
    expect(saved?.attachments).toEqual([
      expect.objectContaining({
        localAttachmentId: 'attachment-1',
        kind: 'file',
        source: { type: 'base64' },
        fileId: expect.any(String),
      }),
    ]);
    const databaseText = context.persistence.database
      .prepare("SELECT group_concat(source_json, ' ') AS value FROM attachments")
      .get() as { value: string | null };
    expect(databaseText.value).not.toContain('PHASE6_CONVERSATION_TOKEN');
    expect(databaseText.value).not.toContain(
      Buffer.from('PHASE6_CONVERSATION_TOKEN').toString('base64'),
    );
    expect(existsSync(`${context.paths.root}/temp/attachments/req-attachment-1`)).toBe(false);
  });

  it('uploads only the current attachment for APPEND and preserves both AttachmentRecords', async () => {
    const context = setup();
    const events: string[] = [];
    const registry = new RecordingRegistry(events);
    const driver = new RecordingDriver(events);
    const execution = createConversationExecutionEngine({
      pageRegistry: registry,
      queue: new RecordingQueue(events),
      driver,
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, events),
      now: () => 11_000,
      randomUuid: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });

    await execution.execute(
      attachmentRequest({
        conversationKey: 'thread-append',
        attachmentId: 'attachment-1',
        filename: 'first.txt',
        requestId: 'req-append-1',
      }),
    );
    await execution.execute(
      attachmentRequest({
        conversationKey: 'thread-append',
        attachmentId: 'attachment-2',
        filename: 'second.txt',
        text: 'Read the second token.',
        requestId: 'req-append-2',
      }),
    );

    expect(driver.sent).toHaveLength(2);
    expect(driver.sent[1]?.attachments).toEqual([
      expect.objectContaining({
        localAttachmentId: 'attachment-2',
        displayFilename: 'second.txt',
      }),
    ]);
    const saved = context.persistence.conversationStore.loadByKey('thread-append');
    expect(saved?.attachments).toHaveLength(2);
    expect(saved?.attachments.map((item) => item.localAttachmentId).sort()).toEqual([
      'attachment-1',
      'attachment-2',
    ]);
  });

  it('uploads only the current attachment for RESTORE after Page affinity is lost', async () => {
    const context = setup();
    const firstEvents: string[] = [];
    const first = createConversationExecutionEngine({
      pageRegistry: new RecordingRegistry(firstEvents),
      queue: new RecordingQueue(firstEvents),
      driver: new RecordingDriver(firstEvents),
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, firstEvents),
      now: () => 12_000,
      randomUuid: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    await first.execute(
      attachmentRequest({
        conversationKey: 'thread-restore',
        filename: 'stored.txt',
        requestId: 'req-restore-1',
      }),
    );

    const secondEvents: string[] = [];
    const secondDriver = new RecordingDriver(secondEvents);
    const second = createConversationExecutionEngine({
      pageRegistry: new RecordingRegistry(secondEvents),
      queue: new RecordingQueue(secondEvents),
      driver: secondDriver,
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, secondEvents),
      now: () => 13_000,
    });
    await second.execute(
      attachmentRequest({
        conversationKey: 'thread-restore',
        attachmentId: 'attachment-2',
        filename: 'current.txt',
        requestId: 'req-restore-2',
      }),
    );

    expect(secondEvents).toContain('driver:openConversation');
    expect(secondDriver.sent[0]?.attachments).toEqual([
      expect.objectContaining({
        localAttachmentId: 'attachment-2',
        displayFilename: 'current.txt',
      }),
    ]);
  });

  it('uploads retained historical attachments plus the current attachment for REBUILD', async () => {
    const context = setup();
    const events: string[] = [];
    const registry = new RecordingRegistry(events);
    const driver = new RecordingDriver(events);
    const execution = createConversationExecutionEngine({
      pageRegistry: registry,
      queue: new RecordingQueue(events),
      driver,
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, events),
      now: () => 14_000,
      randomUuid: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });
    await execution.execute(
      attachmentRequest({
        conversationKey: 'thread-rebuild',
        filename: 'history.txt',
        requestId: 'req-rebuild-1',
      }),
    );
    const stored = context.persistence.conversationStore.loadByKey('thread-rebuild');
    expect(stored).toBeDefined();
    context.persistence.conversationStore.markSyncInFlight(stored!.conversation.id, 14_500);

    await execution.execute(
      attachmentRequest({
        conversationKey: 'thread-rebuild',
        attachmentId: 'attachment-2',
        filename: 'current.txt',
        requestId: 'req-rebuild-2',
      }),
    );

    const uploads = driver.sent[1]?.attachments ?? [];
    expect(uploads).toHaveLength(2);
    expect(uploads.map((item) => item.displayFilename)).toEqual(['history.txt', 'current.txt']);
    expect(uploads[0]?.localAttachmentId).toMatch(/^stored:/);
    expect(uploads[1]?.localAttachmentId).toBe('attachment-2');
    const saved = context.persistence.conversationStore.loadByKey('thread-rebuild');
    expect(saved?.attachments).toHaveLength(2);
    expect(saved?.conversation.sync.status).toBe('clean');
  });

  it('returns resolver errors before Page acquisition and before creating an in-flight checkpoint', async () => {
    const context = setup();
    const events: string[] = [];
    const registry = new RecordingRegistry(events);
    const execution = createConversationExecutionEngine({
      pageRegistry: registry,
      queue: new RecordingQueue(events),
      driver: new RecordingDriver(events),
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, events),
    } as Parameters<typeof createConversationExecutionEngine>[0] & {
      attachmentResolver: ReturnType<typeof wrapResolver>;
    });

    await expect(
      execution.execute(
        attachmentRequest({ conversationKey: 'thread-invalid', data: 'not base64!' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_attachment' });

    expect(events).not.toContain('page:acquire');
    expect(context.persistence.conversationStore.loadByKey('thread-invalid')).toBeUndefined();
  });

  it('does not emit stream started when attachment resolution fails', async () => {
    const context = setup();
    const events: string[] = [];
    const sink = vi.fn(async () => undefined);
    const execution = createConversationExecutionEngine({
      pageRegistry: new RecordingRegistry(events),
      queue: new RecordingQueue(events),
      driver: new RecordingDriver(events),
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, events),
    } as Parameters<typeof createConversationExecutionEngine>[0] & {
      attachmentResolver: ReturnType<typeof wrapResolver>;
    });

    await expect(
      execution.stream(attachmentRequest({ stream: true, data: 'not base64!' }), {
        signal: new AbortController().signal,
        sink,
      }),
    ).rejects.toMatchObject({ code: 'invalid_attachment' });

    expect(sink).not.toHaveBeenCalled();
    expect(events).not.toContain('page:acquire');
  });

  it('keeps the checkpoint in_flight and discards the Page when upload aborts after stream started', async () => {
    const context = setup();
    const events: string[] = [];
    const registry = new RecordingRegistry(events);
    const driver = new RecordingDriver(events);
    driver.nextStartError = new TextStreamAbortedError();
    const sink = vi.fn(async () => undefined);
    const execution = createConversationExecutionEngine({
      pageRegistry: registry,
      queue: new RecordingQueue(events),
      driver,
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, events),
      now: () => 19_000,
      randomUuid: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });

    await expect(
      execution.stream(attachmentRequest({ conversationKey: 'thread-abort', stream: true }), {
        signal: new AbortController().signal,
        sink,
      }),
    ).rejects.toMatchObject({ code: 'stream_aborted' });

    expect(sink).toHaveBeenCalledWith({ type: 'started', startedAt: 19_000 });
    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' }));
    const checkpoint = context.persistence.conversationStore.loadByKey('thread-abort');
    expect(checkpoint?.conversation.sync.status).toBe('in_flight');
    expect(checkpoint?.attachments).toEqual([]);
    expect(registry.failed).toEqual(['ffffffff-ffff-4fff-8fff-ffffffffffff']);
  });

  it('does not emit a success terminal when final attachment aggregate persistence fails', async () => {
    const context = setup();
    const events: string[] = [];
    const registry = new RecordingRegistry(events);
    const driver = new RecordingDriver(events);
    const sink = vi.fn(async () => undefined);
    const originalSave = context.persistence.conversationStore.save.bind(
      context.persistence.conversationStore,
    );
    vi.spyOn(context.persistence.conversationStore, 'save').mockImplementation((aggregate) => {
      if (aggregate.messages.length > 0) throw new Error('synthetic final attachment save failure');
      originalSave(aggregate);
    });
    const execution = createConversationExecutionEngine({
      pageRegistry: registry,
      queue: new RecordingQueue(events),
      driver,
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, events),
      now: () => 19_500,
      randomUuid: () => '12121212-1212-4212-8212-121212121212',
      streamPollIntervalMs: 0,
      streamStableSamples: 1,
    });

    await expect(
      execution.stream(attachmentRequest({ conversationKey: 'thread-save-fail', stream: true }), {
        signal: new AbortController().signal,
        sink,
      }),
    ).rejects.toThrow('synthetic final attachment save failure');

    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' }));
    const checkpoint = context.persistence.conversationStore.loadByKey('thread-save-fail');
    expect(checkpoint?.conversation.sync.status).toBe('in_flight');
    expect(checkpoint?.messages).toEqual([]);
    expect(checkpoint?.attachments).toEqual([]);
    expect(registry.failed).toEqual(['12121212-1212-4212-8212-121212121212']);
  });

  it('keeps the checkpoint in_flight and discards the Page when upload fails after stream started', async () => {
    const context = setup();
    const events: string[] = [];
    const registry = new RecordingRegistry(events);
    const driver = new RecordingDriver(events);
    driver.nextStartError = new ChatGptDriverError({
      code: 'chatgpt_upload_failed',
      message: 'synthetic upload failure',
    });
    const sink = vi.fn(async () => undefined);
    const execution = createConversationExecutionEngine({
      pageRegistry: registry,
      queue: new RecordingQueue(events),
      driver,
      conversationStore: context.persistence.conversationStore,
      attachmentResolver: wrapResolver(context.resolver, events),
      now: () => 20_000,
      randomUuid: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    } as Parameters<typeof createConversationExecutionEngine>[0] & {
      attachmentResolver: ReturnType<typeof wrapResolver>;
    });

    await expect(
      execution.stream(attachmentRequest({ conversationKey: 'thread-stream', stream: true }), {
        signal: new AbortController().signal,
        sink,
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_upload_failed' });

    expect(sink).toHaveBeenCalledWith({ type: 'started', startedAt: 20_000 });
    const checkpoint = context.persistence.conversationStore.loadByKey('thread-stream');
    expect(checkpoint?.conversation.sync.status).toBe('in_flight');
    expect(checkpoint?.messages).toEqual([]);
    expect(checkpoint?.attachments).toEqual([]);
    expect(registry.failed).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  });
});
