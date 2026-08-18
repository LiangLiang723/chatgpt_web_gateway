import type { DatabaseSync } from 'node:sqlite';

import { DataIntegrityError } from '../errors.js';
import { decodeJson, encodeJson } from '../json.js';
import { assertUuidV4, type AttachmentRecord } from '../types.js';

interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string;
  local_attachment_id: string;
  kind: 'image' | 'file';
  source_json: string;
  file_id: string | null;
  created_at: number;
}

function mapRow(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    localAttachmentId: row.local_attachment_id,
    kind: row.kind,
    source: decodeJson('attachments.source_json', row.source_json),
    fileId: row.file_id ?? undefined,
    createdAt: row.created_at,
  };
}

export class AttachmentRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(record: AttachmentRecord): void {
    assertUuidV4(record.id, 'Attachment id');
    assertUuidV4(record.conversationId, 'Attachment conversation id');
    assertUuidV4(record.messageId, 'Attachment message id');
    if (record.fileId) assertUuidV4(record.fileId, 'Attachment file id');

    const message = this.database
      .prepare('SELECT conversation_id FROM messages WHERE id = ?')
      .get(record.messageId);
    if (!message || String(message.conversation_id) !== record.conversationId) {
      throw new DataIntegrityError('Attachment message must belong to the same Conversation');
    }

    this.database
      .prepare(
        `INSERT INTO attachments
         (id, conversation_id, message_id, local_attachment_id, kind, source_json, file_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationId,
        record.messageId,
        record.localAttachmentId,
        record.kind,
        encodeJson(record.source),
        record.fileId ?? null,
        record.createdAt,
      );
  }

  listByConversation(conversationId: string): AttachmentRecord[] {
    assertUuidV4(conversationId, 'Conversation id');
    return (
      this.database
        .prepare(
          'SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
        )
        .all(conversationId) as unknown as AttachmentRow[]
    ).map(mapRow);
  }

  countByFileId(fileId: string): number {
    assertUuidV4(fileId, 'Attachment file id');
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM attachments WHERE file_id = ?')
      .get(fileId) as { count: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  deleteByConversation(conversationId: string): void {
    assertUuidV4(conversationId, 'Conversation id');
    this.database.prepare('DELETE FROM attachments WHERE conversation_id = ?').run(conversationId);
  }
}
