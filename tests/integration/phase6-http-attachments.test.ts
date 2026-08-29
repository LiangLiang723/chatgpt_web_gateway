import { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../../src/api/server.js';
import { AttachmentResolver } from '../../src/attachments/resolver.js';
import { AttachmentStager } from '../../src/attachments/staging.js';
import { FileService } from '../../src/attachments/file-service.js';
import type { RemoteFetchResult } from '../../src/attachments/network-policy.js';
import type {
  ChatGptStreamingTextDriver,
  ChatGptTextRequest,
  ChatGptTextResult,
  ChatGptTextTurn,
} from '../../src/chatgpt/driver.js';
import { ChatGptDriverError } from '../../src/chatgpt/errors.js';
import { loadConfig } from '../../src/config/index.js';
import {
  createConversationExecutionEngine,
  type ConversationAttachmentResolver,
} from '../../src/conversations/conversation-engine.js';
import type {
  ConversationPageRegistry,
  ConversationPageSession,
} from '../../src/conversations/page-registry.js';
import {
  createConversationQueue,
  type ConversationQueue,
} from '../../src/conversations/conversation-queue.js';
import { createPersistenceContext, type PersistenceContext } from '../../src/persistence/index.js';
import type { AssistantSnapshot } from '../../src/stream/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const authHeaders = {
  authorization: 'Bearer test-key',
  'content-type': 'application/json',
};

interface HttpContext {
  paths: TempPersistencePaths;
  persistence: PersistenceContext;
  fileService: FileService;
  resolver: ConversationAttachmentResolver;
  registry: TestRegistry;
  driver: TestDriver;
  queue: ConversationQueue;
  app: FastifyInstance;
}

const contexts: HttpContext[] = [];

afterEach(async () => {
  while (contexts.length) {
    const context = contexts.pop();
    if (!context) continue;
    await context.app.close();
    context.queue.close();
    await context.registry.close();
    context.persistence.close();
    context.paths.cleanup();
  }
});

class TestRegistry implements ConversationPageRegistry {
  private readonly affinity = new Set<string>();

  hasAffinity(conversationId: string): boolean {
    return this.affinity.has(conversationId);
  }

  async acquire(conversationId?: string): Promise<ConversationPageSession> {
    let done = false;
    return {
      page: { id: 'phase6-http-page' } as unknown as Page,
      complete: async () => {
        if (done) return;
        done = true;
        if (conversationId !== undefined) this.affinity.add(conversationId);
      },
      fail: async () => {
        if (done) return;
        done = true;
        if (conversationId !== undefined) this.affinity.delete(conversationId);
      },
    };
  }

  async close(): Promise<void> {
    this.affinity.clear();
  }
}

class TestDriver implements ChatGptStreamingTextDriver {
  readonly requests: ChatGptTextRequest[] = [];
  nextStartError?: Error;
  nextText?: string;

  async openFresh(): Promise<void> {}

  async openConversation(): Promise<'restored'> {
    return 'restored';
  }

  async sendText(_page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
    this.requests.push(request);
    const text = this.nextText ?? 'phase6-http-ok';
    this.nextText = undefined;
    return { text, conversationUrl: 'https://chatgpt.com/c/phase6-http' };
  }

  async startText(_page: Page, request: ChatGptTextRequest): Promise<ChatGptTextTurn> {
    this.requests.push(request);
    if (this.nextStartError) {
      const error = this.nextStartError;
      this.nextStartError = undefined;
      throw error;
    }
    const snapshot: AssistantSnapshot = {
      exists: true,
      text: 'phase6-http-ok',
      completionMarkerPresent: true,
    };
    return {
      observe: async () => snapshot,
      stop: async () => 'already_complete',
      conversationUrl: async () => 'https://chatgpt.com/c/phase6-http',
    };
  }
}

