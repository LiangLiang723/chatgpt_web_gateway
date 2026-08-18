import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileService } from '../../src/attachments/file-service.js';
import { AttachmentResolver } from '../../src/attachments/resolver.js';
import { AttachmentStager } from '../../src/attachments/staging.js';
import type { NormalizedAttachment } from '../../src/api/normalized.js';
import { createPersistenceContext, type PersistenceContext } from '../../src/persistence/index.js';
import type { FileBlobRecord, FileRecord } from '../../src/persistence/types.js';
import { createTempPersistencePaths, type TempPersistencePaths } from '../helpers/persistence.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');

interface TestContext {
  paths: TempPersistencePaths;
  persistence: PersistenceContext;
  fileService: FileService;
}

const contexts: TestContext[] = [];

afterEach(async () => {
  while (contexts.length) {
    const context = contexts.pop();
    if (!context) continue;
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
  });
  const context = { paths, persistence, fileService };
  contexts.push(context);
  return context;
}

function bytes(value: Buffer | string): Readable {
  return Readable.from([typeof value === 'string' ? Buffer.from(value) : value]);
}

async function publicFile(
  context: TestContext,
  input: { filename: string; value: Buffer | string; mimeType?: string },
): Promise<FileRecord> {
  return context.fileService.createPublicFile({
    filename: input.filename,
    purpose: 'user_data',
    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    source: bytes(input.value),
  });
}

function resolver(
  context: TestContext,
  overrides: Partial<ConstructorParameters<typeof AttachmentResolver>[0]> = {},
): AttachmentResolver {
  return new AttachmentResolver({
    fileService: context.fileService,
    stager: new AttachmentStager({ dataDir: context.paths.root }),
    remoteFetcher: {
      fetch: async () => ({ contentType: 'image/png', source: bytes(png) }),
    },
    ...overrides,
  });
}

