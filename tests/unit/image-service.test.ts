import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageGenerationService } from '../../src/images/service.js';
import { ImageStorage } from '../../src/images/storage.js';
import type { GeneratedImageRecord } from '../../src/persistence/types.js';

const roots: string[] = [];
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const records = new Map<string, GeneratedImageRecord>();
  return {
    records,
    insert: vi.fn((record: GeneratedImageRecord) => {
      records.set(record.id, structuredClone(record));
    }),
    getById: vi.fn((imageId: string) => records.get(imageId)),
  };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cwg-image-service-'));
  roots.push(root);
  const storage = new ImageStorage({ dataDir: root });
  await storage.initialize();
  const repo = repository();
  const release = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const pagePool = {
    acquire: vi.fn(async () => ({ page: {} as Page, release, close })),
  };
  const driver = { generate: vi.fn(async () => png) };
  const service = new ImageGenerationService({
    pagePool,
    driver,
    storage,
    repository: repo,
    randomUuid: () => id,
    now: () => 1_787_800_000_000,
  });
  return { root, storage, repo, pagePool, driver, service, release, close };
}

describe('ImageGenerationService', () => {
  it('generates, stores, persists and reopens one image', async () => {
    const context = await setup();
    const result = await context.service.generate({
      prompt: 'cat',
      responseFormat: 'url',
      ignoredParameters: [],
    });

    expect(context.driver.generate).toHaveBeenCalledWith(expect.anything(), 'cat');
    expect(context.release).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
    expect(context.repo.records.get(id)).toMatchObject({
      id,
      prompt: 'cat',
      mimeType: 'image/png',
      sizeBytes: png.length,
    });
    expect(result.bytes).toEqual(png);
    expect((await context.service.read(id)).bytes).toEqual(png);
  });

  it('closes a failed browser page and does not persist an image', async () => {
    const context = await setup();
    context.driver.generate.mockRejectedValueOnce(
      Object.assign(new Error('failed'), { code: 'browser_unavailable' }),
    );

    await expect(
      context.service.generate({ prompt: 'cat', responseFormat: 'url', ignoredParameters: [] }),
    ).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.release).not.toHaveBeenCalled();
    expect(context.repo.records.size).toBe(0);
  });

  it('removes stored bytes when metadata persistence fails', async () => {
    const context = await setup();
    context.repo.insert.mockImplementationOnce(() => {
      throw new Error('db failed');
    });

    await expect(
      context.service.generate({ prompt: 'cat', responseFormat: 'url', ignoredParameters: [] }),
    ).rejects.toMatchObject({ code: 'image_storage_error' });
    await expect(
      context.storage.read(join(context.root, 'generated', `${id}.png`)),
    ).rejects.toMatchObject({
      code: 'image_storage_error',
    });
  });

  it('rejects corrupted stored bytes on read', async () => {
    const context = await setup();
    const result = await context.service.generate({
      prompt: 'cat',
      responseFormat: 'url',
      ignoredParameters: [],
    });
    writeFileSync(
      result.storagePath,
      Buffer.from(png.map((value, index) => (index === 15 ? value ^ 1 : value))),
    );

    await expect(context.service.read(id)).rejects.toMatchObject({ code: 'image_storage_error' });
  });
});
