import type { DatabaseSync } from 'node:sqlite';

import { assertUuidV4, type FileRecord } from '../types.js';

interface FileRow {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  created_at: number;
  updated_at: number;
}

function mapRow(row: FileRow | undefined): FileRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FileRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(record: FileRecord): void {
    assertUuidV4(record.id, 'File id');
    this.database
      .prepare(
        `INSERT INTO files
         (id, filename, mime_type, size_bytes, sha256, storage_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.filename,
        record.mimeType ?? null,
        record.sizeBytes,
        record.sha256,
        record.storagePath,
        record.createdAt,
        record.updatedAt,
      );
  }

  getById(id: string): FileRecord | undefined {
    assertUuidV4(id, 'File id');
    return mapRow(
      this.database.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined,
    );
  }

  findBySha256(sha256: string): FileRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM files WHERE sha256 = ? ORDER BY created_at ASC, id ASC')
        .all(sha256) as unknown as FileRow[]
    ).map((row) => mapRow(row) as FileRecord);
  }
}
