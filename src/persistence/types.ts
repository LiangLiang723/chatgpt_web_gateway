import type {
  NormalizedAttachment,
  NormalizedContentPart,
  NormalizedInstruction,
  NormalizedTool,
  NormalizedToolChoice,
} from '../api/normalized.js';

import { DataIntegrityError } from './errors.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuidV4(value: string, context: string): void {
  if (!UUID_V4.test(value)) {
    throw new DataIntegrityError(`${context} must be a UUID v4`);
  }
}

export interface ConversationSyncCheckpoint {
  status: 'clean' | 'in_flight';
  syncedMessageCount: number;
  startedAt?: number;
}

export interface ConversationRecord {
  id: string;
  conversationKey?: string;
  chatgptConversationUrl?: string;
  instructions: NormalizedInstruction[];
  tools: NormalizedTool[];
  toolChoice: NormalizedToolChoice;
  toolFingerprint?: string;
  sync: ConversationSyncCheckpoint;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool';
  content: NormalizedContentPart[];
  toolCallId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ToolCallRecord {
  id: string;
  conversationId: string;
  messageId: string;
  externalCallId: string;
  name: string;
  argumentsText: string;
  createdAt: number;
}

export interface AttachmentRecord {
  id: string;
  conversationId: string;
  messageId: string;
  localAttachmentId: string;
  kind: 'image' | 'file';
  source: NormalizedAttachment['source'];
  fileId?: string;
  createdAt: number;
}

export interface FileRecord {
  id: string;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  createdAt: number;
  updatedAt: number;
}

export interface GeneratedImageRecord {
  id: string;
  conversationId?: string;
  messageId?: string;
  prompt: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  createdAt: number;
}

export interface ConversationAggregate {
  conversation: ConversationRecord;
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  attachments: AttachmentRecord[];
  generatedImages: GeneratedImageRecord[];
}
