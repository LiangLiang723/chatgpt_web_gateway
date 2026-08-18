import { afterEach, describe, expect, it } from 'vitest';

import { FileService } from '../../src/attachments/file-service.js';
import { loadConfig } from '../../src/config/index.js';
import { buildServer } from '../../src/api/server.js';
import { createPersistenceContext, type PersistenceContext } from '../../src/persistence/index.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

interface TestContext {
  paths: TempPersistencePaths;
  persistence: PersistenceContext;
  fileService: FileService;
  app: ReturnType<typeof buildServer>;
}

const contexts: TestContext[] = [];

afterEach(async () => {
  while (contexts.length) {
    const context = contexts.pop();
    if (!context) continue;
    await context.app.close();
    context.persistence.close();
    context.paths.cleanup();
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
    now: () => 1_786_900_000_123,
  });
  const config = loadConfig({
    GATEWAY_API_KEY: 'test-key',
    DATA_DIR: paths.root,
    UI_MODE: 'novnc',
  });
  const app = buildServer({ config, logger: false, fileService } as Parameters<
    typeof buildServer
  >[0] & { fileService: FileService });
  const context = { paths, persistence, fileService, app };
  contexts.push(context);
  return context;
}

interface MultipartPart {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
}

function multipart(parts: MultipartPart[]): { payload: Buffer; contentType: string } {
  const boundary = '----chatgpt-web-gateway-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const filename = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${filename}\r\n`));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(typeof part.value === 'string' ? Buffer.from(part.value) : part.value);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function createFile(
  context: TestContext,
  parts: MultipartPart[] = [
    { name: 'purpose', value: 'user_data' },
    { name: 'file', value: 'hello', filename: 'a.txt', contentType: 'text/plain' },
  ],
) {
  const body = multipart(parts);
  return context.app.inject({
    method: 'POST',
    url: '/v1/files',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': body.contentType,
    },
    payload: body.payload,
  });
}

function authHeaders(): { authorization: string } {
  return { authorization: 'Bearer test-key' };
}

describe('Files API create', () => {
  it('requires Gateway authentication', async () => {
    const context = setup();
    const body = multipart([
      { name: 'purpose', value: 'user_data' },
      { name: 'file', value: 'hello', filename: 'a.txt', contentType: 'text/plain' },
    ]);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { 'content-type': body.contentType },
      payload: body.payload,
    });

    expect(response.statusCode).toBe(401);
  });

  it('streams one multipart file and returns the minimal public File object', async () => {
    const context = setup();

    const response = await createFile(context);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: expect.stringMatching(/^file-[0-9a-f-]{36}$/),
      object: 'file',
      bytes: 5,
      created_at: 1_786_900_000,
      filename: 'a.txt',
      purpose: 'user_data',
    });
    expect(
      context.persistence.database.prepare('SELECT COUNT(*) AS count FROM files').get(),
    ).toMatchObject({ count: 1 });
  });

  it('accepts a file part before purpose without buffering the whole file in memory', async () => {
    const context = setup();

    const response = await createFile(context, [
      { name: 'file', value: 'hello', filename: 'ordered.txt', contentType: 'text/plain' },
      { name: 'purpose', value: 'vision' },
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ filename: 'ordered.txt', purpose: 'vision' });
  });

  it.each([
    {
      name: 'missing file',
      parts: [{ name: 'purpose', value: 'user_data' }],
      code: 'invalid_file_upload',
      status: 400,
    },
    {
      name: 'missing purpose',
      parts: [{ name: 'file', value: 'hello', filename: 'a.txt', contentType: 'text/plain' }],
      code: 'invalid_file_upload',
      status: 400,
    },
    {
      name: 'invalid purpose',
      parts: [
        { name: 'purpose', value: 'not-a-purpose' },
        { name: 'file', value: 'hello', filename: 'a.txt', contentType: 'text/plain' },
      ],
      code: 'invalid_file_upload',
      status: 400,
    },
    {
      name: 'unsupported expires_after',
      parts: [
        { name: 'purpose', value: 'user_data' },
        { name: 'expires_after', value: '3600' },
        { name: 'file', value: 'hello', filename: 'a.txt', contentType: 'text/plain' },
      ],
      code: 'invalid_file_upload',
      status: 400,
    },
    {
      name: 'unsafe filename',
      parts: [
        { name: 'purpose', value: 'user_data' },
        { name: 'file', value: 'hello', filename: '../a.txt', contentType: 'text/plain' },
      ],
      code: 'invalid_file_upload',
      status: 400,
    },
  ])('rejects $name with a stable error', async ({ parts, code, status }) => {
    const context = setup();

    const response = await createFile(context, parts);

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({
      error: { code, type: 'invalid_request_error' },
    });
  });

  it('rejects a stream above the Gateway file limit without returning a filesystem path', async () => {
    const context = setup();
    const response = await createFile(context, [
      { name: 'purpose', value: 'user_data' },
      {
        name: 'file',
        value: Buffer.alloc(32 * 1024 * 1024 + 1, 0x61),
        filename: 'large.bin',
        contentType: 'application/octet-stream',
      },
    ]);

    expect(response.statusCode).toBe(413);
    const body = response.json();
    expect(body).toMatchObject({
      error: { code: 'file_too_large', type: 'invalid_request_error' },
    });
    expect(JSON.stringify(body)).not.toContain(context.paths.root);
  });
});

