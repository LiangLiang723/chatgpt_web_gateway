import type { DatabaseSync } from 'node:sqlite';

import { assertUuidV4, type FileBlobRecord } from '../types.js';

interface FileBlobRow {
  id: string;
  sha256: string;
  size_bytes: number;
  storage_path: string;
  created_at: number;
}

function mapRow(row: FileBlobRow | undefined): FileBlobRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

export class FileBlobRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(record: FileBlobRecord): void {
    assertUuidV4(record.id, 'File Blob id');
    this.database
      .prepare(
        `INSERT INTO file_blobs (id, sha256, size_bytes, storage_path, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.sha256, record.sizeBytes, record.storagePath, record.createdAt);
  }

  getById(id: string): FileBlobRecord | undefined {
    assertUuidV4(id, 'File Blob id');
    return mapRow(
      this.database.prepare('SELECT * FROM file_blobs WHERE id = ?').get(id) as
        FileBlobRow | undefined,
    );
  }

  getBySha256(sha256: string): FileBlobRecord | undefined {
    return mapRow(
      this.database.prepare('SELECT * FROM file_blobs WHERE sha256 = ?').get(sha256) as
        FileBlobRow | undefined,
    );
  }

  listAll(): FileBlobRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM file_blobs ORDER BY created_at ASC, id ASC')
        .all() as unknown as FileBlobRow[]
    ).map((row) => mapRow(row) as FileBlobRecord);
  }

  countReferences(id: string): number {
    assertUuidV4(id, 'File Blob id');
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM files WHERE blob_id = ?')
      .get(id) as { count: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  deleteById(id: string): void {
    assertUuidV4(id, 'File Blob id');
    this.database.prepare('DELETE FROM file_blobs WHERE id = ?').run(id);
  }
}
