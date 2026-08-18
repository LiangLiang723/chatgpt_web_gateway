import type { DatabaseSync } from 'node:sqlite';

import { assertUuidV4, type FileRecord } from '../types.js';

interface FileProjectionRow {
  id: string;
  public_id: string | null;
  blob_id: string;
  filename: string;
  mime_type: string | null;
  purpose: string | null;
  deleted_at: number | null;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  created_at: number;
  updated_at: number;
}

const FILE_PROJECTION = `
  SELECT
    f.id,
    f.public_id,
    f.blob_id,
    f.filename,
    f.mime_type,
    f.purpose,
    f.deleted_at,
    b.size_bytes,
    b.sha256,
    b.storage_path,
    f.created_at,
    f.updated_at
  FROM files AS f
  JOIN file_blobs AS b ON b.id = f.blob_id
`;

function mapRow(row: FileProjectionRow | undefined): FileRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    ...(row.public_id === null ? {} : { publicId: row.public_id }),
    blobId: row.blob_id,
    filename: row.filename,
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    ...(row.purpose === null ? {} : { purpose: row.purpose }),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
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
    assertUuidV4(record.blobId, 'File Blob id');
    this.database
      .prepare(
        `INSERT INTO files
         (id, public_id, blob_id, filename, mime_type, purpose, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.publicId ?? null,
        record.blobId,
        record.filename,
        record.mimeType ?? null,
        record.purpose ?? null,
        record.deletedAt ?? null,
        record.createdAt,
        record.updatedAt,
      );
  }

  getById(id: string): FileRecord | undefined {
    assertUuidV4(id, 'File id');
    return mapRow(
      this.database.prepare(`${FILE_PROJECTION} WHERE f.id = ?`).get(id) as
        FileProjectionRow | undefined,
    );
  }

  getByPublicId(publicId: string): FileRecord | undefined {
    return mapRow(
      this.database
        .prepare(`${FILE_PROJECTION} WHERE f.public_id = ? AND f.deleted_at IS NULL`)
        .get(publicId) as FileProjectionRow | undefined,
    );
  }

  findBySha256(sha256: string): FileRecord[] {
    return (
      this.database
        .prepare(`${FILE_PROJECTION} WHERE b.sha256 = ? ORDER BY f.created_at ASC, f.id ASC`)
        .all(sha256) as unknown as FileProjectionRow[]
    ).map((row) => mapRow(row) as FileRecord);
  }

  listTombstoned(): FileRecord[] {
    return (
      this.database
        .prepare(`${FILE_PROJECTION} WHERE f.deleted_at IS NOT NULL ORDER BY f.id ASC`)
        .all() as unknown as FileProjectionRow[]
    ).map((row) => mapRow(row) as FileRecord);
  }

  countByBlobId(blobId: string): number {
    assertUuidV4(blobId, 'File Blob id');
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM files WHERE blob_id = ?')
      .get(blobId) as { count: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  markDeleted(id: string, deletedAt: number): void {
    assertUuidV4(id, 'File id');
    this.database
      .prepare('UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(deletedAt, deletedAt, id);
  }

  deleteById(id: string): void {
    assertUuidV4(id, 'File id');
    this.database.prepare('DELETE FROM files WHERE id = ?').run(id);
  }
}
