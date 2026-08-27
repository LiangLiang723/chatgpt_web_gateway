import { describe, expect, it } from 'vitest';

import { planContextSync } from '../../src/context/planner.js';
import type {
  CanonicalAssistantToolCallMessage,
  CanonicalConversationRequest,
  CanonicalMessage,
  CanonicalStoredConversation,
  CanonicalTextMessage,
  CanonicalToolResultMessage,
  ContextSyncPlan,
} from '../../src/context/types.js';

const u1: CanonicalTextMessage = { role: 'user', text: 'u1' };
const a1: CanonicalTextMessage = { role: 'assistant', text: 'a1' };
const u2: CanonicalTextMessage = { role: 'user', text: 'u2' };
const a2: CanonicalTextMessage = { role: 'assistant', text: 'a2' };
const u3: CanonicalTextMessage = { role: 'user', text: 'u3' };
const call1: CanonicalAssistantToolCallMessage = {
  role: 'assistant',
  text: '',
  toolCalls: [{ externalCallId: 'call_1', name: 'weather', arguments: '{"city":"Tokyo"}' }],
};
const result1: CanonicalToolResultMessage = {
  role: 'tool',
  toolCallId: 'call_1',
  text: '{"temp":31}',
};

function request(
  messages: CanonicalMessage[],
  options: Partial<CanonicalConversationRequest> = {},
): CanonicalConversationRequest {
  return {
    instructions: { system: ['s'], developer: ['d'] },
    messages,
    mode: messages.length === 1 ? 'incremental' : 'full',
    ...options,
  };
}

function stored(options: Partial<CanonicalStoredConversation> = {}): CanonicalStoredConversation {
  return {
    instructions: { system: ['s'], developer: ['d'] },
    messages: [u1, a1],
    conversationUrl: 'https://chatgpt.com/c/thread-1',
    sync: { status: 'clean', syncedMessageCount: 2 },
    ...options,
  };
}

function expectMode(plan: ContextSyncPlan, mode: ContextSyncPlan['mode']): void {
  expect(plan.mode).toBe(mode);
}

