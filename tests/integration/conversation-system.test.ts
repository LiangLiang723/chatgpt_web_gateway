import { EventEmitter } from 'node:events';

import type { BrowserContext, Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { createPagePool } from '../../src/browser/page-pool.js';
import { createConversationPageRegistry } from '../../src/conversations/page-registry.js';

class FakePage extends EventEmitter {
  closed = false;

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class FakeContext {
  readonly pagesCreated: FakePage[] = [];

  pages(): Page[] {
    return this.pagesCreated.filter((page) => !page.closed) as unknown as Page[];
  }

  async newPage(): Promise<Page> {
    const page = new FakePage();
    this.pagesCreated.push(page);
    return page as unknown as Page;
  }
}

describe('Conversation Page Registry + PagePool capacity semantics', () => {
  it('releases and reuses the LRU idle affinity while preserving the more recent binding', async () => {
    const context = new FakeContext();
    const pool = createPagePool(context as unknown as BrowserContext, { maxOpenPages: 2 });
    let now = 0;
    const registry = createConversationPageRegistry({
      pagePool: pool,
      idleTimeoutMs: 60_000,
      now: () => now,
    });

    const alphaFirst = await registry.acquire('alpha');
    const alphaPage = alphaFirst.page;
    await alphaFirst.complete();

    now = 1;
    const beta = await registry.acquire('beta');
    const betaPage = beta.page;
    await beta.complete();

    now = 2;
    const alphaSecond = await registry.acquire('alpha');
    expect(alphaSecond.page).toBe(alphaPage);
    await alphaSecond.complete();

    now = 3;
    const gamma = await registry.acquire('gamma');
    expect(gamma.page).toBe(betaPage);
    expect(registry.hasAffinity('alpha')).toBe(true);
    expect(registry.hasAffinity('beta')).toBe(false);
    expect(registry.hasAffinity('gamma')).toBe(true);
    await gamma.complete();

    await registry.close();
    await pool.close();
  });

  it('preserves page_capacity_exceeded when every affinity is busy', async () => {
    const context = new FakeContext();
    const pool = createPagePool(context as unknown as BrowserContext, { maxOpenPages: 2 });
    const registry = createConversationPageRegistry({ pagePool: pool, idleTimeoutMs: 60_000 });

    const alpha = await registry.acquire('alpha');
    const beta = await registry.acquire('beta');

    await expect(registry.acquire('gamma')).rejects.toMatchObject({
      code: 'page_capacity_exceeded',
    });
    expect(registry.hasAffinity('alpha')).toBe(true);
    expect(registry.hasAffinity('beta')).toBe(true);

    await alpha.fail();
    await beta.fail();
    await registry.close();
    await pool.close();
  });
});
