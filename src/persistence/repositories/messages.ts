import type { DatabaseSync } from 'node:sqlite';

import { decodeJson, encodeJson } from '../json.js';
import { assertUuidV4, type MessageRecord } from '../types.js';

interface MessageRow {
  id: string;
  conversation_id: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool';
  content_json: string;
  tool_call_id: string | null;
  created_at: number;
  updated_at: number;
}

function mapRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    role: row.role,
    content: decodeJson('messages.content_json', row.content_json),
    toolCallId: row.tool_call_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MessageRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(record: MessageRecord): void {
    assertUuidV4(record.id, 'Message id');
    assertUuidV4(record.conversationId, 'Message conversation id');
    this.database
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, sequence, role, content_json, tool_call_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationId,
        record.sequence,
        record.role,
        encodeJson(record.content),
        record.toolCallId ?? null,
        record.createdAt,
        record.updatedAt,
      );
  }

  listByConversation(conversationId: string): MessageRecord[] {
    assertUuidV4(conversationId, 'Conversation id');
    return (
      this.database
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence ASC')
        .all(conversationId) as unknown as MessageRow[]
    ).map(mapRow);
  }

  deleteByConversation(conversationId: string): void {
    assertUuidV4(conversationId, 'Conversation id');
    this.database.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
  }
}
