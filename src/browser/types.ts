import type { BrowserContext, Page } from 'playwright';

export interface PageLeaseReleaseOptions {
  discard?: boolean;
}

export interface PageLease {
  readonly page: Page;
  release(options?: PageLeaseReleaseOptions): Promise<void>;
}

export interface PagePool {
  readonly openCount: number;
  readonly leasedCount: number;
  readonly idleCount: number;
  acquire(): Promise<PageLease>;
  close(): Promise<void>;
}

export interface BrowserManager {
  readonly context: BrowserContext;
  readonly pages: PagePool;
  close(): Promise<void>;
}
