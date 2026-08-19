import { Readable } from 'node:stream';

import type { AttachmentDescriptor } from './types.js';
import type { AttachmentRecord, AttachmentSourceRecord, FileRecord } from '../persistence/types.js';
import { AttachmentPipelineError } from './errors.js';
import type { FileLease, FileService } from './file-service.js';
import { decodeBase64Strict, parseImageDataUrl, validateImageBytes } from './image.js';
import { RemoteImageFetcher, type RemoteFetchResult } from './network-policy.js';
import {
  isSafeLogicalFilename,
  MAX_ATTACHMENTS_PER_REQUEST,
  MAX_FILE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES_PER_REQUEST,
} from './policy.js';
import {
  AttachmentStager,
  type PreparedAttachment,
  type StagingAttachment,
  type StagingResult,
} from './staging.js';

export type { AttachmentSourceRecord } from '../persistence/types.js';

export interface ResolvedAttachment {
  localAttachmentId: string;
  kind: 'image' | 'file';
  file: FileRecord;
  filename: string;
  mimeType?: string;
  source: AttachmentSourceRecord;
}

export interface ResolvedAttachmentHandle {
  readonly resolved: ResolvedAttachment[];
  stage(
    localAttachmentIds: readonly string[],
    additional?: readonly ResolvedAttachment[],
  ): Promise<PreparedAttachment[]>;
  release(): Promise<void>;
}

export interface RetainedAttachmentHandle {
  readonly resolved: ResolvedAttachment[];
  release(): Promise<void>;
}

export interface RemoteImageFetcherLike {
  fetch(value: string, options?: { signal?: AbortSignal }): Promise<RemoteFetchResult>;
}

export interface AttachmentResolverOptions {
  fileService: FileService;
  stager?: AttachmentStager;
  remoteFetcher?: RemoteImageFetcherLike;
}

export class AttachmentResolver {
  private readonly stager: AttachmentStager;
  private readonly remoteFetcher: RemoteImageFetcherLike;

  constructor(private readonly options: AttachmentResolverOptions) {
    this.stager = options.stager ?? new AttachmentStager({ dataDir: '/data' });
    this.remoteFetcher = options.remoteFetcher ?? new RemoteImageFetcher();
  }

  async retainStored(attachments: readonly AttachmentRecord[]): Promise<RetainedAttachmentHandle> {
    const leases: FileLease[] = [];
    const resolved: ResolvedAttachment[] = [];
    let released = false;

    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      for (const lease of leases.reverse()) await lease.release().catch(() => undefined);
    };

