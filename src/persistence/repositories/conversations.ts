import type { DatabaseSync } from 'node:sqlite';

import { DataIntegrityError } from '../errors.js';
import { decodeJson, encodeJson } from '../json.js';
import { assertUuidV4, type ConversationRecord } from '../types.js';

interface ConversationRow {
  id: string;
  conversation_key: string | null;
  chatgpt_conversation_url: string | null;
  instructions_json: string;
  tools_json: string;
  tool_choice_json: string;
  tool_fingerprint: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number;
}

function mapRow(row: ConversationRow | undefined): ConversationRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    conversationKey: row.conversation_key ?? undefined,
    chatgptConversationUrl: row.chatgpt_conversation_url ?? undefined,
    instructions: decodeJson('conversations.instructions_json', row.instructions_json),
    tools: decodeJson('conversations.tools_json', row.tools_json),
    toolChoice: decodeJson('conversations.tool_choice_json', row.tool_choice_json),
    toolFingerprint: row.tool_fingerprint ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

export class ConversationRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(record: ConversationRecord): void {
    assertUuidV4(record.id, 'Conversation id');
    this.database
      .prepare(
        `INSERT INTO conversations
         (id, conversation_key, chatgpt_conversation_url, instructions_json, tools_json,
          tool_choice_json, tool_fingerprint, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationKey ?? null,
        record.chatgptConversationUrl ?? null,
        encodeJson(record.instructions),
        encodeJson(record.tools),
        encodeJson(record.toolChoice),
        record.toolFingerprint ?? null,
        record.createdAt,
        record.updatedAt,
        record.lastUsedAt,
      );
  }

  update(record: ConversationRecord): void {
    assertUuidV4(record.id, 'Conversation id');
    const result = this.database
      .prepare(
        `UPDATE conversations
         SET conversation_key = ?, chatgpt_conversation_url = ?, instructions_json = ?, tools_json = ?,
             tool_choice_json = ?, tool_fingerprint = ?, created_at = ?, updated_at = ?, last_used_at = ?
         WHERE id = ?`,
      )
      .run(
        record.conversationKey ?? null,
        record.chatgptConversationUrl ?? null,
        encodeJson(record.instructions),
        encodeJson(record.tools),
        encodeJson(record.toolChoice),
        record.toolFingerprint ?? null,
        record.createdAt,
        record.updatedAt,
        record.lastUsedAt,
        record.id,
      );

    if (Number(result.changes) !== 1) {
      throw new DataIntegrityError(`Conversation ${record.id} does not exist`);
    }
  }

  getById(id: string): ConversationRecord | undefined {
    assertUuidV4(id, 'Conversation id');
    return mapRow(
      this.database.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
        ConversationRow | undefined,
    );
  }

  getByKey(conversationKey: string): ConversationRecord | undefined {
    return mapRow(
      this.database
        .prepare('SELECT * FROM conversations WHERE conversation_key = ?')
        .get(conversationKey) as ConversationRow | undefined,
    );
  }
}
