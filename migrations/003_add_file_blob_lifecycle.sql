CREATE TEMP TABLE migration_file_hash_guard (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0)
) STRICT;

INSERT INTO migration_file_hash_guard (sha256, size_bytes)
SELECT DISTINCT sha256, size_bytes
FROM files;

CREATE TABLE file_blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

INSERT INTO file_blobs (id, sha256, size_bytes, storage_path, created_at)
SELECT
  substr(raw_uuid, 1, 8) || '-' ||
  substr(raw_uuid, 9, 4) || '-4' ||
  substr(raw_uuid, 14, 3) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) ||
  substr(raw_uuid, 18, 3) || '-' ||
  substr(raw_uuid, 21, 12),
  sha256,
  size_bytes,
  storage_path,
  created_at
FROM (
  SELECT
    lower(hex(randomblob(16))) AS raw_uuid,
    sha256,
    size_bytes,
    MIN(storage_path) AS storage_path,
    MIN(created_at) AS created_at
  FROM files
  GROUP BY sha256, size_bytes
);

CREATE TABLE files_new (
  id TEXT PRIMARY KEY,
  public_id TEXT UNIQUE,
  blob_id TEXT NOT NULL REFERENCES file_blobs(id),
  filename TEXT NOT NULL,
  mime_type TEXT,
  purpose TEXT,
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO files_new (
  id,
  public_id,
  blob_id,
  filename,
  mime_type,
  purpose,
  deleted_at,
  created_at,
  updated_at
)
SELECT
  legacy.id,
  NULL,
  blob.id,
  legacy.filename,
  legacy.mime_type,
  NULL,
  NULL,
  legacy.created_at,
  legacy.updated_at
FROM files AS legacy
JOIN file_blobs AS blob ON blob.sha256 = legacy.sha256;

CREATE TABLE attachments_new (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  local_attachment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  file_id TEXT REFERENCES files_new(id),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (message_id, local_attachment_id)
) STRICT;

INSERT INTO attachments_new (
  id,
  conversation_id,
  message_id,
  local_attachment_id,
  kind,
  source_json,
  file_id,
  created_at
)
SELECT
  id,
  conversation_id,
  message_id,
  local_attachment_id,
  kind,
  source_json,
  file_id,
  created_at
FROM attachments;

DROP TABLE attachments;
DROP TABLE files;
ALTER TABLE files_new RENAME TO files;
ALTER TABLE attachments_new RENAME TO attachments;

CREATE INDEX idx_attachments_conversation_message
  ON attachments(conversation_id, message_id);
CREATE INDEX idx_attachments_file
  ON attachments(file_id);
CREATE INDEX idx_files_blob
  ON files(blob_id);
CREATE INDEX idx_files_public_created
  ON files(created_at, id)
  WHERE public_id IS NOT NULL;
CREATE INDEX idx_files_deleted
  ON files(deleted_at)
  WHERE deleted_at IS NOT NULL;

DROP TABLE migration_file_hash_guard;
