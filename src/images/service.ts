import { createHash, randomUUID as defaultRandomUuid } from 'node:crypto';

import type { PagePool } from '../browser/types.js';
import type { ChatGptImageDriver } from '../chatgpt/image-driver.js';
import type { GeneratedImageRepository } from '../persistence/repositories/generated-images.js';
import type { GeneratedImageRecord } from '../persistence/types.js';
import { ImageGenerationError } from './errors.js';
import { ImageStorage } from './storage.js';
import type { GeneratedImageResult, NormalizedImageGenerationRequest } from './types.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GeneratedImageContent {
  record: GeneratedImageRecord;
  bytes: Buffer;
}

export interface ImageGenerationServiceLike {
  generate(request: NormalizedImageGenerationRequest): Promise<GeneratedImageResult>;
  read(id: string): Promise<GeneratedImageContent>;
}

export interface CreateImageGenerationServiceOptions {
  pagePool?: Pick<PagePool, 'acquire'>;
  driver?: ChatGptImageDriver;
  storage: ImageStorage;
  repository: Pick<GeneratedImageRepository, 'insert' | 'getById'>;
  now?: () => number;
  randomUuid?: () => string;
}

export class ImageGenerationService implements ImageGenerationServiceLike {
  private readonly pagePool?: Pick<PagePool, 'acquire'>;
  private readonly driver?: ChatGptImageDriver;
  private readonly storage: ImageStorage;
  private readonly repository: Pick<GeneratedImageRepository, 'insert' | 'getById'>;
  private readonly now: () => number;
  private readonly randomUuid: () => string;

  constructor(options: CreateImageGenerationServiceOptions) {
    this.pagePool = options.pagePool;
    this.driver = options.driver;
    this.storage = options.storage;
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.randomUuid = options.randomUuid ?? defaultRandomUuid;
  }

  async generate(request: NormalizedImageGenerationRequest): Promise<GeneratedImageResult> {
    if (!this.pagePool || !this.driver) {
      throw new ImageGenerationError(
        'browser_maintenance_mode',
        'ChatGPT image generation is unavailable during maintenance mode',
      );
    }

    const lease = await this.pagePool.acquire();
    let pageReusable = false;
    try {
      const bytes = await this.driver.generate(lease.page, request.prompt);
      pageReusable = true;
      const id = this.randomUuid();
      const createdAt = this.now();
      const stored = await this.storage.write(id, bytes);
      const record: GeneratedImageRecord = {
        id,
        prompt: request.prompt,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storagePath: stored.storagePath,
        createdAt,
      };

      try {
        this.repository.insert(record);
      } catch (error) {
        await this.storage.remove(stored.storagePath);
        throw new ImageGenerationError(
          'image_storage_error',
          'Generated image metadata could not be persisted',
          undefined,
          { cause: error },
        );
      }

      return { ...record, mimeType: stored.mimeType, bytes };
    } finally {
      if (pageReusable) await lease.release();
      else await lease.close();
    }
  }

  async read(id: string): Promise<GeneratedImageContent> {
    if (!UUID_V4.test(id)) {
      throw new ImageGenerationError('image_not_found', 'Generated image was not found');
    }
    const record = this.repository.getById(id);
    if (!record) throw new ImageGenerationError('image_not_found', 'Generated image was not found');

    const bytes = await this.storage.read(record.storagePath, record.sizeBytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== record.sha256) {
      throw new ImageGenerationError(
        'image_storage_error',
        'Stored generated image failed integrity verification',
      );
    }
    return { record, bytes };
  }
}
