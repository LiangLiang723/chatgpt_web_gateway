import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ImageStorage } from '../../src/images/storage.js';

const roots: string[] = [];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ImageStorage', () => {
  it('sniffs bytes, writes an atomic generated file and can reopen it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cwg-image-storage-'));
    roots.push(root);
    const storage = new ImageStorage({ dataDir: root });
    await storage.initialize();

    const stored = await storage.write('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', png);
    expect(stored).toMatchObject({
      mimeType: 'image/png',
      sizeBytes: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    expect(stored.storagePath).toBe(
      join(root, 'generated', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png'),
    );
    expect(readFileSync(stored.storagePath)).toEqual(png);
    expect(await storage.read(stored.storagePath, png.length)).toEqual(png);
  });

  it('rejects non-image bytes without leaving a committed generated file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cwg-image-storage-bad-'));
    roots.push(root);
    const storage = new ImageStorage({ dataDir: root });
    await storage.initialize();

    await expect(
      storage.write('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', Buffer.from('not an image')),
    ).rejects.toMatchObject({ code: 'image_storage_error' });
  });
});
