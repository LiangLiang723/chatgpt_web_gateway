import { fingerprintCanonical } from './fingerprint.js';
import type {
  CanonicalConversationRequest,
  CanonicalStoredConversation,
  CanonicalTextMessage,
  ContextSyncPlan,
  RebuildReason,
} from './types.js';

function currentUser(request: CanonicalConversationRequest): CanonicalTextMessage {
  const message = request.messages.at(-1);
  if (!message || message.role !== 'user') {
    throw new Error('Canonical Conversation request must end with a user message');
  }
  return message;
}

function requestHistory(request: CanonicalConversationRequest): CanonicalTextMessage[] {
  return request.messages.slice(0, -1);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return fingerprintCanonical(left) === fingerprintCanonical(right);
}

function hasPrefix(
  messages: readonly CanonicalTextMessage[],
  prefix: readonly CanonicalTextMessage[],
): boolean {
  if (prefix.length > messages.length) return false;
  return prefix.every((message, index) => sameCanonical(message, messages[index]));
}

function confirmedPrefix(stored: CanonicalStoredConversation): CanonicalTextMessage[] {
  return stored.messages.slice(0, stored.sync.syncedMessageCount);
}

function fresh(request: CanonicalConversationRequest): ContextSyncPlan {
  return {
    mode: 'FRESH',
    history: requestHistory(request),
    currentUser: currentUser(request),
  };
}

function rebuild(
  reason: RebuildReason,
  storedHistory: CanonicalTextMessage[],
  request: CanonicalConversationRequest,
): ContextSyncPlan {
  return {
    mode: 'REBUILD',
    reason,
    history: request.mode === 'full' ? requestHistory(request) : storedHistory,
    currentUser: currentUser(request),
  };
}

function appendOrRestore(
  request: CanonicalConversationRequest,
  hasAffinityPage: boolean,
): ContextSyncPlan {
  return {
    mode: hasAffinityPage ? 'APPEND' : 'RESTORE',
    currentUser: currentUser(request),
  };
}

export function planContextSync(input: {
  stored?: CanonicalStoredConversation;
  request: CanonicalConversationRequest;
  hasAffinityPage: boolean;
}): ContextSyncPlan {
  const { stored, request, hasAffinityPage } = input;
  if (!stored) return fresh(request);

  if (stored.sync.status === 'in_flight') {
    return rebuild('checkpoint_uncertain', confirmedPrefix(stored), request);
  }
  if (stored.sync.syncedMessageCount !== stored.messages.length) {
    return rebuild('checkpoint_mismatch', confirmedPrefix(stored), request);
  }
  if (!stored.conversationUrl) {
    return rebuild('conversation_url_missing', stored.messages, request);
  }
  if (!sameCanonical(stored.instructions, request.instructions)) {
    return rebuild('instructions_changed', stored.messages, request);
  }

  if (request.mode === 'incremental') {
    return appendOrRestore(request, hasAffinityPage);
  }

  if (!hasPrefix(request.messages, stored.messages)) {
    return rebuild('history_diverged', stored.messages, request);
  }

  const unsynced = request.messages.slice(stored.messages.length);
  if (unsynced.length !== 1 || unsynced[0]?.role !== 'user') {
    return rebuild('multiple_unsynced_turns', stored.messages, request);
  }

  return appendOrRestore(request, hasAffinityPage);
}
