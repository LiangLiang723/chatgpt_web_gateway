export type ConversationRequestMode = 'incremental' | 'full';

export interface CanonicalTextMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type CanonicalContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'attachment';
      reference: string;
      kind: 'image' | 'file';
      sha256: string;
      filename: string;
      mimeType?: string;
    };

export interface CanonicalMultimodalMessage {
  role: 'user' | 'assistant';
  content: CanonicalContentPart[];
}

export interface CanonicalToolCall {
  externalCallId: string;
  name: string;
  arguments: string;
}

export interface CanonicalAssistantToolCallMessage {
  role: 'assistant';
  text: string;
  toolCalls: CanonicalToolCall[];
}

export interface CanonicalToolResultMessage {
  role: 'tool';
  toolCallId: string;
  text: string;
}

export type CanonicalMessage =
  | CanonicalTextMessage
  | CanonicalMultimodalMessage
  | CanonicalAssistantToolCallMessage
  | CanonicalToolResultMessage;

export interface CanonicalInstructions {
  system: string[];
  developer: string[];
}

export interface CanonicalConversationRequest {
  instructions: CanonicalInstructions;
  messages: CanonicalMessage[];
  mode: ConversationRequestMode;
  toolFingerprint?: string;
}

export interface CanonicalStoredConversation {
  instructions: CanonicalInstructions;
  messages: CanonicalMessage[];
  toolFingerprint?: string;
  conversationUrl?: string;
  sync: {
    status: 'clean' | 'in_flight';
    syncedMessageCount: number;
  };
}

export type RebuildReason =
  | 'checkpoint_uncertain'
  | 'checkpoint_mismatch'
  | 'instructions_changed'
  | 'tools_changed'
  | 'history_diverged'
  | 'multiple_unsynced_turns'
  | 'conversation_url_missing';

export type ContextSyncPlan =
  | { mode: 'FRESH'; history: CanonicalMessage[]; pending: CanonicalMessage[] }
  | { mode: 'APPEND'; pending: CanonicalMessage[] }
  | { mode: 'RESTORE'; pending: CanonicalMessage[] }
  | {
      mode: 'REBUILD';
      reason: RebuildReason;
      history: CanonicalMessage[];
      pending: CanonicalMessage[];
    };
