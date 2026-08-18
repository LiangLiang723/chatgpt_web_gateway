import { copyFile as defaultCopyFile, link as defaultLink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { FileRecord } from '../persistence/types.js';
import { AttachmentPipelineError } from './errors.js';
import { isSafeLogicalFilename } from './policy.js';

export interface StagingAttachment {
  localAttachmentId: string;
  kind: 'image' | 'file';
  file: FileRecord;
  filename: string;
  mimeType?: string;
}

export interface PreparedAttachment {
  localAttachmentId: string;
  kind: 'image' | 'file';
  fileId: string;
  sha256: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  stagingPath: string;
  uploadFilename: string;
}

export interface StagingResult {
  prepared: PreparedAttachment[];
  cleanup(): Promise<void>;
}

export interface AttachmentStagerOptions {
  dataDir: string;
  link?: typeof defaultLink;
  copyFile?: typeof defaultCopyFile;
}

export class AttachmentStager {
  private readonly link: typeof defaultLink;
  private readonly copyFile: typeof defaultCopyFile;

  constructor(private readonly options: AttachmentStagerOptions) {
    this.link = options.link ?? defaultLink;
    this.copyFile = options.copyFile ?? defaultCopyFile;
  }

  async stage(
    requestId: string,
    attachments: readonly StagingAttachment[],
  ): Promise<StagingResult> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
      throw new AttachmentPipelineError('invalid_attachment', 'Attachment request id is invalid');
    }

    const root = join(this.options.dataDir, 'temp', 'attachments', requestId);
    const seenNames = new Map<string, number>();
    const prepared: PreparedAttachment[] = [];
    let completed = false;

    try {
      await mkdir(root, { recursive: true });
      for (const [index, attachment] of attachments.entries()) {
        if (!isSafeLogicalFilename(attachment.filename)) {
          throw new AttachmentPipelineError('invalid_attachment', 'Attachment filename is invalid');
        }
        const uploadFilename = collisionSafeFilename(attachment.filename, seenNames);
        const directory = join(root, String(index + 1));
        const stagingPath = join(directory, uploadFilename);
        await mkdir(directory, { recursive: true });
        await this.linkOrCopy(attachment.file.storagePath, stagingPath);
        prepared.push({
          localAttachmentId: attachment.localAttachmentId,
          kind: attachment.kind,
          fileId: attachment.file.id,
          sha256: attachment.file.sha256,
          filename: attachment.filename,
          ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
          sizeBytes: attachment.file.sizeBytes,
          stagingPath,
          uploadFilename,
        });
      }
      completed = true;
      return {
        prepared,
        cleanup: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (!completed) await rm(root, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AttachmentPipelineError) throw error;
      throw new AttachmentPipelineError('file_storage_error', 'Attachment staging failed', {
        cause: error,
      });
    }
  }

  private async linkOrCopy(source: string, destination: string): Promise<void> {
    try {
      await this.link(source, destination);
    } catch (error) {
      if (!isLinkFallbackError(error)) throw error;
      await this.copyFile(source, destination);
    }
  }
}

function collisionSafeFilename(filename: string, seenNames: Map<string, number>): string {
  const count = (seenNames.get(filename) ?? 0) + 1;
  seenNames.set(filename, count);
  if (count === 1) return filename;

  const dot = filename.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < filename.length - 1;
  const stem = hasExtension ? filename.slice(0, dot) : filename;
  const extension = hasExtension ? filename.slice(dot) : '';
  return `${stem} (${count})${extension}`;
}

function isLinkFallbackError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(
    String((error as { code?: unknown }).code),
  );
}
