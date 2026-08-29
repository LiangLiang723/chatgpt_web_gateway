import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateImageBytes } from '../attachments/image.js';
import { ImageGenerationError } from './errors.js';

export interface StoredGeneratedImage {
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
}

export class ImageStorage {
  private readonly generatedDir: string;

  constructor(options: { dataDir: string }) {
    this.generatedDir = join(options.dataDir, 'generated');
  }

  async initialize(): Promise<void> {
    try {
      await mkdir(this.generatedDir, { recursive: true });
    } catch (error) {
      throw new ImageGenerationError(
        'image_storage_error',
        'Generated image directory is unavailable',
        undefined,
        {
          cause: error,
        },
      );
    }
  }

  async write(id: string, bytes: Buffer): Promise<StoredGeneratedImage> {
    let info;
    try {
      info = validateImageBytes(bytes);
    } catch (error) {
      throw new ImageGenerationError(
        'image_storage_error',
        'Generated image bytes are invalid',
        undefined,
        {
          cause: error,
        },
      );
    }

    const storagePath = join(this.generatedDir, `${id}.${info.extension}`);
    const temporaryPath = `${storagePath}.part`;
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx' });
      await rename(temporaryPath, storagePath);
      return {
        mimeType: info.mimeType,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        storagePath,
      };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await rm(storagePath, { force: true }).catch(() => undefined);
      throw new ImageGenerationError(
        'image_storage_error',
        'Generated image storage failed',
        undefined,
        {
          cause: error,
        },
      );
    }
  }

  async read(storagePath: string, expectedSize?: number): Promise<Buffer> {
    try {
      const metadata = await stat(storagePath);
      if (!metadata.isFile() || (expectedSize !== undefined && metadata.size !== expectedSize)) {
        throw new Error('Generated image metadata mismatch');
      }
      return await readFile(storagePath);
    } catch (error) {
      throw new ImageGenerationError(
        'image_storage_error',
        'Stored generated image is unavailable',
        undefined,
        {
          cause: error,
        },
      );
    }
  }

  async remove(storagePath: string): Promise<void> {
    await rm(storagePath, { force: true }).catch(() => undefined);
  }

  openStream(storagePath: string): ReturnType<typeof createReadStream> {
    return createReadStream(storagePath);
  }
}
