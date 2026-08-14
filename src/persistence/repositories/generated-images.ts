import type { DatabaseSync } from 'node:sqlite';

import { assertUuidV4, type GeneratedImageRecord } from '../types.js';

interface GeneratedImageRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  prompt: string;
  mime_type: string | null;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  created_at: number;
}

function mapRow(row: GeneratedImageRow | undefined): GeneratedImageRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    conversationId: row.conversation_id ?? undefined,
    messageId: row.message_id ?? undefined,
    prompt: row.prompt,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

export class GeneratedImageRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(record: GeneratedImageRecord): void {
    assertUuidV4(record.id, 'Generated Image id');
    if (record.conversationId)
      assertUuidV4(record.conversationId, 'Generated Image conversation id');
    if (record.messageId) assertUuidV4(record.messageId, 'Generated Image message id');

    this.database
      .prepare(
        `INSERT INTO generated_images
         (id, conversation_id, message_id, prompt, mime_type, size_bytes, sha256, storage_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationId ?? null,
        record.messageId ?? null,
        record.prompt,
        record.mimeType ?? null,
        record.sizeBytes,
        record.sha256,
        record.storagePath,
        record.createdAt,
      );
  }

  getById(id: string): GeneratedImageRecord | undefined {
    assertUuidV4(id, 'Generated Image id');
    return mapRow(
      this.database.prepare('SELECT * FROM generated_images WHERE id = ?').get(id) as
        GeneratedImageRow | undefined,
    );
  }

  listByConversation(conversationId: string): GeneratedImageRecord[] {
    assertUuidV4(conversationId, 'Conversation id');
    return (
      this.database
        .prepare(
          'SELECT * FROM generated_images WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
        )
        .all(conversationId) as unknown as GeneratedImageRow[]
    ).map((row) => mapRow(row) as GeneratedImageRecord);
  }

  deleteByConversation(conversationId: string): void {
    assertUuidV4(conversationId, 'Conversation id');
    this.database
      .prepare('DELETE FROM generated_images WHERE conversation_id = ?')
      .run(conversationId);
  }
}