describe('planContextSync', () => {
  it('plans FRESH with supplied history when no stored Conversation exists', () => {
    expect(planContextSync({ request: request([u1, a1, u2]), hasAffinityPage: false })).toEqual({
      mode: 'FRESH',
      history: [u1, a1],
      pending: [u2],
    });
  });

  it('APPENDs or RESTOREs a single-user incremental request', () => {
    expect(
      planContextSync({ stored: stored(), request: request([u2]), hasAffinityPage: true }),
    ).toEqual({ mode: 'APPEND', pending: [u2] });
    expect(
      planContextSync({ stored: stored(), request: request([u2]), hasAffinityPage: false }),
    ).toEqual({ mode: 'RESTORE', pending: [u2] });
  });

  it('APPENDs or RESTOREs a full-history request with exactly one unsynced user', () => {
    expect(
      planContextSync({ stored: stored(), request: request([u1, a1, u2]), hasAffinityPage: true }),
    ).toEqual({ mode: 'APPEND', pending: [u2] });
    expect(
      planContextSync({ stored: stored(), request: request([u1, a1, u2]), hasAffinityPage: false }),
    ).toEqual({ mode: 'RESTORE', pending: [u2] });
  });

  it('APPENDs or RESTOREs one or more tool results against persisted calls', () => {
    const storedTool = stored({
      messages: [u1, call1],
      sync: { status: 'clean', syncedMessageCount: 2 },
      toolFingerprint: 'tools-a',
    });
    expect(
      planContextSync({
        stored: storedTool,
        request: request([result1], { toolFingerprint: 'tools-a' }),
        hasAffinityPage: true,
      }),
    ).toEqual({ mode: 'APPEND', pending: [result1] });
    expect(
      planContextSync({
        stored: storedTool,
        request: request([u1, call1, result1], { toolFingerprint: 'tools-a' }),
        hasAffinityPage: false,
      }),
    ).toEqual({ mode: 'RESTORE', pending: [result1] });
  });

  it('rejects unknown and duplicate tool results', () => {
    const storedTool = stored({
      messages: [u1, call1],
      sync: { status: 'clean', syncedMessageCount: 2 },
    });
    expect(() =>
      planContextSync({
        stored: storedTool,
        request: request([{ role: 'tool', toolCallId: 'call_missing', text: 'x' }]),
        hasAffinityPage: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_conversation_request' }));
    expect(() =>
      planContextSync({
        stored: storedTool,
        request: request([result1, result1]),
        hasAffinityPage: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_conversation_request' }));
  });

  it('REBUILDs tool definition changes but not an equal fingerprint', () => {
    const withTools = stored({ toolFingerprint: 'same' });
    expect(
      planContextSync({
        stored: withTools,
        request: request([u2], { toolFingerprint: 'same' }),
        hasAffinityPage: true,
      }),
    ).toEqual({ mode: 'APPEND', pending: [u2] });
    expect(
      planContextSync({
        stored: withTools,
        request: request([u2], { toolFingerprint: 'changed' }),
        hasAffinityPage: true,
      }),
    ).toEqual({
      mode: 'REBUILD',
      reason: 'tools_changed',
      history: [u1, a1],
      pending: [u2],
    });
  });

  it('REBUILDs an uncertain incremental checkpoint from only the confirmed prefix', () => {
    expect(
      planContextSync({
        stored: stored({
          messages: [u1, a1, u2],
          sync: { status: 'in_flight', syncedMessageCount: 2 },
        }),
        request: request([u3]),
        hasAffinityPage: true,
      }),
    ).toEqual({
      mode: 'REBUILD',
      reason: 'checkpoint_uncertain',
      history: [u1, a1],
      pending: [u3],
    });
  });

  it('REBUILDs checkpoint count mismatch from confirmed prefix', () => {
    expect(
      planContextSync({
        stored: stored({
          messages: [u1, a1, u2],
          sync: { status: 'clean', syncedMessageCount: 2 },
        }),
        request: request([u3]),
        hasAffinityPage: true,
      }),
    ).toEqual({
      mode: 'REBUILD',
      reason: 'checkpoint_mismatch',
      history: [u1, a1],
      pending: [u3],
    });
  });

  it('REBUILDs instruction changes and uses stored confirmed history for incremental requests', () => {
    expect(
      planContextSync({
        stored: stored(),
        request: request([u2], {
          instructions: { system: ['changed'], developer: ['d'] },
        }),
        hasAffinityPage: true,
      }),
    ).toEqual({
      mode: 'REBUILD',
      reason: 'instructions_changed',
      history: [u1, a1],
      pending: [u2],
    });
  });

  it('REBUILDs edited full history using the client full history as authoritative', () => {
    const editedA1: CanonicalTextMessage = { role: 'assistant', text: 'edited-a1' };
    expect(
      planContextSync({
        stored: stored(),
        request: request([u1, editedA1, u2]),
        hasAffinityPage: true,
      }),
    ).toEqual({
      mode: 'REBUILD',
      reason: 'history_diverged',
      history: [u1, editedA1],
      pending: [u2],
    });
  });

  it('REBUILDs full requests containing multiple unsynced turns', () => {
    expect(
      planContextSync({
        stored: stored(),
        request: request([u1, a1, u2, a2, u3]),
        hasAffinityPage: true,
      }),
    ).toEqual({
      mode: 'REBUILD',
      reason: 'multiple_unsynced_turns',
      history: [u1, a1, u2, a2],
      pending: [u3],
    });
  });

  it('REBUILDs missing Conversation URL before considering affinity', () => {
    const plan = planContextSync({
      stored: stored({ conversationUrl: undefined }),
      request: request([u2]),
      hasAffinityPage: true,
    });
    expect(plan).toEqual({
      mode: 'REBUILD',
      reason: 'conversation_url_missing',
      history: [u1, a1],
      pending: [u2],
    });
  });

  it('uses client history for full-request checkpoint and instruction rebuilds', () => {
    for (const variant of [
      stored({ sync: { status: 'in_flight', syncedMessageCount: 1 } }),
      stored({ sync: { status: 'clean', syncedMessageCount: 1 } }),
      stored({ instructions: { system: ['old'], developer: ['d'] } }),
    ]) {
      const plan = planContextSync({
        stored: variant,
        request: request([u1, a1, u2]),
        hasAffinityPage: false,
      });
      expectMode(plan, 'REBUILD');
      if (plan.mode === 'REBUILD') {
        expect(plan.history).toEqual([u1, a1]);
        expect(plan.pending).toEqual([u2]);
      }
    }
  });
});
