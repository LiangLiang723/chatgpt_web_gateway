import { fingerprintCanonical } from './fingerprint.js';
import {
  fingerprintCanonicalMessage,
  isCanonicalAssistantToolCallMessage,
  isCanonicalToolResultMessage,
} from './multimodal.js';
import type {
  CanonicalConversationRequest,
  CanonicalMessage,
  CanonicalStoredConversation,
  ContextSyncPlan,
  RebuildReason,
} from './types.js';

export class ContextSyncPlanningError extends Error {
  readonly code = 'invalid_conversation_request';

  constructor(message: string) {
    super(message);
    this.name = 'ContextSyncPlanningError';
  }
}

function pendingStart(request: CanonicalConversationRequest): number {
  const last = request.messages.at(-1);
  if (!last) throw new ContextSyncPlanningError('Conversation request must contain a pending turn');
  if (last.role === 'user') return request.messages.length - 1;
  if (last.role !== 'tool') {
    throw new ContextSyncPlanningError(
      'Conversation request must end with a user or tool-result turn',
    );
  }
  let start = request.messages.length - 1;
  while (start > 0 && request.messages[start - 1]?.role === 'tool') start -= 1;
  return start;
}

function pendingTurn(request: CanonicalConversationRequest): CanonicalMessage[] {
  return request.messages.slice(pendingStart(request));
}

function requestHistory(request: CanonicalConversationRequest): CanonicalMessage[] {
  return request.messages.slice(0, pendingStart(request));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return fingerprintCanonical(left) === fingerprintCanonical(right);
}

function sameMessage(left: CanonicalMessage, right: CanonicalMessage): boolean {
  return fingerprintCanonicalMessage(left) === fingerprintCanonicalMessage(right);
}

function hasPrefix(
  messages: readonly CanonicalMessage[],
  prefix: readonly CanonicalMessage[],
): boolean {
  if (prefix.length > messages.length) return false;
  return prefix.every((message, index) =>
    sameMessage(message, messages[index] as CanonicalMessage),
  );
}

function confirmedPrefix(stored: CanonicalStoredConversation): CanonicalMessage[] {
  return stored.messages.slice(0, stored.sync.syncedMessageCount);
}

function validatePending(
  pending: readonly CanonicalMessage[],
  prior: readonly CanonicalMessage[],
): void {
  if (pending.length === 1 && pending[0]?.role === 'user') return;
  if (pending.length === 0 || pending.some((message) => message.role !== 'tool')) {
    throw new ContextSyncPlanningError(
      'Pending turn must contain exactly one user message or one or more tool results',
    );
  }

  const knownCalls = new Set<string>();
  const completedCalls = new Set<string>();
  for (const message of prior) {
    if (isCanonicalAssistantToolCallMessage(message)) {
      for (const call of message.toolCalls) knownCalls.add(call.externalCallId);
    } else if (isCanonicalToolResultMessage(message)) {
      completedCalls.add(message.toolCallId);
    }
  }

  const seen = new Set<string>();
  for (const message of pending) {
    if (!isCanonicalToolResultMessage(message)) continue;
    if (seen.has(message.toolCallId)) {
      throw new ContextSyncPlanningError(
        'A tool call cannot receive duplicate results in one turn',
      );
    }
    seen.add(message.toolCallId);
    if (!knownCalls.has(message.toolCallId)) {
      throw new ContextSyncPlanningError('Tool result references an unknown tool call');
    }
    if (completedCalls.has(message.toolCallId)) {
      throw new ContextSyncPlanningError(
        'Tool result references a tool call that already has a result',
      );
    }
  }
}

function fresh(request: CanonicalConversationRequest): ContextSyncPlan {
  const history = requestHistory(request);
  const pending = pendingTurn(request);
  validatePending(pending, history);
  return { mode: 'FRESH', history, pending };
}

function rebuild(
  reason: RebuildReason,
  storedHistory: CanonicalMessage[],
  request: CanonicalConversationRequest,
): ContextSyncPlan {
  const pending = pendingTurn(request);
  const history = request.mode === 'full' ? requestHistory(request) : storedHistory;
  validatePending(pending, history);
  return { mode: 'REBUILD', reason, history, pending };
}

function appendOrRestore(
  request: CanonicalConversationRequest,
  prior: readonly CanonicalMessage[],
  hasAffinityPage: boolean,
): ContextSyncPlan {
  const pending = pendingTurn(request);
  validatePending(pending, prior);
  return { mode: hasAffinityPage ? 'APPEND' : 'RESTORE', pending };
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
  if (stored.toolFingerprint !== request.toolFingerprint) {
    return rebuild('tools_changed', stored.messages, request);
  }

  if (request.mode === 'incremental') {
    return appendOrRestore(request, stored.messages, hasAffinityPage);
  }

  if (!hasPrefix(request.messages, stored.messages)) {
    return rebuild('history_diverged', stored.messages, request);
  }

  const unsynced = request.messages.slice(stored.messages.length);
  const pending = pendingTurn(request);
  if (
    unsynced.length !== pending.length ||
    !unsynced.every((message, index) => sameMessage(message, pending[index] as CanonicalMessage))
  ) {
    return rebuild('multiple_unsynced_turns', stored.messages, request);
  }

  return appendOrRestore(request, stored.messages, hasAffinityPage);
}
