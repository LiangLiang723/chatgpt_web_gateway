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

export type CanonicalMessage = CanonicalTextMessage | CanonicalMultimodalMessage;

export interface CanonicalInstructions {
  system: string[];
  developer: string[];
}

export interface CanonicalConversationRequest {
  instructions: CanonicalInstructions;
  messages: CanonicalMessage[];
  mode: ConversationRequestMode;
}

export interface CanonicalStoredConversation {
  instructions: CanonicalInstructions;
  messages: CanonicalMessage[];
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
  | 'history_diverged'
  | 'multiple_unsynced_turns'
  | 'conversation_url_missing';

export type ContextSyncPlan =
  | { mode: 'FRESH'; history: CanonicalMessage[]; currentUser: CanonicalMessage }
  | { mode: 'APPEND'; currentUser: CanonicalMessage }
  | { mode: 'RESTORE'; currentUser: CanonicalMessage }
  | {
      mode: 'REBUILD';
      reason: RebuildReason;
      history: CanonicalMessage[];
      currentUser: CanonicalMessage;
    };
