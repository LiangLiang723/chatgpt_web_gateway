import { EventEmitter } from 'node:events';

import type { BrowserContext, Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { createPagePool } from '../../src/browser/page-pool.js';

class FakePage extends EventEmitter {
  closed = false;
  closeCalls = 0;

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class FakeContext {
  readonly created: FakePage[] = [];

  constructor(private readonly initial: FakePage[] = []) {}

  pages(): Page[] {
    return [...this.initial, ...this.created].filter((page) => !page.closed) as unknown as Page[];
  }

  async newPage(): Promise<Page> {
    const page = new FakePage();
    this.created.push(page);
    return page as unknown as Page;
  }
}

function context(initial: FakePage[] = []): BrowserContext {
  return new FakeContext(initial) as unknown as BrowserContext;
}

describe('PagePool', () => {
  it('adopts existing context pages and reuses a released page', async () => {
    const initial = new FakePage();
    const pool = createPagePool(context([initial]), { maxOpenPages: 2 });

    expect(pool.openCount).toBe(1);
    expect(pool.idleCount).toBe(1);

    const first = await pool.acquire();
    expect(first.page).toBe(initial);
    expect(pool.leasedCount).toBe(1);
    expect(pool.idleCount).toBe(0);

    await first.release();
    expect(pool.leasedCount).toBe(0);
    expect(pool.idleCount).toBe(1);

    const reused = await pool.acquire();
    expect(reused.page).toBe(initial);
    expect(pool.openCount).toBe(1);
    await reused.release();
  });

  it('creates pages up to capacity and rejects the next acquire', async () => {
    const pool = createPagePool(context(), { maxOpenPages: 2 });

    const first = await pool.acquire();
    const second = await pool.acquire();

    expect(pool.openCount).toBe(2);
    expect(pool.leasedCount).toBe(2);
    await expect(pool.acquire()).rejects.toMatchObject({ code: 'page_capacity_exceeded' });

    await first.release();
    await second.release();
  });

  it('replaces the last leased page before closing it so a persistent context stays alive', async () => {
    const fakeContext = new FakeContext();
    const pool = createPagePool(fakeContext as unknown as BrowserContext, { maxOpenPages: 1 });
    const lease = await pool.acquire();
    const failedPage = lease.page as unknown as FakePage;

    await lease.close();
    await lease.close();
    await lease.release();

    expect(failedPage.closed).toBe(true);
    expect(failedPage.closeCalls).toBe(1);
    expect(fakeContext.created).toHaveLength(2);
    const replacement = fakeContext.created[1]!;
    expect(replacement.closed).toBe(false);
    expect(pool.openCount).toBe(1);
    expect(pool.leasedCount).toBe(0);
    expect(pool.idleCount).toBe(1);

    const next = await pool.acquire();
    expect(next.page).toBe(replacement);
    await next.release();
  });

  it('makes close after release a no-op so an old lease cannot kill a re-leased Page', async () => {
    const pool = createPagePool(context(), { maxOpenPages: 1 });
    const first = await pool.acquire();
    const page = first.page as unknown as FakePage;
    await first.release();

    const second = await pool.acquire();
    expect(second.page).toBe(first.page);
    await first.close();

    expect(page.closed).toBe(false);
    expect(page.closeCalls).toBe(0);
    expect(pool.leasedCount).toBe(1);
    await second.release();
  });

  it('makes release idempotent and removes pages that close while leased or idle', async () => {
    const pool = createPagePool(context(), { maxOpenPages: 2 });
    const lease = await pool.acquire();
    const page = lease.page as unknown as FakePage;

    await page.close();
    await lease.release();
    await lease.release();

    expect(pool.openCount).toBe(0);
    expect(pool.leasedCount).toBe(0);
    expect(pool.idleCount).toBe(0);

    const second = await pool.acquire();
    const secondPage = second.page as unknown as FakePage;
    await second.release();
    await secondPage.close();

    expect(pool.openCount).toBe(0);
    expect(pool.idleCount).toBe(0);
  });

  it('closes all tracked pages without affecting untracked siblings and rejects further acquire', async () => {
    const initial = new FakePage();
    const sibling = new FakePage();
    const fakeContext = new FakeContext([initial]);
    const pool = createPagePool(fakeContext as unknown as BrowserContext, { maxOpenPages: 2 });
    const lease = await pool.acquire();
    await lease.release();

    await pool.close();
    await pool.close();

    expect(initial.closed).toBe(true);
    expect(sibling.closed).toBe(false);
    expect(pool.openCount).toBe(0);
    await expect(pool.acquire()).rejects.toMatchObject({ code: 'browser_unavailable' });
  });
});