describe('AttachmentResolver sources and leases', () => {
  it('resolves Data URL image and Base64 document into private Files with redacted provenance', async () => {
    const context = setup();
    const attachments: NormalizedAttachment[] = [
      {
        id: 'attachment-1',
        kind: 'image',
        source: { type: 'data_url', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
      },
      {
        id: 'attachment-2',
        kind: 'file',
        source: {
          type: 'base64',
          data: Buffer.from('document').toString('base64'),
          filename: 'notes.txt',
        },
      },
    ];

    const handle = await resolver(context).resolveAll(attachments, { requestId: 'req-1' });

    expect(handle.resolved).toHaveLength(2);
    expect(handle.resolved[0]).toMatchObject({
      localAttachmentId: 'attachment-1',
      kind: 'image',
      filename: 'image.png',
      mimeType: 'image/png',
      source: { type: 'data_url' },
      file: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(handle.resolved[0]!.file).not.toHaveProperty('publicId');
    expect(handle.resolved[1]).toMatchObject({
      localAttachmentId: 'attachment-2',
      kind: 'file',
      filename: 'notes.txt',
      source: { type: 'base64' },
    });
    expect(handle.resolved[1]!.file).not.toHaveProperty('publicId');
    const databaseText = context.persistence.database
      .prepare("SELECT group_concat(source_json, '') AS sources FROM attachments")
      .get() as { sources: string | null };
    expect(databaseText.sources).toBeNull();

    await handle.release();
    expect(
      context.persistence.database.prepare('SELECT COUNT(*) AS count FROM files').get(),
    ).toMatchObject({ count: 0 });
  });

  it('resolves a remote image through the injected safe fetcher and does not retain the signed URL', async () => {
    const context = setup();
    const fetch = vi.fn(async () => ({ contentType: 'image/png', source: bytes(png) }));
    const handle = await resolver(context, { remoteFetcher: { fetch } }).resolveAll(
      [
        {
          id: 'attachment-1',
          kind: 'image',
          source: { type: 'url', url: 'https://example.com/a.png?token=secret' },
        },
      ],
      { requestId: 'req-url' },
    );

    expect(fetch).toHaveBeenCalledWith('https://example.com/a.png?token=secret', {
      signal: undefined,
    });
    expect(handle.resolved[0]).toMatchObject({
      source: { type: 'url' },
      filename: 'image.png',
      mimeType: 'image/png',
    });
    expect(JSON.stringify(handle.resolved)).not.toContain('token=secret');
    await handle.release();
  });

  it('acquires a public file_id lease and sniffs image bytes instead of trusting stored MIME', async () => {
    const context = setup();
    const stored = await publicFile(context, {
      filename: 'cat.bin',
      value: png,
      mimeType: 'text/plain',
    });

    const handle = await resolver(context).resolveAll(
      [
        {
          id: 'attachment-1',
          kind: 'image',
          source: { type: 'file_id', fileId: stored.publicId! },
        },
      ],
      { requestId: 'req-file-id' },
    );

    expect(handle.resolved[0]).toMatchObject({
      file: { id: stored.id },
      filename: 'cat.bin',
      mimeType: 'image/png',
      source: { type: 'file_id' },
    });
    await handle.release();
    expect(context.fileService.getPublicFile(stored.publicId!)).toBeDefined();
  });

  it('rejects missing/deleted file_id and Base64 documents without a safe filename', async () => {
    const context = setup();
    const stored = await publicFile(context, { filename: 'gone.txt', value: 'gone' });
    await context.fileService.deletePublicFile(stored.publicId!);

    for (const attachment of [
      {
        id: 'a1',
        kind: 'file',
        source: { type: 'file_id', fileId: 'file-missing' },
      },
      {
        id: 'a2',
        kind: 'file',
        source: { type: 'file_id', fileId: stored.publicId! },
      },
    ] as NormalizedAttachment[]) {
      await expect(
        resolver(context).resolveAll([attachment], { requestId: 'req-missing' }),
      ).rejects.toMatchObject({ code: 'file_not_found' });
    }

    await expect(
      resolver(context).resolveAll(
        [
          {
            id: 'a3',
            kind: 'file',
            source: { type: 'base64', data: Buffer.from('abc').toString('base64') },
          },
        ],
        { requestId: 'req-no-name' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_attachment' });
  });

  it('rejects more than 16 attachments before resolving any source', async () => {
    const context = setup();
    const fetch = vi.fn(async () => ({ contentType: 'image/png', source: bytes(png) }));
    const attachments: NormalizedAttachment[] = Array.from({ length: 17 }, (_, index) => ({
      id: `attachment-${index + 1}`,
      kind: 'image',
      source: { type: 'url', url: `https://example.com/${index}.png` },
    }));

    await expect(
      resolver(context, { remoteFetcher: { fetch } }).resolveAll(attachments, {
        requestId: 'req-many',
      }),
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects cumulative resolved File metadata above 64 MiB', async () => {
    const context = setup();
    const records: FileRecord[] = [];
    for (let index = 0; index < 3; index += 1) {
      const blob: FileBlobRecord = {
        id: `${index + 1}1111111-1111-4111-8111-111111111111`,
        sha256: String(index + 1).repeat(64),
        sizeBytes: 24 * 1024 * 1024,
        storagePath: join(context.paths.root, 'files', 'blobs', String(index + 1).repeat(64)),
        createdAt: 1000 + index,
      };
      const file: FileRecord = {
        id: `${index + 4}1111111-1111-4111-8111-111111111111`,
        publicId: `file-${index + 7}1111111-1111-4111-8111-111111111111`,
        blobId: blob.id,
        filename: `large-${index}.bin`,
        purpose: 'user_data',
        sizeBytes: blob.sizeBytes,
        sha256: blob.sha256,
        storagePath: blob.storagePath,
        createdAt: 1000 + index,
        updatedAt: 1000 + index,
      };
      context.persistence.fileBlobs.insert(blob);
      context.persistence.files.insert(file);
      records.push(file);
    }

    await expect(
      resolver(context).resolveAll(
        records.map((record, index) => ({
          id: `attachment-${index + 1}`,
          kind: 'file' as const,
          source: { type: 'file_id' as const, fileId: record.publicId! },
        })),
        { requestId: 'req-total' },
      ),
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
  });
});

describe('AttachmentResolver request staging', () => {
  it('creates collision-safe upload filenames and removes the staging tree on release', async () => {
    const context = setup();
    const first = await publicFile(context, { filename: 'notes.txt', value: 'first' });
    const second = await publicFile(context, { filename: 'notes.txt', value: 'second' });
    const handle = await resolver(context).resolveAll(
      [first, second].map((record, index) => ({
        id: `attachment-${index + 1}`,
        kind: 'file' as const,
        source: { type: 'file_id' as const, fileId: record.publicId! },
      })),
      { requestId: 'req-stage' },
    );

    const prepared = await handle.stage(['attachment-1', 'attachment-2']);
    expect(prepared.map((item) => item.uploadFilename)).toEqual(['notes.txt', 'notes (2).txt']);
    expect(await readFile(prepared[0]!.stagingPath, 'utf8')).toBe('first');
    expect(await readFile(prepared[1]!.stagingPath, 'utf8')).toBe('second');

    await handle.release();
    await expect(
      stat(join(context.paths.root, 'temp', 'attachments', 'req-stage')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('falls back from hardlink to copy for unsupported cross-filesystem links', async () => {
    const context = setup();
    const stored = await publicFile(context, { filename: 'copy.txt', value: 'copy-me' });
    const link = vi.fn(async () => {
      const error = new Error('cross-device') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    });
    const stager = new AttachmentStager({ dataDir: context.paths.root, link });
    const handle = await resolver(context, { stager }).resolveAll(
      [
        {
          id: 'attachment-1',
          kind: 'file',
          source: { type: 'file_id', fileId: stored.publicId! },
        },
      ],
      { requestId: 'req-copy' },
    );

    const [prepared] = await handle.stage(['attachment-1']);
    expect(link).toHaveBeenCalledTimes(1);
    expect(await readFile(prepared!.stagingPath, 'utf8')).toBe('copy-me');
    await handle.release();
  });
});
