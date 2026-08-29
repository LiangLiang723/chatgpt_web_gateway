import type { BrowserContext, Page } from 'playwright';

import { BrowserRuntimeError } from './errors.js';
import type { PageLease, PagePool } from './types.js';

export interface CreatePagePoolOptions {
  maxOpenPages: number;
}

export function createPagePool(context: BrowserContext, options: CreatePagePoolOptions): PagePool {
  const open = new Set<Page>();
  const leased = new Set<Page>();
  const idle = new Set<Page>();
  let closed = false;

  const removePage = (page: Page) => {
    open.delete(page);
    leased.delete(page);
    idle.delete(page);
  };

  const trackPage = (page: Page, initialState: 'idle' | 'leased') => {
    if (page.isClosed()) return;
    open.add(page);
    if (initialState === 'idle') idle.add(page);
    else leased.add(page);
    page.once('close', () => removePage(page));
  };

  for (const page of context.pages()) trackPage(page, 'idle');

  return {
    get openCount() {
      return open.size;
    },
    get leasedCount() {
      return leased.size;
    },
    get idleCount() {
      return idle.size;
    },
    async acquire(): Promise<PageLease> {
      if (closed) {
        throw new BrowserRuntimeError('browser_unavailable', 'Page pool is closed');
      }

      let page = idle.values().next().value as Page | undefined;
      if (page) {
        idle.delete(page);
        leased.add(page);
      } else {
        if (open.size >= options.maxOpenPages) {
          throw new BrowserRuntimeError('page_capacity_exceeded', 'No Page capacity is available');
        }
        page = await context.newPage();
        trackPage(page, 'leased');
      }

      let state: 'active' | 'released' | 'closed' = 'active';
      return {
        page,
        async release() {
          if (state !== 'active') return;
          state = 'released';
          leased.delete(page);
          if (closed || page.isClosed()) {
            removePage(page);
            return;
          }
          idle.add(page);
        },
        async close() {
          if (state !== 'active') return;
          if (!closed && !page.isClosed() && open.size === 1 && open.has(page)) {
            const replacement = await context.newPage();
            trackPage(replacement, 'idle');
          }
          state = 'closed';
          leased.delete(page);
          removePage(page);
          if (!page.isClosed()) await page.close();
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      const pages = [...open];
      open.clear();
      leased.clear();
      idle.clear();
      const results = await Promise.allSettled(
        pages.filter((page) => !page.isClosed()).map((page) => page.close()),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        throw new BrowserRuntimeError(
          'browser_unavailable',
          'Failed to close Page pool',
          failed.reason,
        );
      }
    },
  };
}
