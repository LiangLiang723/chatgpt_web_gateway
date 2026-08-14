import type { DatabaseSync } from 'node:sqlite';

import { DataIntegrityError } from '../errors.js';
import { assertUuidV4, type ToolCallRecord } from '../types.js';

interface ToolCallRow {
  id: string;
  conversation_id: string;
  message_id: string;
  external_call_id: string;
  name: string;
  arguments_text: string;
  created_at: number;
}

function mapRow(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    externalCallId: row.external_call_id,
    name: row.name,
    argumentsText: row.arguments_text,
    createdAt: row.created_at,
  };
}

export class ToolCallRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(record: ToolCallRecord): void {
    assertUuidV4(record.id, 'Tool Call id');
    assertUuidV4(record.conversationId, 'Tool Call conversation id');
    assertUuidV4(record.messageId, 'Tool Call message id');

    const message = this.database
      .prepare('SELECT conversation_id FROM messages WHERE id = ?')
      .get(record.messageId);
    if (!message || String(message.conversation_id) !== record.conversationId) {
      throw new DataIntegrityError('Tool Call message must belong to the same Conversation');
    }

    this.database
      .prepare(
        `INSERT INTO tool_calls
         (id, conversation_id, message_id, external_call_id, name, arguments_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationId,
        record.messageId,
        record.externalCallId,
        record.name,
        record.argumentsText,
        record.createdAt,
      );
  }

  listByConversation(conversationId: string): ToolCallRecord[] {
    assertUuidV4(conversationId, 'Conversation id');
    return (
      this.database
        .prepare(
          'SELECT * FROM tool_calls WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
        )
        .all(conversationId) as unknown as ToolCallRow[]
    ).map(mapRow);
  }

  deleteByConversation(conversationId: string): void {
    assertUuidV4(conversationId, 'Conversation id');
    this.database.prepare('DELETE FROM tool_calls WHERE conversation_id = ?').run(conversationId);
  }
}
