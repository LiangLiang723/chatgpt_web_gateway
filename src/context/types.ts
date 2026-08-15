export type ConversationRequestMode = 'incremental' | 'full';

export interface CanonicalTextMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface CanonicalInstructions {
  system: string[];
  developer: string[];
}

export interface CanonicalConversationRequest {
  instructions: CanonicalInstructions;
  messages: CanonicalTextMessage[];
  mode: ConversationRequestMode;
}

export interface CanonicalStoredConversation {
  instructions: CanonicalInstructions;
  messages: CanonicalTextMessage[];
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
  | { mode: 'FRESH'; history: CanonicalTextMessage[]; currentUser: CanonicalTextMessage }
  | { mode: 'APPEND'; currentUser: CanonicalTextMessage }
  | { mode: 'RESTORE'; currentUser: CanonicalTextMessage }
  | {
      mode: 'REBUILD';
      reason: RebuildReason;
      history: CanonicalTextMessage[];
      currentUser: CanonicalTextMessage;
    };
