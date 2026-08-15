import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { BrowserRuntimeError } from '../../src/browser/errors.js';
import type { PageLease, PagePool } from '../../src/browser/types.js';
import { createConversationPageRegistry } from '../../src/conversations/page-registry.js';

class FakePage {
  closed = false;
  constructor(readonly id: number) {}
  isClosed(): boolean {
    return this.closed;
  }
}

interface FakeLease extends PageLease {
  fakePage: FakePage;
  releaseCalls: number;
  closeCalls: number;
}

class FakePool implements Pick<PagePool, 'acquire'> {
  readonly leases: FakeLease[] = [];
  acquireCalls = 0;
  outstanding = 0;
  private nextId = 1;

  constructor(readonly capacity: number) {}

  async acquire(): Promise<PageLease> {
    this.acquireCalls += 1;
    if (this.outstanding >= this.capacity) {
      throw new BrowserRuntimeError('page_capacity_exceeded', 'capacity');
    }
    this.outstanding += 1;
    const fakePage = new FakePage(this.nextId++);
    let state: 'active' | 'released' | 'closed' = 'active';
    const lease: FakeLease = {
      page: fakePage as unknown as Page,
      fakePage,
      releaseCalls: 0,
      closeCalls: 0,
      release: async () => {
        if (state !== 'active') return;
        state = 'released';
        lease.releaseCalls += 1;
        this.outstanding -= 1;
      },
      close: async () => {
        if (state !== 'active') return;
        state = 'closed';
        lease.closeCalls += 1;
        fakePage.closed = true;
        this.outstanding -= 1;
      },
    };
    this.leases.push(lease);
    return lease;
  }
}

function timerHarness() {
  type Handle = { callback: () => void; ms: number; cleared: boolean };
  const handles: Handle[] = [];
  let clearCalls = 0;
  const setTimer = ((callback: (...args: unknown[]) => void, ms?: number) => {
    const handle: Handle = { callback: () => callback(), ms: ms ?? 0, cleared: false };
    handles.push(handle);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((handle: ReturnType<typeof setTimeout>) => {
    clearCalls += 1;
    (handle as unknown as Handle).cleared = true;
  }) as typeof clearTimeout;
  return {
    handles,
    get clearCalls() {
      return clearCalls;
    },
    setTimer,
    clearTimer,
    async fireLatest() {
      const handle = [...handles].reverse().find((item) => !item.cleared);
      if (!handle) throw new Error('No active timer');
      handle.cleared = true;
      handle.callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('ConversationPageRegistry', () => {
  it('retains a successful keyed Page and reuses the same Page', async () => {
    const pool = new FakePool(2);
    let now = 10;
    const registry = createConversationPageRegistry({
      pagePool: pool,
      idleTimeoutMs: 1000,
      now: () => now,
    });

    const first = await registry.acquire('alpha');
    const page = first.page;
    await first.complete();
    expect(pool.leases[0]!.releaseCalls).toBe(0);
    expect(registry.hasAffinity('alpha')).toBe(true);

    now = 20;
    const second = await registry.acquire('alpha');
    expect(second.page).toBe(page);
    await second.complete();
    await registry.close();
  });

  it('always releases transient sessions without creating affinity', async () => {
    const pool = new FakePool(1);
    const registry = createConversationPageRegistry({ pagePool: pool, idleTimeoutMs: 1000 });

    const session = await registry.acquire();
    await session.complete();
    expect(pool.leases[0]!.releaseCalls).toBe(1);
    expect(pool.outstanding).toBe(0);
    await registry.close();
  });

  it('never evicts a busy affinity and preserves page_capacity_exceeded', async () => {
    const pool = new FakePool(1);
    const registry = createConversationPageRegistry({ pagePool: pool, idleTimeoutMs: 1000 });

    const alpha = await registry.acquire('alpha');
    await expect(registry.acquire('beta')).rejects.toMatchObject({
      code: 'page_capacity_exceeded',
    });
    expect(pool.leases[0]!.releaseCalls).toBe(0);
    await alpha.complete();
    await registry.close();
  });

  it('evicts the least-recently-used idle affinity and retries acquire once', async () => {
    const pool = new FakePool(2);
    let now = 0;
    const registry = createConversationPageRegistry({
      pagePool: pool,
      idleTimeoutMs: 10_000,
      now: () => now,
    });

    const beta = await registry.acquire('beta');
    await beta.complete();
    now = 5;
    const alpha = await registry.acquire('alpha');
    await alpha.complete();
    now = 10;

    const gamma = await registry.acquire('gamma');
    expect(pool.acquireCalls).toBe(4);
    expect(pool.leases[0]!.releaseCalls).toBe(1);
    expect(registry.hasAffinity('beta')).toBe(false);
    expect(registry.hasAffinity('alpha')).toBe(true);
    await gamma.complete();
    await registry.close();
  });

  it('uses conversation id as deterministic LRU tie-break', async () => {
    const pool = new FakePool(2);
    const registry = createConversationPageRegistry({
      pagePool: pool,
      idleTimeoutMs: 10_000,
      now: () => 0,
    });
    const beta = await registry.acquire('beta');
    await beta.complete();
    const alpha = await registry.acquire('alpha');
    await alpha.complete();

    const gamma = await registry.acquire('gamma');
    expect(registry.hasAffinity('alpha')).toBe(false);
    expect(registry.hasAffinity('beta')).toBe(true);
    await gamma.complete();
    await registry.close();
  });

  it('closes idle affinity at deadline instead of releasing it', async () => {
    const pool = new FakePool(1);
    const timers = timerHarness();
    let now = 0;
    const registry = createConversationPageRegistry({
      pagePool: pool,
      idleTimeoutMs: 100,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const session = await registry.acquire('alpha');
    await session.complete();
    expect(timers.handles.at(-1)?.ms).toBe(100);
    now = 100;
    await timers.fireLatest();

    expect(pool.leases[0]!.closeCalls).toBe(1);
    expect(pool.leases[0]!.releaseCalls).toBe(0);
    expect(registry.hasAffinity('alpha')).toBe(false);
    await registry.close();
  });

  it('drops closed Pages and fail() unbinds then releases exactly once', async () => {
    const pool = new FakePool(2);
    const registry = createConversationPageRegistry({ pagePool: pool, idleTimeoutMs: 1000 });

    const alpha = await registry.acquire('alpha');
    await alpha.complete();
    pool.leases[0]!.fakePage.closed = true;
    expect(registry.hasAffinity('alpha')).toBe(false);

    const beta = await registry.acquire('beta');
    await beta.fail();
    await beta.fail();
    expect(pool.leases[1]!.releaseCalls).toBe(1);
    expect(registry.hasAffinity('beta')).toBe(false);
    await registry.close();
  });

  it('clears the timer and releases retained bindings on close', async () => {
    const pool = new FakePool(2);
    const timers = timerHarness();
    const registry = createConversationPageRegistry({
      pagePool: pool,
      idleTimeoutMs: 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const alpha = await registry.acquire('alpha');
    const beta = await registry.acquire('beta');
    await alpha.complete();
    await beta.complete();

    await registry.close();
    await registry.close();

    expect(timers.clearCalls).toBeGreaterThanOrEqual(1);
    expect(pool.leases.every((lease) => lease.releaseCalls === 1)).toBe(true);
    await expect(registry.acquire('gamma')).rejects.toMatchObject({ code: 'browser_unavailable' });
  });
});