function setup(
  options: {
    remoteFetch?: (url: string) => Promise<RemoteFetchResult>;
    wrapResolver?: (resolver: AttachmentResolver) => ConversationAttachmentResolver;
  } = {},
): HttpContext {
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
  const baseResolver = new AttachmentResolver({
    fileService,
    stager: new AttachmentStager({ dataDir: paths.root }),
    ...(options.remoteFetch === undefined ? {} : { remoteFetcher: { fetch: options.remoteFetch } }),
  });
  const resolver = options.wrapResolver?.(baseResolver) ?? baseResolver;
  const registry = new TestRegistry();
  const driver = new TestDriver();
  const queue = createConversationQueue();
  const execution = createConversationExecutionEngine({
    pageRegistry: registry,
    queue,
    driver,
    conversationStore: persistence.conversationStore,
    attachmentResolver: resolver,
    streamPollIntervalMs: 0,
    streamStableSamples: 1,
  });
  const app = buildServer({
    config: loadConfig({ GATEWAY_API_KEY: 'test-key', DATA_DIR: paths.root }),
    execute: execution.execute,
    stream: execution.stream,
    fileService,
  });
  const context = { paths, persistence, fileService, resolver, registry, driver, queue, app };
  contexts.push(context);
  return context;
}

async function publicFile(
  context: HttpContext,
  options: { filename: string; bytes: Buffer; mimeType?: string },
): Promise<string> {
  const file = await context.fileService.createPublicFile({
    filename: options.filename,
    ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    purpose: 'user_data',
    source: Readable.from([options.bytes]),
  });
  return file.publicId as string;
}

async function listen(context: HttpContext): Promise<string> {
  return context.app.listen({ host: '127.0.0.1', port: 0 });
}

function chatBody(content: unknown[], stream = false) {
  return {
    model: 'chatgpt-web',
    stream,
    messages: [{ role: 'user', content }],
  };
}

