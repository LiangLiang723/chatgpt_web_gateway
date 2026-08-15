import { describe, expect, it } from 'vitest';

import { planContextSync } from '../../src/context/planner.js';
import type {
  CanonicalConversationRequest,
  CanonicalStoredConversation,
  CanonicalTextMessage,
  ContextSyncPlan,
} from '../../src/context/types.js';

const u1: CanonicalTextMessage = { role: 'user', text: 'u1' };
const a1: CanonicalTextMessage = { role: 'assistant', text: 'a1' };
const u2: CanonicalTextMessage = { role: 'user', text: 'u2' };
const a2: CanonicalTextMessage = { role: 'assistant', text: 'a2' };
const u3: CanonicalTextMessage = { role: 'user', text: 'u3' };

function request(
  messages: CanonicalTextMessage[],
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
      currentUser: u2,
    });
  });

  it('APPENDs a single-user incremental request on a clean affinity Conversation', () => {
    expect(
      planContextSync({ stored: stored(), request: request([u2]), hasAffinityPage: true }),
    ).toEqual({ mode: 'APPEND', currentUser: u2 });
  });

  it('RESTOREs a single-user incremental request when the Page affinity is gone', () => {
    expect(
      planContextSync({ stored: stored(), request: request([u2]), hasAffinityPage: false }),
    ).toEqual({ mode: 'RESTORE', currentUser: u2 });
  });

  it('APPENDs or RESTOREs a full-history request with exactly one unsynced user', () => {
    expect(
      planContextSync({ stored: stored(), request: request([u1, a1, u2]), hasAffinityPage: true }),
    ).toEqual({ mode: 'APPEND', currentUser: u2 });
    expect(
      planContextSync({ stored: stored(), request: request([u1, a1, u2]), hasAffinityPage: false }),
    ).toEqual({ mode: 'RESTORE', currentUser: u2 });
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
      currentUser: u3,
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
      currentUser: u3,
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
      currentUser: u2,
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
      currentUser: u2,
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
      currentUser: u3,
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
      currentUser: u2,
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
        expect(plan.currentUser).toEqual(u2);
      }
    }
  });
});
