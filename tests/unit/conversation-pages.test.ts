import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { BrowserRuntimeError } from '../../src/browser/errors.js';
import type { PageLease, PageLeaseReleaseOptions, PagePool } from '../../src/browser/types.js';
import { createConversationPageManager } from '../../src/conversations/conversation-pages.js';

class FakePage {
  closed = false;
  readonly id: number;

  constructor(id: number) {
    this.id = id;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

interface FakeLease extends PageLease {
  page: Page;
  fakePage: FakePage;
  releaseCalls: PageLeaseReleaseOptions[];
}

class FakePool implements Pick<PagePool, 'acquire'> {
  readonly leases: FakeLease[] = [];
  outstanding = 0;
  private nextId = 1;

  constructor(readonly capacity: number) {}

  async acquire(): Promise<PageLease> {
    if (this.outstanding >= this.capacity) {
      throw new BrowserRuntimeError('page_capacity_exceeded', 'capacity');
    }

    this.outstanding += 1;
    const fakePage = new FakePage(this.nextId++);
    let released = false;
    const lease: FakeLease = {
      page: fakePage as unknown as Page,
      fakePage,
      releaseCalls: [],
      release: async (options = {}) => {
        if (released) return;
        released = true;
        lease.releaseCalls.push(options);
        this.outstanding -= 1;
        if (options.discard) fakePage.closed = true;
      },
    };
    this.leases.push(lease);
    return lease;
  }
}

function timerHarness() {
  let cleared = 0;
  const handles: Array<{ callback: () => void; ms: number; unrefCalls: number }> = [];
  return {
    handles,
    get cleared() {
      return cleared;
    },
    setIntervalFn(callback: () => void, ms: number) {
      const handle = {
        callback,
        ms,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1;
        },
      };
      handles.push(handle);
      return handle;
    },
    clearIntervalFn() {
      cleared += 1;
    },
  };
}

describe('ConversationPageManager', () => {
  it('retains a keyed Page and reports warm reuse on the next acquire', async () => {
    const pool = new FakePool(2);
    let now = 10;
    const manager = createConversationPageManager({
      pagePool: pool,
      idleTimeoutMs: 1_000,
      now: () => now,
    });

    const first = await manager.acquire('alpha');
    expect(first.reused).toBe(false);
    const firstPage = first.page;
    await first.release();
    expect(pool.leases[0]!.releaseCalls).toEqual([]);

    now = 20;
    const second = await manager.acquire('alpha');
    expect(second.reused).toBe(true);
    expect(second.page).toBe(firstPage);
    await second.release();

    expect(manager.affinityCount).toBe(1);
    await manager.close();
  });

  it('drops a retained Page that closed externally and acquires a replacement', async () => {
    const pool = new FakePool(1);
    const manager = createConversationPageManager({
      pagePool: pool,
      idleTimeoutMs: 1_000,
      now: () => 0,
    });

    const first = await manager.acquire('alpha');
    await first.release();
    pool.leases[0]!.fakePage.closed = true;

    const replacement = await manager.acquire('alpha');
    expect(replacement.reused).toBe(false);
    expect(replacement.page).not.toBe(first.page);
    expect(pool.leases[0]!.releaseCalls).toEqual([{ discard: true }]);
    await replacement.release();
    await manager.close();
  });

  it('discards idle affinities after the configured timeout', async () => {
    const pool = new FakePool(1);
    let now = 0;
    const manager = createConversationPageManager({
      pagePool: pool,
      idleTimeoutMs: 100,
      now: () => now,
    });

    const lease = await manager.acquire('alpha');
    await lease.release();
    now = 100;
    await manager.sweepIdle();

    expect(manager.affinityCount).toBe(0);
    expect(pool.leases[0]!.releaseCalls).toEqual([{ discard: true }]);
    expect(pool.leases[0]!.fakePage.closed).toBe(true);
    await manager.close();
  });

  it('evicts the least-recently-used idle affinity when capacity is exhausted', async () => {
    const pool = new FakePool(1);
    let now = 0;
    const manager = createConversationPageManager({
      pagePool: pool,
      idleTimeoutMs: 10_000,
      now: () => now,
    });

    const alpha = await manager.acquire('alpha');
    await alpha.release();
    now = 5;

    const beta = await manager.acquire('beta');
    expect(beta.reused).toBe(false);
    expect(pool.leases).toHaveLength(2);
    expect(pool.leases[0]!.releaseCalls).toEqual([{ discard: true }]);
    expect(manager.hasWarmPage('alpha')).toBe(false);
    expect(manager.hasWarmPage('beta')).toBe(true);

    await beta.release();
    await manager.close();
  });

  it('never evicts an active affinity and preserves page_capacity_exceeded', async () => {
    const pool = new FakePool(1);
    const manager = createConversationPageManager({
      pagePool: pool,
      idleTimeoutMs: 10_000,
      now: () => 0,
    });

    const alpha = await manager.acquire('alpha');
    await expect(manager.acquire('beta')).rejects.toMatchObject({ code: 'page_capacity_exceeded' });
    expect(pool.leases[0]!.releaseCalls).toEqual([]);

    await alpha.release();
    await manager.close();
  });

  it('makes Conversation release idempotent and discards on explicit failure release', async () => {
    const pool = new FakePool(1);
    const manager = createConversationPageManager({
      pagePool: pool,
      idleTimeoutMs: 10_000,
      now: () => 0,
    });

    const lease = await manager.acquire('alpha');
    await lease.release({ discard: true });
    await lease.release({ discard: true });

    expect(manager.affinityCount).toBe(0);
    expect(pool.leases[0]!.releaseCalls).toEqual([{ discard: true }]);
    await manager.close();
  });

  it('clears the sweep timer and discards retained affinities on close', async () => {
    const pool = new FakePool(2);
    const timers = timerHarness();
    const manager = createConversationPageManager({
      pagePool: pool,
      idleTimeoutMs: 120_000,
      now: () => 0,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    const alpha = await manager.acquire('alpha');
    const beta = await manager.acquire('beta');
    await alpha.release();
    await beta.release();

    expect(timers.handles).toHaveLength(1);
    expect(timers.handles[0]!.ms).toBe(60_000);
    expect(timers.handles[0]!.unrefCalls).toBe(1);

    await manager.close();
    await manager.close();

    expect(timers.cleared).toBe(1);
    expect(manager.affinityCount).toBe(0);
    expect(pool.leases.every((lease) => lease.fakePage.closed)).toBe(true);
  });
});