function responsesBody(content: unknown[], stream = false) {
  return {
    model: 'chatgpt-web',
    stream,
    input: [{ role: 'user', content }],
  };
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...authHeaders, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function expectPreparedUpload(driver: TestDriver, expectedKind: 'image' | 'file'): void {
  const attachment = driver.requests.at(-1)?.attachments?.[0];
  expect(attachment).toMatchObject({ kind: expectedKind, path: expect.any(String) });
}

describe('Phase 6 cross-protocol attachment HTTP matrix', () => {
  it('executes Chat Completions URL image through the shared Resolver/Engine', async () => {
    const fetchRemote = vi.fn(async () => ({
      contentType: 'image/png',
      source: Readable.from([PNG_BYTES]),
    }));
    const context = setup({ remoteFetch: fetchRemote });
    const base = await listen(context);

    const response = await postJson(
      base,
      '/v1/chat/completions',
      chatBody([
        { type: 'text', text: 'inspect image' },
        { type: 'image_url', image_url: { url: 'https://public.example/image.png' } },
      ]),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: 'phase6-http-ok' } }],
    });
    expect(fetchRemote).toHaveBeenCalledWith(
      'https://public.example/image.png',
      expect.objectContaining({ signal: undefined }),
    );
    expectPreparedUpload(context.driver, 'image');
  });

  it('executes Chat Completions Data URL image and Base64 file', async () => {
    const context = setup();
    const base = await listen(context);

    for (const content of [
      [
        { type: 'text', text: 'inspect image' },
        { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      ],
      [
        { type: 'text', text: 'inspect file' },
        {
          type: 'file',
          file: {
            file_data: Buffer.from('CHAT_FILE_DATA_TOKEN').toString('base64'),
            filename: 'chat-data.txt',
          },
        },
      ],
    ]) {
      const response = await postJson(base, '/v1/chat/completions', chatBody(content));
      expect(response.status).toBe(200);
    }

    expect(context.driver.requests.at(-2)?.attachments?.[0]?.kind).toBe('image');
    expect(context.driver.requests.at(-1)?.attachments?.[0]?.kind).toBe('file');
  });

  it('executes Chat Completions public file_id', async () => {
    const context = setup();
    const fileId = await publicFile(context, {
      filename: 'chat-file-id.txt',
      bytes: Buffer.from('CHAT_FILE_ID_TOKEN'),
      mimeType: 'text/plain',
    });
    const base = await listen(context);

    const response = await postJson(
      base,
      '/v1/chat/completions',
      chatBody([
        { type: 'text', text: 'inspect file id' },
        { type: 'file', file: { file_id: fileId } },
      ]),
    );

    expect(response.status).toBe(200);
    expectPreparedUpload(context.driver, 'file');
  });

  it('executes Responses input_image URL/Data URL/file_id and input_file data/file_id', async () => {
    const fetchRemote = vi.fn(async () => ({
      contentType: 'image/png',
      source: Readable.from([PNG_BYTES]),
    }));
    const context = setup({ remoteFetch: fetchRemote });
    const imageFileId = await publicFile(context, {
      filename: 'image-file-id.png',
      bytes: PNG_BYTES,
      mimeType: 'image/png',
    });
    const documentFileId = await publicFile(context, {
      filename: 'responses-file-id.txt',
      bytes: Buffer.from('RESPONSES_FILE_ID_TOKEN'),
      mimeType: 'text/plain',
    });
    const base = await listen(context);

    const cases = [
      { type: 'input_image', image_url: 'https://public.example/response.png' },
      { type: 'input_image', image_url: PNG_DATA_URL },
      { type: 'input_image', file_id: imageFileId },
      {
        type: 'input_file',
        file_data: Buffer.from('RESPONSES_DATA_TOKEN').toString('base64'),
        filename: 'responses-data.txt',
      },
      { type: 'input_file', file_id: documentFileId },
    ];

    for (const attachment of cases) {
      const response = await postJson(
        base,
        '/v1/responses',
        responsesBody([{ type: 'input_text', text: 'inspect' }, attachment]),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ object: 'response' });
    }

    expect(context.driver.requests).toHaveLength(cases.length);
    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });

  it('streams attachments through both protocol encoders', async () => {
    const context = setup();
    const base = await listen(context);

    const chat = await postJson(
      base,
      '/v1/chat/completions',
      chatBody(
        [
          { type: 'text', text: 'stream image' },
          { type: 'image_url', image_url: { url: PNG_DATA_URL } },
        ],
        true,
      ),
    );
    const chatText = await chat.text();
    expect(chat.status).toBe(200);
    expect(chat.headers.get('content-type')).toContain('text/event-stream');
    expect(chatText).toContain('phase6-http-ok');
    expect(chatText).toContain('data: [DONE]');

    const responses = await postJson(
      base,
      '/v1/responses',
      responsesBody(
        [
          { type: 'input_text', text: 'stream file' },
          {
            type: 'input_file',
            file_data: Buffer.from('STREAM_FILE_TOKEN').toString('base64'),
            filename: 'stream.txt',
          },
        ],
        true,
      ),
    );
    const responsesText = await responses.text();
    expect(responses.status).toBe(200);
    expect(responsesText).toContain('event: response.completed');
    expect(responsesText).not.toContain('data: [DONE]');
  });

  it('keeps invalid/deleted file_id failures pre-start as ordinary HTTP JSON', async () => {
    const context = setup();
    const fileId = await publicFile(context, {
      filename: 'deleted.txt',
      bytes: Buffer.from('DELETE_ME'),
      mimeType: 'text/plain',
    });
    await context.fileService.deletePublicFile(fileId);
    const base = await listen(context);

    for (const candidate of [fileId, 'file-does-not-exist']) {
      const response = await postJson(
        base,
        '/v1/chat/completions',
        chatBody(
          [
            { type: 'text', text: 'stream missing file' },
            { type: 'file', file: { file_id: candidate } },
          ],
          true,
        ),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: { code: 'file_not_found' } });
    }
  });

  it('encodes post-start Driver upload failure in both streams without a success terminal', async () => {
    const context = setup();
    const base = await listen(context);

    context.driver.nextStartError = new ChatGptDriverError({
      code: 'chatgpt_upload_failed',
      message: 'synthetic upload failure',
    });
    const chat = await postJson(
      base,
      '/v1/chat/completions',
      chatBody(
        [
          { type: 'text', text: 'fail upload' },
          { type: 'image_url', image_url: { url: PNG_DATA_URL } },
        ],
        true,
      ),
    );
    const chatText = await chat.text();
    expect(chat.status).toBe(200);
    expect(chatText).toContain('"code":"chatgpt_upload_failed"');
    expect(chatText).not.toContain('data: [DONE]');

    context.driver.nextStartError = new ChatGptDriverError({
      code: 'chatgpt_upload_failed',
      message: 'synthetic upload failure',
    });
    const responses = await postJson(
      base,
      '/v1/responses',
      responsesBody(
        [
          { type: 'input_text', text: 'fail upload' },
          {
            type: 'input_file',
            file_data: Buffer.from('FAIL_UPLOAD').toString('base64'),
            filename: 'fail.txt',
          },
        ],
        true,
      ),
    );
    const responsesText = await responses.text();
    expect(responses.status).toBe(200);
    expect(responsesText).toContain('chatgpt_upload_failed');
    expect(responsesText).not.toContain('event: response.completed');
  });

  it('keeps slow attachment resolution FIFO for the same Conversation key', async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let calls = 0;
    const context = setup({
      wrapResolver: (resolver) => ({
        retainStored: (attachments) => resolver.retainStored(attachments),
        resolveAll: async (attachments, request) => {
          calls += 1;
          if (calls === 1) {
            firstEntered.resolve();
            await releaseFirst.promise;
          }
          return resolver.resolveAll(attachments, request);
        },
      }),
    });
    const base = await listen(context);
    const body = chatBody([
      { type: 'text', text: 'fifo' },
      {
        type: 'file',
        file: {
          file_data: Buffer.from('FIFO_TOKEN').toString('base64'),
          filename: 'fifo.txt',
        },
      },
    ]);

    const first = postJson(base, '/v1/chat/completions', body, {
      'x-conversation-key': 'phase6-fifo',
    });
    await firstEntered.promise;
    const second = postJson(base, '/v1/chat/completions', body, {
      'x-conversation-key': 'phase6-fifo',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);

    releaseFirst.resolve();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('allows slow attachment resolution to overlap for different Conversation keys', async () => {
    const bothEntered = deferred();
    const releaseBoth = deferred();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const context = setup({
      wrapResolver: (resolver) => ({
        retainStored: (attachments) => resolver.retainStored(attachments),
        resolveAll: async (attachments, request) => {
          calls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (calls === 2) bothEntered.resolve();
          await releaseBoth.promise;
          try {
            return await resolver.resolveAll(attachments, request);
          } finally {
            active -= 1;
          }
        },
      }),
    });
    const base = await listen(context);
    const body = responsesBody([
      { type: 'input_text', text: 'parallel' },
      {
        type: 'input_file',
        file_data: Buffer.from('PARALLEL_TOKEN').toString('base64'),
        filename: 'parallel.txt',
      },
    ]);

    const first = postJson(base, '/v1/responses', body, {
      'x-conversation-key': 'phase6-parallel-a',
    });
    const second = postJson(base, '/v1/responses', body, {
      'x-conversation-key': 'phase6-parallel-b',
    });
    await bothEntered.promise;
    expect(maxActive).toBe(2);
    releaseBoth.resolve();

    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it('allows Phase 7 Tools and Structured Output with attachment execution enabled', async () => {
    const context = setup();
    const base = await listen(context);

    const tools = await postJson(base, '/v1/chat/completions', {
      model: 'chatgpt-web',
      stream: false,
      messages: [{ role: 'user', content: 'tool request' }],
      tools: [
        {
          type: 'function',
          function: { name: 'noop', parameters: { type: 'object' } },
        },
      ],
    });
    expect(tools.status).toBe(200);
    expect(await tools.json()).toMatchObject({ choices: [{ finish_reason: 'stop' }] });

    context.driver.nextText = '{"ok":true}';
    const structured = await postJson(base, '/v1/responses', {
      ...responsesBody([{ type: 'input_text', text: 'structured' }]),
      text: { format: { type: 'json_object' } },
    });
    expect(structured.status).toBe(200);
    expect(await structured.json()).toMatchObject({
      object: 'response',
      status: 'completed',
      output: [
        {
          content: [{ type: 'output_text', text: '{"ok":true}' }],
        },
      ],
    });
  });
});
