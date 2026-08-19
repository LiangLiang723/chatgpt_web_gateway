import { randomUUID as defaultRandomUuid } from 'node:crypto';
import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { FileLifecycleStore } from '../persistence/file-lifecycle-store.js';
import type { AttachmentRepository } from '../persistence/repositories/attachments.js';
import type { FileBlobRepository } from '../persistence/repositories/file-blobs.js';
import type { FileRepository } from '../persistence/repositories/files.js';
import type { FileBlobRecord, FileRecord } from '../persistence/types.js';
import { AttachmentPipelineError } from './errors.js';
import { MAX_FILE_BYTES, type FilePurpose } from './policy.js';

export interface CreateStoredFileInput {
  filename: string;
  mimeType?: string;
  source: AsyncIterable<Uint8Array>;
}

export interface CreatePublicFileInput extends CreateStoredFileInput {
  purpose: FilePurpose;
}

export interface FileLease {
  readonly file: FileRecord;
  release(): Promise<void>;
}

export interface ListPublicFilesInput {
  after?: string;
  limit: number;
  order: 'asc' | 'desc';
  purpose?: FilePurpose;
}

export interface PublicFilePage {
  files: FileRecord[];
  hasMore: boolean;
}

export interface PublicFileContent {
  file: FileRecord;
  stream: ReturnType<typeof createReadStream>;
}

export interface FileServiceOptions {
  dataDir: string;
  attachments: AttachmentRepository;
  files: FileRepository;
  fileBlobs: FileBlobRepository;
  fileLifecycleStore: FileLifecycleStore;
  now?: () => number;
  randomUuid?: () => string;
}