    try {
      for (const attachment of attachments) {
        const lease = this.options.fileService.acquireRetainedFileById(attachment.fileId);
        leases.push(lease);
        ensureNonEmptyFile(lease.file);
        resolved.push({
          localAttachmentId: storedAttachmentReference(attachment.id),
          kind: attachment.kind,
          file: lease.file,
          filename: lease.file.filename,
          ...(lease.file.mimeType === undefined ? {} : { mimeType: lease.file.mimeType }),
          source: attachment.source,
        });
      }
      return { resolved, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async resolveAll(
    attachments: readonly AttachmentDescriptor[],
    request: { requestId: string; signal?: AbortSignal },
  ): Promise<ResolvedAttachmentHandle> {
    if (attachments.length > MAX_ATTACHMENTS_PER_REQUEST) {
      throw new AttachmentPipelineError(
        'attachment_too_large',
        'Request contains too many attachments',
      );
    }

    const resolved: ResolvedAttachment[] = [];
    const leases: FileLease[] = [];
    const privateFileIds: string[] = [];
    let totalBytes = 0;
    let staging: StagingResult | undefined;
    let released = false;

    const cleanup = async (): Promise<void> => {
      if (released) return;
      released = true;
      await staging?.cleanup().catch(() => undefined);
      for (const lease of leases.reverse()) await lease.release().catch(() => undefined);
      for (const fileId of privateFileIds.reverse()) {
        await this.options.fileService.discardPrivateFile(fileId).catch(() => undefined);
      }
    };

    try {
      const seenIds = new Set<string>();
      for (const attachment of attachments) {
        if (seenIds.has(attachment.id)) {
          throw new AttachmentPipelineError(
            'invalid_attachment',
            'Attachment identifiers must be unique',
          );
        }
        seenIds.add(attachment.id);
        throwIfAborted(request.signal);

        const item = await this.resolveOne(attachment, request.signal, leases, privateFileIds);
        totalBytes += item.file.sizeBytes;
        if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES_PER_REQUEST) {
          throw new AttachmentPipelineError(
            'attachment_too_large',
            'Request attachments exceed the Gateway total size limit',
          );
        }
        resolved.push(item);
      }

      return {
        resolved,
        stage: async (localAttachmentIds, additional = []) => {
          if (released) {
            throw new AttachmentPipelineError(
              'invalid_attachment',
              'Attachment handle has already been released',
            );
          }
          if (staging !== undefined) {
            await staging.cleanup();
            staging = undefined;
          }
          const selected = selectForStaging([...resolved, ...additional], localAttachmentIds);
          staging = await this.stager.stage(request.requestId, selected);
          return staging.prepared;
        },
        release: cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private async resolveOne(
    attachment: AttachmentDescriptor,
    signal: AbortSignal | undefined,
    leases: FileLease[],
    privateFileIds: string[],
  ): Promise<ResolvedAttachment> {
    if (attachment.kind === 'image') {
      return this.resolveImage(attachment, signal, leases, privateFileIds);
    }
    return this.resolveFile(attachment, leases, privateFileIds);
  }

  private async resolveImage(
    attachment: Extract<AttachmentDescriptor, { kind: 'image' }>,
    signal: AbortSignal | undefined,
    leases: FileLease[],
    privateFileIds: string[],
  ): Promise<ResolvedAttachment> {
    if (attachment.source.type === 'file_id') {
      const lease = this.options.fileService.acquirePublicFile(attachment.source.fileId);
      leases.push(lease);
      ensureNonEmptyFile(lease.file);
      const prefix = await this.options.fileService.readFilePrefix(lease.file, 12);
      const detected = validateImageBytes(prefix);
      return {
        localAttachmentId: attachment.id,
        kind: 'image',
        file: lease.file,
        filename: lease.file.filename,
        mimeType: detected.mimeType,
        source: { type: 'file_id' },
      };
    }

    if (attachment.source.type === 'data_url') {
      const parsed = parseImageDataUrl(attachment.source.dataUrl);
      const file = await this.options.fileService.createPrivateFile({
        filename: parsed.filename,
        mimeType: parsed.mimeType,
        source: Readable.from([parsed.bytes]),
      });
      privateFileIds.push(file.id);
      const lease = this.options.fileService.acquireFileById(file.id);
      leases.push(lease);
      return {
        localAttachmentId: attachment.id,
        kind: 'image',
        file: lease.file,
        filename: parsed.filename,
        mimeType: parsed.mimeType,
        source: { type: 'data_url' },
      };
    }

    const remote = await this.remoteFetcher.fetch(attachment.source.url, { signal });
    const inspected = await inspectRemoteImageSource(remote);
    const filename = `image.${inspected.extension}`;
    const file = await this.options.fileService.createPrivateFile({
      filename,
      mimeType: inspected.mimeType,
      source: inspected.source,
    });
    privateFileIds.push(file.id);
    const lease = this.options.fileService.acquireFileById(file.id);
    leases.push(lease);
    return {
      localAttachmentId: attachment.id,
      kind: 'image',
      file: lease.file,
      filename,
      mimeType: inspected.mimeType,
      source: { type: 'url' },
    };
  }

  private async resolveFile(
    attachment: Extract<AttachmentDescriptor, { kind: 'file' }>,
    leases: FileLease[],
    privateFileIds: string[],
  ): Promise<ResolvedAttachment> {
    if (attachment.source.type === 'file_id') {
      const lease = this.options.fileService.acquirePublicFile(attachment.source.fileId);
      leases.push(lease);
      ensureNonEmptyFile(lease.file);
      if (!isSafeLogicalFilename(lease.file.filename)) {
        throw new AttachmentPipelineError('invalid_attachment', 'Attachment filename is invalid');
      }
      return {
        localAttachmentId: attachment.id,
        kind: 'file',
        file: lease.file,
        filename: lease.file.filename,
        ...(lease.file.mimeType === undefined ? {} : { mimeType: lease.file.mimeType }),
        source: { type: 'file_id' },
      };
    }

    const filename = attachment.source.filename;
    if (filename === undefined || !isSafeLogicalFilename(filename)) {
      throw new AttachmentPipelineError(
        'invalid_attachment',
        'Base64 file attachment requires a safe filename',
      );
    }
    const decoded = decodeBase64Strict(attachment.source.data);
    if (decoded.byteLength === 0) {
      throw new AttachmentPipelineError('invalid_attachment', 'Attachment bytes must be non-empty');
    }
    const file = await this.options.fileService.createPrivateFile({
      filename,
      source: Readable.from([decoded]),
    });
    privateFileIds.push(file.id);
    const lease = this.options.fileService.acquireFileById(file.id);
    leases.push(lease);
    return {
      localAttachmentId: attachment.id,
      kind: 'file',
      file: lease.file,
      filename,
      source: { type: 'base64' },
    };
  }
}

interface InspectedRemoteImage {
  mimeType: string;
  extension: 'png' | 'jpg' | 'webp' | 'gif';
  source: AsyncIterable<Uint8Array>;
}

async function inspectRemoteImageSource(remote: RemoteFetchResult): Promise<InspectedRemoteImage> {
  const iterator = remote.source[Symbol.asyncIterator]();
  const buffered: Uint8Array[] = [];
  const prefixParts: Buffer[] = [];
  let prefixBytes = 0;

  try {
    while (prefixBytes < 12) {
      const next = await iterator.next();
      if (next.done) break;
      const bytes = Buffer.from(next.value);
      buffered.push(bytes);
      if (prefixBytes < 12) {
        const needed = 12 - prefixBytes;
        const part = bytes.subarray(0, needed);
        prefixParts.push(part);
        prefixBytes += part.byteLength;
      }
    }
    const detected = validateImageBytes(Buffer.concat(prefixParts), remote.contentType);
    return {
      mimeType: detected.mimeType,
      extension: detected.extension,
      source: replaySource(buffered, iterator),
    };
  } catch (error) {
    await iterator.return?.().catch(() => undefined);
    throw error;
  }
}

async function* replaySource(
  buffered: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  try {
    for (const chunk of buffered) yield chunk;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

export function storedAttachmentReference(attachmentRecordId: string): string {
  return `stored:${attachmentRecordId}`;
}

function selectForStaging(
  resolved: readonly ResolvedAttachment[],
  localAttachmentIds: readonly string[],
): StagingAttachment[] {
  const byId = new Map(resolved.map((item) => [item.localAttachmentId, item]));
  const seen = new Set<string>();
  return localAttachmentIds.map((id) => {
    if (seen.has(id)) {
      throw new AttachmentPipelineError('invalid_attachment', 'Duplicate attachment staging id');
    }
    seen.add(id);
    const item = byId.get(id);
    if (!item) {
      throw new AttachmentPipelineError('invalid_attachment', 'Unknown attachment staging id');
    }
    return {
      localAttachmentId: item.localAttachmentId,
      kind: item.kind,
      file: item.file,
      filename: item.filename,
      ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
    };
  });
}

function ensureNonEmptyFile(file: FileRecord): void {
  if (file.sizeBytes < 1 || file.sizeBytes > MAX_FILE_BYTES) {
    throw new AttachmentPipelineError('invalid_attachment', 'Attachment File size is invalid');
  }
  if (!isSafeLogicalFilename(file.filename)) {
    throw new AttachmentPipelineError('invalid_attachment', 'Attachment filename is invalid');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
