import type { DatabaseSync } from 'node:sqlite';

import { DataIntegrityError } from '../errors.js';
import { decodeJson, encodeJson } from '../json.js';
import {
  assertUuidV4,
  type ConversationRecord,
  type ConversationSyncCheckpoint,
} from '../types.js';

interface ConversationRow {
  id: string;
  conversation_key: string | null;
  chatgpt_conversation_url: string | null;
  instructions_json: string;
  tools_json: string;
  tool_choice_json: string;
  tool_fingerprint: string | null;
  sync_status: 'clean' | 'in_flight';
  synced_message_count: number;
  sync_started_at: number | null;
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
    sync: {
      status: row.sync_status,
      syncedMessageCount: row.synced_message_count,
      ...(row.sync_started_at === null ? {} : { startedAt: row.sync_started_at }),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function validateSyncCheckpoint(checkpoint: ConversationSyncCheckpoint): void {
  if (!Number.isSafeInteger(checkpoint.syncedMessageCount) || checkpoint.syncedMessageCount < 0) {
    throw new DataIntegrityError('Conversation sync message count must be a non-negative integer');
  }
  if (checkpoint.status === 'clean' && checkpoint.startedAt !== undefined) {
    throw new DataIntegrityError('Clean Conversation sync cannot have startedAt');
  }
  if (checkpoint.status === 'in_flight' && checkpoint.startedAt === undefined) {
    throw new DataIntegrityError('In-flight Conversation sync requires startedAt');
  }
}

export class ConversationRepository {
  constructor(private readonly database: DatabaseSync) {}

  insert(record: ConversationRecord): void {
    assertUuidV4(record.id, 'Conversation id');
    validateSyncCheckpoint(record.sync);
    this.database
      .prepare(
        `INSERT INTO conversations
         (id, conversation_key, chatgpt_conversation_url, instructions_json, tools_json,
          tool_choice_json, tool_fingerprint, sync_status, synced_message_count, sync_started_at,
          created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.conversationKey ?? null,
        record.chatgptConversationUrl ?? null,
        encodeJson(record.instructions),
        encodeJson(record.tools),
        encodeJson(record.toolChoice),
        record.toolFingerprint ?? null,
        record.sync.status,
        record.sync.syncedMessageCount,
        record.sync.startedAt ?? null,
        record.createdAt,
        record.updatedAt,
        record.lastUsedAt,
      );
  }

  update(record: ConversationRecord): void {
    assertUuidV4(record.id, 'Conversation id');
    validateSyncCheckpoint(record.sync);
    const result = this.database
      .prepare(
        `UPDATE conversations
         SET conversation_key = ?, chatgpt_conversation_url = ?, instructions_json = ?, tools_json = ?,
             tool_choice_json = ?, tool_fingerprint = ?, sync_status = ?, synced_message_count = ?,
             sync_started_at = ?, created_at = ?, updated_at = ?, last_used_at = ?
         WHERE id = ?`,
      )
      .run(
        record.conversationKey ?? null,
        record.chatgptConversationUrl ?? null,
        encodeJson(record.instructions),
        encodeJson(record.tools),
        encodeJson(record.toolChoice),
        record.toolFingerprint ?? null,
        record.sync.status,
        record.sync.syncedMessageCount,
        record.sync.startedAt ?? null,
        record.createdAt,
        record.updatedAt,
        record.lastUsedAt,
        record.id,
      );

    if (Number(result.changes) !== 1) {
      throw new DataIntegrityError(`Conversation ${record.id} does not exist`);
    }
  }

  updateSyncCheckpoint(conversationId: string, checkpoint: ConversationSyncCheckpoint): void {
    assertUuidV4(conversationId, 'Conversation id');
    validateSyncCheckpoint(checkpoint);
    const result = this.database
      .prepare(
        `UPDATE conversations
         SET sync_status = ?, synced_message_count = ?, sync_started_at = ?
         WHERE id = ?`,
      )
      .run(
        checkpoint.status,
        checkpoint.syncedMessageCount,
        checkpoint.startedAt ?? null,
        conversationId,
      );
    if (Number(result.changes) !== 1) {
      throw new DataIntegrityError(`Conversation ${conversationId} does not exist`);
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

  listAnonymousBySyncedMessageCount(syncedMessageCount: number): ConversationRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM conversations
           WHERE conversation_key IS NULL
             AND sync_status = 'clean'
             AND synced_message_count = ?
             AND chatgpt_conversation_url IS NOT NULL
           ORDER BY last_used_at DESC, id ASC`,
        )
        .all(syncedMessageCount) as unknown as ConversationRow[]
    ).flatMap((row) => {
      const mapped = mapRow(row);
      return mapped === undefined ? [] : [mapped];
    });
  }
}
