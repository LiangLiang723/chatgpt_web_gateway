import type { FileRecord } from '../persistence/types.js';

export interface OpenAIFileObject {
  id: string;
  object: 'file';
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
}

export interface OpenAIFileList {
  object: 'list';
  data: OpenAIFileObject[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
}

export interface OpenAIFileDeleteObject {
  id: string;
  object: 'file';
  deleted: true;
}

export function encodePublicFile(record: FileRecord): OpenAIFileObject {
  if (!record.publicId || !record.purpose) {
    throw new Error('Public File projection is missing public metadata');
  }
  return {
    id: record.publicId,
    object: 'file',
    bytes: record.sizeBytes,
    created_at: Math.floor(record.createdAt / 1000),
    filename: record.filename,
    purpose: record.purpose,
  };
}

export function encodePublicFileList(records: FileRecord[], hasMore: boolean): OpenAIFileList {
  const data = records.map(encodePublicFile);
  return {
    object: 'list',
    data,
    first_id: data.at(0)?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: hasMore,
  };
}

export function encodeDeletedFile(record: FileRecord): OpenAIFileDeleteObject {
  if (!record.publicId) throw new Error('Deleted public File is missing public id');
  return { id: record.publicId, object: 'file', deleted: true };
}

export function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
