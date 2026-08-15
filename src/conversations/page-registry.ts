import type { Page } from 'playwright';

import { BrowserRuntimeError } from '../browser/errors.js';
import type { PageLease, PagePool } from '../browser/types.js';

export interface ConversationPageSession {
  readonly page: Page;
  complete(): Promise<void>;
  fail(): Promise<void>;
}

export interface ConversationPageRegistry {
  hasAffinity(conversationId: string): boolean;
  acquire(conversationId?: string): Promise<ConversationPageSession>;
  close(): Promise<void>;
}

export interface CreateConversationPageRegistryOptions {
  pagePool: Pick<PagePool, 'acquire'>;
  idleTimeoutMs: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

interface Binding {
  lease: PageLease;
  busy: boolean;
  lastUsedAt: number;
}

function isCapacityError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'page_capacity_exceeded'
  );
}

export function createConversationPageRegistry(
  options: CreateConversationPageRegistryOptions,
): ConversationPageRegistry {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const bindings = new Map<string, Binding>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const clearScheduledTimer = () => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };

  const deleteClosedBindings = () => {
    for (const [conversationId, binding] of bindings) {
      if (binding.lease.page.isClosed()) bindings.delete(conversationId);
    }
  };

  const releaseBinding = async (
    conversationId: string,
    binding: Binding,
    terminal: 'release' | 'close',
  ): Promise<void> => {
    if (bindings.get(conversationId) === binding) bindings.delete(conversationId);
    if (terminal === 'close') await binding.lease.close();
    else await binding.lease.release();
  };

  let scheduleEarliestExpiry = () => undefined;

  const expireIdleBindings = async (): Promise<void> => {
    if (closed) return;
    deleteClosedBindings();
    const current = now();
    const expired = [...bindings.entries()]
      .filter(([, binding]) => !binding.busy && binding.lastUsedAt + options.idleTimeoutMs <= current)
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.lastUsedAt - right.lastUsedAt || leftId.localeCompare(rightId),
      );
    for (const [conversationId, binding] of expired) {
      await releaseBinding(conversationId, binding, 'close');
    }
    scheduleEarliestExpiry();
  };

  scheduleEarliestExpiry = () => {
    clearScheduledTimer();
    if (closed) return;
    deleteClosedBindings();
    const candidates = [...bindings.entries()]
      .filter(([, binding]) => !binding.busy)
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.lastUsedAt - right.lastUsedAt || leftId.localeCompare(rightId),
      );
    const earliest = candidates[0];
    if (!earliest) return;
    const delay = Math.max(0, earliest[1].lastUsedAt + options.idleTimeoutMs - now());
    timer = setTimer(() => {
      timer = undefined;
      void expireIdleBindings().catch(() => undefined);
    }, delay);
    const handle = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
    handle.unref?.();
  };

  const evictLeastRecentlyUsedIdle = async (): Promise<boolean> => {
    deleteClosedBindings();
    const candidate = [...bindings.entries()]
      .filter(([, binding]) => !binding.busy)
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.lastUsedAt - right.lastUsedAt || leftId.localeCompare(rightId),
      )[0];
    if (!candidate) return false;
    await releaseBinding(candidate[0], candidate[1], 'release');
    scheduleEarliestExpiry();
    return true;
  };

  const acquirePoolLease = async (): Promise<PageLease> => {
    try {
      return await options.pagePool.acquire();
    } catch (error) {
      if (!isCapacityError(error) || !(await evictLeastRecentlyUsedIdle())) throw error;
      return options.pagePool.acquire();
    }
  };

  const createSession = (
    lease: PageLease,
    conversationId: string | undefined,
    binding: Binding | undefined,
  ): ConversationPageSession => {
    let state: 'active' | 'complete' | 'failed' = 'active';
    return {
      page: lease.page,
      async complete() {
        if (state !== 'active') return;
        state = 'complete';
        if (conversationId === undefined || binding === undefined) {
          await lease.release();
          return;
        }
        if (bindings.get(conversationId) !== binding) return;
        binding.busy = false;
        binding.lastUsedAt = now();
        scheduleEarliestExpiry();
      },
      async fail() {
        if (state !== 'active') return;
        state = 'failed';
        if (conversationId === undefined || binding === undefined) {
          await lease.release();
          return;
        }
        await releaseBinding(conversationId, binding, 'release');
        scheduleEarliestExpiry();
      },
    };
  };

  return {
    hasAffinity(conversationId) {
      const binding = bindings.get(conversationId);
      if (!binding) return false;
      if (binding.lease.page.isClosed()) {
        bindings.delete(conversationId);
        scheduleEarliestExpiry();
        return false;
      }
      return true;
    },

    async acquire(conversationId) {
      if (closed) {
        throw new BrowserRuntimeError('browser_unavailable', 'Conversation Page registry is closed');
      }

      if (conversationId === undefined) {
        const lease = await acquirePoolLease();
        return createSession(lease, undefined, undefined);
      }

      let binding = bindings.get(conversationId);
      if (binding?.lease.page.isClosed()) {
        bindings.delete(conversationId);
        await binding.lease.release();
        binding = undefined;
      }
      if (binding) {
        if (binding.busy) {
          throw new BrowserRuntimeError(
            'browser_unavailable',
            'Conversation Page affinity is already busy',
          );
        }
        binding.busy = true;
        scheduleEarliestExpiry();
        return createSession(binding.lease, conversationId, binding);
      }

      const lease = await acquirePoolLease();
      binding = { lease, busy: true, lastUsedAt: now() };
      bindings.set(conversationId, binding);
      scheduleEarliestExpiry();
      return createSession(lease, conversationId, binding);
    },

    async close() {
      if (closed) return;
      closed = true;
      clearScheduledTimer();
      const retained = [...bindings.values()];
      bindings.clear();
      const results = await Promise.allSettled(retained.map((binding) => binding.lease.release()));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        throw new BrowserRuntimeError(
          'browser_unavailable',
          'Failed to release Conversation Page bindings',
          failed.reason,
        );
      }
    },
  };
}