interface WrittenTempFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export class FileService {
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly tempDir: string;
  private readonly blobDir: string;
  private readonly leaseCounts = new Map<string, number>();
  private readonly hashLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: FileServiceOptions) {
    this.now = options.now ?? Date.now;
    this.randomUuid = options.randomUuid ?? defaultRandomUuid;
    this.tempDir = join(options.dataDir, 'temp');
    this.blobDir = join(options.dataDir, 'files', 'blobs');
  }

  async createPublicFile(input: CreatePublicFileInput): Promise<FileRecord> {
    return this.createLogicalFile({ ...input, public: true });
  }

  async createPrivateFile(input: CreateStoredFileInput): Promise<FileRecord> {
    return this.createLogicalFile({ ...input, public: false });
  }

  promotePrivateFile(id: string, purpose: FilePurpose): FileRecord {
    const publicId = `file-${this.randomUuid()}`;
    const updatedAt = this.now();
    this.options.files.promotePrivate(id, publicId, purpose, updatedAt);
    const file = this.options.files.getById(id);
    if (!file) {
      throw new AttachmentPipelineError('file_storage_error', 'File metadata became unavailable');
    }
    return file;
  }

  async discardPrivateFile(id: string): Promise<void> {
    const file = this.options.files.getById(id);
    if (!file || file.publicId !== undefined) return;
    if ((this.leaseCounts.get(id) ?? 0) > 0) return;
    if (this.options.attachments.countByFileId(id) > 0) return;
    const deleted = this.options.fileLifecycleStore.deleteLogicalFile(id);
    if (deleted.deletedBlob) await rm(deleted.deletedBlob.storagePath, { force: true });
  }

  async readFilePrefix(file: FileRecord, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new AttachmentPipelineError('file_storage_error', 'File read limit is invalid');
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file.storagePath, 'r');
      const length = Math.min(maxBytes, file.sizeBytes);
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, result.bytesRead);
    } catch (error) {
      if (error instanceof AttachmentPipelineError) throw error;
      throw new AttachmentPipelineError('file_storage_error', 'Stored File bytes are unavailable', {
        cause: error,
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  getPublicFile(publicId: string): FileRecord | undefined {
    return this.options.files.getByPublicId(publicId);
  }

  listPublicFiles(input: ListPublicFilesInput): PublicFilePage | undefined {
    const after =
      input.after === undefined ? undefined : this.options.files.getByPublicId(input.after);
    if (input.after !== undefined && after === undefined) return undefined;
    const records = this.options.files.listPublic({
      limit: input.limit + 1,
      order: input.order,
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      ...(after === undefined ? {} : { after }),
    });
    return {
      files: records.slice(0, input.limit),
      hasMore: records.length > input.limit,
    };
  }

  async openPublicContent(publicId: string): Promise<PublicFileContent> {
    const file = this.options.files.getByPublicId(publicId);
    if (!file) throw new AttachmentPipelineError('file_not_found', 'File resource was not found');
    try {
      const metadata = await stat(file.storagePath);
      if (!metadata.isFile() || metadata.size !== file.sizeBytes) {
        throw new AttachmentPipelineError(
          'file_storage_error',
          'Stored File bytes are unavailable',
        );
      }
      return { file, stream: createReadStream(file.storagePath) };
    } catch (error) {
      if (error instanceof AttachmentPipelineError) throw error;
      throw new AttachmentPipelineError('file_storage_error', 'Stored File bytes are unavailable', {
        cause: error,
      });
    }
  }

  acquirePublicFile(publicId: string): FileLease {
    const file = this.options.files.getByPublicId(publicId);
    if (!file) {
      throw new AttachmentPipelineError('file_not_found', 'File resource was not found');
    }
    return this.acquireFile(file);
  }

  acquireFileById(id: string): FileLease {
    const file = this.options.files.getById(id);
    if (!file || file.deletedAt !== undefined) {
      throw new AttachmentPipelineError('file_not_found', 'File resource was not found');
    }
    return this.acquireFile(file);
  }

  acquireRetainedFileById(id: string): FileLease {
    const file = this.options.files.getById(id);
    if (!file) {
      throw new AttachmentPipelineError(
        'file_storage_error',
        'Retained attachment File is missing',
      );
    }
    return this.acquireFile(file);
  }

  async deletePublicFile(publicId: string): Promise<FileRecord> {
    const file = this.options.files.getByPublicId(publicId);
    if (!file) {
      throw new AttachmentPipelineError('file_not_found', 'File resource was not found');
    }
    const deletedAt = this.now();
    this.options.files.markDeleted(file.id, deletedAt);
    const tombstoned = this.options.files.getById(file.id);
    if (!tombstoned) {
      throw new AttachmentPipelineError('file_storage_error', 'File metadata became unavailable');
    }
    await this.maybeCleanupFile(file.id);
    return tombstoned;
  }

  async cleanup(): Promise<void> {
    try {
      await mkdir(this.tempDir, { recursive: true });
      await mkdir(this.blobDir, { recursive: true });

      for (const entry of await readdir(this.tempDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.part')) {
          await rm(join(this.tempDir, entry.name), { force: true });
        }
      }

      for (const file of this.options.files.listTombstoned()) {
        await this.maybeCleanupFile(file.id);
      }

      for (const blob of this.options.fileBlobs.listAll()) {
        if (this.options.fileBlobs.countReferences(blob.id) !== 0) continue;
        this.options.fileBlobs.deleteById(blob.id);
        await rm(blob.storagePath, { force: true });
      }

      const referencedPaths = new Set(
        this.options.fileBlobs.listAll().map((blob) => blob.storagePath),
      );
      for (const entry of await readdir(this.blobDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(this.blobDir, entry.name);
        if (!referencedPaths.has(path)) await rm(path, { force: true });
      }
    } catch (error) {
      if (error instanceof AttachmentPipelineError) throw error;
      throw new AttachmentPipelineError('file_storage_error', 'File cleanup failed', {
        cause: error,
      });
    }
  }

  private acquireFile(file: FileRecord): FileLease {
    this.leaseCounts.set(file.id, (this.leaseCounts.get(file.id) ?? 0) + 1);
    let released = false;
    return {
      file,
      release: async () => {
        if (released) return;
        released = true;
        const remaining = Math.max(0, (this.leaseCounts.get(file.id) ?? 1) - 1);
        if (remaining === 0) this.leaseCounts.delete(file.id);
        else this.leaseCounts.set(file.id, remaining);
        await this.maybeCleanupFile(file.id);
      },
    };
  }

  private async createLogicalFile(
    input: CreateStoredFileInput & { public: boolean; purpose?: FilePurpose },
  ): Promise<FileRecord> {
    let written: WrittenTempFile | undefined;
    try {
      written = await this.writeTemp(input.source);
      return await this.withHashLock(written.sha256, async () => {
        const existingBlob = this.options.fileBlobs.getBySha256(written!.sha256);
        if (existingBlob && existingBlob.sizeBytes !== written!.sizeBytes) {
          throw new AttachmentPipelineError(
            'file_storage_error',
            'Stored Blob metadata is inconsistent',
          );
        }

        const createdAt = this.now();
        let blob: FileBlobRecord;
        let insertBlob = false;
        let adoptedPath: string | undefined;

        if (existingBlob) {
          blob = existingBlob;
        } else {
          await mkdir(this.blobDir, { recursive: true });
          const storagePath = join(this.blobDir, written!.sha256);
          try {
            await copyFile(written!.path, storagePath, fsConstants.COPYFILE_EXCL);
            adoptedPath = storagePath;
          } catch (error) {
            if (!isNodeError(error, 'EEXIST')) throw error;
            const existingStat = await stat(storagePath);
            if (existingStat.size !== written!.sizeBytes) {
              throw new AttachmentPipelineError(
                'file_storage_error',
                'Stored Blob bytes are inconsistent',
              );
            }
          }
          blob = {
            id: this.randomUuid(),
            sha256: written!.sha256,
            sizeBytes: written!.sizeBytes,
            storagePath,
            createdAt,
          };
          insertBlob = true;
        }

        const file: FileRecord = {
          id: this.randomUuid(),
          ...(input.public ? { publicId: `file-${this.randomUuid()}` } : {}),
          blobId: blob.id,
          filename: input.filename,
          ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
          sizeBytes: blob.sizeBytes,
          sha256: blob.sha256,
          storagePath: blob.storagePath,
          createdAt,
          updatedAt: createdAt,
        };

        try {
          this.options.fileLifecycleStore.saveLogicalFile(insertBlob ? blob : undefined, file);
        } catch (error) {
          if (adoptedPath && !this.options.fileBlobs.getBySha256(blob.sha256)) {
            await rm(adoptedPath, { force: true });
          }
          throw error;
        }

        return file;
      });
    } catch (error) {
      if (error instanceof AttachmentPipelineError) throw error;
      throw new AttachmentPipelineError('file_storage_error', 'File storage failed', {
        cause: error,
      });
    } finally {
      if (written) await rm(written.path, { force: true }).catch(() => undefined);
    }
  }

  private async writeTemp(source: AsyncIterable<Uint8Array>): Promise<WrittenTempFile> {
    await mkdir(this.tempDir, { recursive: true });
    const path = join(this.tempDir, `${this.randomUuid()}.part`);
    const handle = await open(path, 'wx');
    const hash = createHash('sha256');
    let sizeBytes = 0;
    let completed = false;

    try {
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk);
        sizeBytes += bytes.byteLength;
        if (sizeBytes > MAX_FILE_BYTES) {
          throw new AttachmentPipelineError(
            'file_too_large',
            `File exceeds the ${MAX_FILE_BYTES} byte Gateway limit`,
          );
        }
        hash.update(bytes);
        await handle.write(bytes);
      }
      await handle.sync();
      completed = true;
      return { path, sizeBytes, sha256: hash.digest('hex') };
    } finally {
      await handle.close();
      if (!completed) await rm(path, { force: true }).catch(() => undefined);
    }
  }

  private async maybeCleanupFile(fileId: string): Promise<void> {
    const file = this.options.files.getById(fileId);
    if (!file || file.deletedAt === undefined) return;
    if ((this.leaseCounts.get(fileId) ?? 0) > 0) return;
    if (this.attachmentReferenceCount(fileId) > 0) return;

    const deleted = this.options.fileLifecycleStore.deleteLogicalFile(fileId);
    if (deleted.deletedBlob) await rm(deleted.deletedBlob.storagePath, { force: true });
  }

  private attachmentReferenceCount(fileId: string): number {
    return this.options.attachments.countByFileId(fileId);
  }

  private async withHashLock<T>(sha256: string, run: () => Promise<T>): Promise<T> {
    const previous = this.hashLocks.get(sha256) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduled = previous.then(() => gate);
    this.hashLocks.set(sha256, scheduled);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.hashLocks.get(sha256) === scheduled) this.hashLocks.delete(sha256);
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