describe('Files API lifecycle', () => {
  it('lists public active Files with purpose filter, cursor, limit, and stable list metadata', async () => {
    const context = setup();
    await createFile(context, [
      { name: 'purpose', value: 'user_data' },
      { name: 'file', value: 'one', filename: 'one.txt', contentType: 'text/plain' },
    ]);
    await createFile(context, [
      { name: 'purpose', value: 'vision' },
      { name: 'file', value: 'two', filename: 'two.txt', contentType: 'text/plain' },
    ]);
    await context.fileService.createPrivateFile({
      filename: 'private.txt',
      mimeType: 'text/plain',
      source: (async function* () {
        yield Buffer.from('private');
      })(),
    });

    const first = await context.app.inject({
      method: 'GET',
      url: '/v1/files?limit=1&order=desc',
      headers: authHeaders(),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody).toMatchObject({
      object: 'list',
      data: [expect.objectContaining({ object: 'file' })],
      first_id: expect.stringMatching(/^file-/),
      last_id: expect.stringMatching(/^file-/),
      has_more: true,
    });

    const second = await context.app.inject({
      method: 'GET',
      url: `/v1/files?limit=1&order=desc&after=${encodeURIComponent(firstBody.last_id)}`,
      headers: authHeaders(),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      object: 'list',
      data: [expect.objectContaining({ object: 'file' })],
      has_more: false,
    });

    const vision = await context.app.inject({
      method: 'GET',
      url: '/v1/files?purpose=vision&order=asc',
      headers: authHeaders(),
    });
    expect(vision.statusCode).toBe(200);
    expect(vision.json()).toMatchObject({
      data: [expect.objectContaining({ filename: 'two.txt', purpose: 'vision' })],
      has_more: false,
    });
  });

  it.each([
    ['/v1/files?limit=0', 'limit'],
    ['/v1/files?limit=10001', 'limit'],
    ['/v1/files?limit=abc', 'limit'],
    ['/v1/files?order=sideways', 'order'],
    ['/v1/files?purpose=unknown', 'purpose'],
    ['/v1/files?after=file-missing', 'after'],
  ])('rejects an invalid list query: %s', async (url, param) => {
    const context = setup();
    const response = await context.app.inject({ method: 'GET', url, headers: authHeaders() });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_request', type: 'invalid_request_error', param },
    });
  });

  it('retrieves metadata and exact content with safe headers', async () => {
    const context = setup();
    const createdResponse = await createFile(context, [
      { name: 'purpose', value: 'user_data' },
      {
        name: 'file',
        value: Buffer.from('exact bytes'),
        filename: '报告 2026.txt',
        contentType: 'text/plain',
      },
    ]);
    const created = createdResponse.json();

    const metadata = await context.app.inject({
      method: 'GET',
      url: `/v1/files/${created.id}`,
      headers: authHeaders(),
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual(created);

    const content = await context.app.inject({
      method: 'GET',
      url: `/v1/files/${created.id}/content`,
      headers: authHeaders(),
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload).toEqual(Buffer.from('exact bytes'));
    expect(content.headers['content-type']).toContain('text/plain');
    expect(content.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%202026.txt",
    );
  });

  it('returns 404 for unknown, private, and deleted Files and removes deleted Files from list', async () => {
    const context = setup();
    const created = (await createFile(context)).json();
    const privateFile = await context.fileService.createPrivateFile({
      filename: 'private.txt',
      source: (async function* () {
        yield Buffer.from('private');
      })(),
    });

    for (const id of ['file-missing', privateFile.id]) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/files/${id}`,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'file_not_found' } });
    }

    const deleted = await context.app.inject({
      method: 'DELETE',
      url: `/v1/files/${created.id}`,
      headers: authHeaders(),
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: created.id, object: 'file', deleted: true });

    for (const suffix of ['', '/content']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/files/${created.id}${suffix}`,
        headers: authHeaders(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'file_not_found' } });
    }

    const list = await context.app.inject({
      method: 'GET',
      url: '/v1/files',
      headers: authHeaders(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ object: 'list', data: [] });
  });
});
