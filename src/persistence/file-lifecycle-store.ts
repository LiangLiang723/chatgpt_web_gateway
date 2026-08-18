import type { DatabaseSync } from 'node:sqlite';

import { transaction } from './transaction.js';
import type { FileBlobRepository } from './repositories/file-blobs.js';
import type { FileRepository } from './repositories/files.js';
import type { FileBlobRecord, FileRecord } from './types.js';

export interface FileLifecycleStoreRepositories {
  files: FileRepository;
  fileBlobs: FileBlobRepository;
}

export interface DeleteLogicalFileResult {
  deletedFile?: FileRecord;
  deletedBlob?: FileBlobRecord;
}

export class FileLifecycleStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly repositories: FileLifecycleStoreRepositories,
  ) {}

  saveLogicalFile(blob: FileBlobRecord | undefined, file: FileRecord): void {
    transaction(this.database, () => {
      if (blob !== undefined) this.repositories.fileBlobs.insert(blob);
      this.repositories.files.insert(file);
    });
  }

  deleteLogicalFile(fileId: string): DeleteLogicalFileResult {
    let deletedFile: FileRecord | undefined;
    let deletedBlob: FileBlobRecord | undefined;

    transaction(this.database, () => {
      const file = this.repositories.files.getById(fileId);
      if (!file) return;
      deletedFile = file;
      this.repositories.files.deleteById(file.id);

      if (this.repositories.fileBlobs.countReferences(file.blobId) !== 0) return;
      const blob = this.repositories.fileBlobs.getById(file.blobId);
      if (!blob) return;
      this.repositories.fileBlobs.deleteById(blob.id);
      deletedBlob = blob;
    });

    return {
      ...(deletedFile === undefined ? {} : { deletedFile }),
      ...(deletedBlob === undefined ? {} : { deletedBlob }),
    };
  }
}
