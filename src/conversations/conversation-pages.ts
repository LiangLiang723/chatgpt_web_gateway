import type { Page } from 'playwright';

import { BrowserRuntimeError } from '../browser/errors.js';
import type { PageLease, PageLeaseReleaseOptions, PagePool } from '../browser/types.js';

interface IntervalHandle {
  unref?: () => void;
}

export interface ConversationPageLease {
  readonly page: Page;
  readonly reused: boolean;
  release(options?: PageLeaseReleaseOptions): Promise<void>;
}

export interface ConversationPageManager {
  readonly affinityCount: number;
  hasWarmPage(conversationKey: string): boolean;
  acquire(conversationKey: string): Promise<ConversationPageLease>;
  sweepIdle(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateConversationPageManagerOptions {
  pagePool: Pick<PagePool, 'acquire'>;
  idleTimeoutMs: number;
  now?: () => number;
  setIntervalFn?: (callback: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
}

interface Affinity {
  poolLease: PageLease;
  active: boolean;
  lastUsedAt: number;
}

function isPageCapacityError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'page_capacity_exceeded'
  );
}

export function createConversationPageManager(
  options: CreateConversationPageManagerOptions,
): ConversationPageManager {
  const now = options.now ?? Date.now;
  const affinities = new Map<string, Affinity>();
  const setIntervalFn =
    options.setIntervalFn ??
    ((callback: () => void, ms: number) => setInterval(callback, ms) as IntervalHandle);
  const clearIntervalFn =
    options.clearIntervalFn ??
    ((handle: IntervalHandle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let closed = false;

  const discardAffinity = async (conversationKey: string, affinity: Affinity): Promise<void> => {
    if (affinities.get(conversationKey) === affinity) affinities.delete(conversationKey);
    await affinity.poolLease.release({ discard: true });
  };

  const sweepIdle = async (): Promise<void> => {
    if (closed) return;
    const cutoff = now() - options.idleTimeoutMs;
    const expired = [...affinities.entries()].filter(
      ([, affinity]) => !affinity.active && affinity.lastUsedAt <= cutoff,
    );
    for (const [conversationKey, affinity] of expired) {
      await discardAffinity(conversationKey, affinity);
    }
  };

  const evictLeastRecentlyUsedIdle = async (): Promise<boolean> => {
    let candidate: [string, Affinity] | undefined;
    for (const entry of affinities.entries()) {
      const affinity = entry[1];
      if (affinity.active) continue;
      if (!candidate || affinity.lastUsedAt < candidate[1].lastUsedAt) candidate = entry;
    }
    if (!candidate) return false;
    await discardAffinity(candidate[0], candidate[1]);
    return true;
  };

  const timer = setIntervalFn(
    () => {
      void sweepIdle().catch(() => undefined);
    },
    Math.min(options.idleTimeoutMs, 60_000),
  );
  timer.unref?.();

  const manager: ConversationPageManager = {
    get affinityCount() {
      return affinities.size;
    },

    hasWarmPage(conversationKey) {
      const affinity = affinities.get(conversationKey);
      return affinity !== undefined && !affinity.poolLease.page.isClosed();
    },

    async acquire(conversationKey) {
      if (closed) {
        throw new BrowserRuntimeError('browser_unavailable', 'Conversation Page manager is closed');
      }

      await sweepIdle();
      let affinity = affinities.get(conversationKey);
      if (affinity?.poolLease.page.isClosed()) {
        await discardAffinity(conversationKey, affinity);
        affinity = undefined;
      }

      if (affinity) {
        if (affinity.active) {
          throw new BrowserRuntimeError(
            'browser_unavailable',
            'Conversation Page affinity is already active',
          );
        }
        affinity.active = true;
        const activeAffinity = affinity;
        let released = false;
        return {
          page: activeAffinity.poolLease.page,
          reused: true,
          async release(releaseOptions = {}) {
            if (released) return;
            released = true;
            if (releaseOptions.discard) {
              await discardAffinity(conversationKey, activeAffinity);
              return;
            }
            activeAffinity.active = false;
            activeAffinity.lastUsedAt = now();
          },
        };
      }

      let poolLease: PageLease;
      try {
        poolLease = await options.pagePool.acquire();
      } catch (error) {
        if (!isPageCapacityError(error) || !(await evictLeastRecentlyUsedIdle())) throw error;
        poolLease = await options.pagePool.acquire();
      }

      affinity = { poolLease, active: true, lastUsedAt: now() };
      affinities.set(conversationKey, affinity);
      let released = false;
      return {
        page: poolLease.page,
        reused: false,
        async release(releaseOptions = {}) {
          if (released) return;
          released = true;
          if (releaseOptions.discard) {
            await discardAffinity(conversationKey, affinity);
            return;
          }
          affinity.active = false;
          affinity.lastUsedAt = now();
        },
      };
    },

    sweepIdle,

    async close() {
      if (closed) return;
      closed = true;
      clearIntervalFn(timer);
      const retained = [...affinities.values()];
      affinities.clear();
      const results = await Promise.allSettled(
        retained.map((affinity) => affinity.poolLease.release({ discard: true })),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        throw new BrowserRuntimeError(
          'browser_unavailable',
          'Failed to close Conversation Page affinities',
          failed.reason,
        );
      }
    },
  };

  return manager;
}
