import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../src/runtime.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

interface MultipartPart {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
}

function multipart(parts: MultipartPart[]): { payload: Buffer; contentType: string } {
  const boundary = '----phase6-files-lifecycle-boundary';
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

const pathsToCleanup: TempPersistencePaths[] = [];
const runtimes: GatewayRuntime[] = [];

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()?.close();
  while (pathsToCleanup.length) pathsToCleanup.pop()?.cleanup();
});

async function runtimeFor(paths: TempPersistencePaths): Promise<GatewayRuntime> {
  const config = loadConfig({
    GATEWAY_API_KEY: 'test-key',
    DATA_DIR: join(paths.root, 'data'),
    UI_MODE: 'novnc',
  });
  const runtime = await createGatewayRuntime({
    config,
    migrationsDir: paths.migrationsDir,
    logger: false,
  });
  runtimes.push(runtime);
  return runtime;
}

async function upload(runtime: GatewayRuntime, filename: string) {
  const body = multipart([
    { name: 'purpose', value: 'user_data' },
    {
      name: 'file',
      value: Buffer.from('persistent duplicate bytes'),
      filename,
      contentType: 'text/plain',
    },
  ]);
  return runtime.app.inject({
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

describe('Files API runtime lifecycle', () => {
  it('persists public Files and deduplicated Blob bytes across runtime restart', async () => {
    const paths = createTempPersistencePaths();
    pathsToCleanup.push(paths);
    const first = await runtimeFor(paths);

    const firstUpload = await upload(first, 'first.txt');
    const secondUpload = await upload(first, 'second.txt');
    expect(firstUpload.statusCode).toBe(200);
    expect(secondUpload.statusCode).toBe(200);
    const firstFile = firstUpload.json();
    const secondFile = secondUpload.json();
    expect(firstFile.id).not.toBe(secondFile.id);
    expect(
      first.persistence.database.prepare('SELECT COUNT(*) AS count FROM file_blobs').get(),
    ).toMatchObject({ count: 1 });

    const beforeRestart = await first.app.inject({
      method: 'GET',
      url: `/v1/files/${firstFile.id}/content`,
      headers: authHeaders(),
    });
    expect(beforeRestart.rawPayload).toEqual(Buffer.from('persistent duplicate bytes'));

    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    const second = await runtimeFor(paths);
    expect(
      second.persistence.database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual([
      expect.objectContaining({ version: 1 }),
      expect.objectContaining({ version: 2 }),
      expect.objectContaining({ version: 3 }),
    ]);

    const list = await second.app.inject({
      method: 'GET',
      url: '/v1/files',
      headers: authHeaders(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(2);

    const afterRestart = await second.app.inject({
      method: 'GET',
      url: `/v1/files/${secondFile.id}/content`,
      headers: authHeaders(),
    });
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.rawPayload).toEqual(Buffer.from('persistent duplicate bytes'));

    for (const id of [firstFile.id, secondFile.id]) {
      const deleted = await second.app.inject({
        method: 'DELETE',
        url: `/v1/files/${id}`,
        headers: authHeaders(),
      });
      expect(deleted.statusCode).toBe(200);
      const missing = await second.app.inject({
        method: 'GET',
        url: `/v1/files/${id}`,
        headers: authHeaders(),
      });
      expect(missing.statusCode).toBe(404);
    }
    expect(
      second.persistence.database.prepare('SELECT COUNT(*) AS count FROM file_blobs').get(),
    ).toMatchObject({ count: 0 });
  });
});
