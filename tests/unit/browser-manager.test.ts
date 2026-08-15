import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrowserManager } from '../../src/browser/browser-manager.js';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function tempProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'cwg-browser-manager-'));
  tempRoots.push(root);
  return join(root, 'profile');
}

function fakeContext(events: string[] = []): BrowserContext {
  let pageClosed = false;
  const page = {
    isClosed: () => pageClosed,
    once() {
      return page;
    },
    async close() {
      pageClosed = true;
      events.push('page-close');
    },
  } as unknown as Page;

  return {
    pages: () => [page],
    newPage: vi.fn(),
    close: vi.fn(async () => {
      events.push('context-close');
    }),
  } as unknown as BrowserContext;
}

describe('BrowserManager', () => {
  it('creates the profile directory and launches full Chromium on the virtual display', async () => {
    const profileDir = tempProfile();
    const context = fakeContext();
    const launch = vi.fn(async () => context);

    const manager = await createBrowserManager({
      profileDir,
      maxActivePages: 4,
      launchPersistentContext: launch,
    });

    expect(launch).toHaveBeenCalledWith(profileDir, {
      headless: false,
      viewport: { width: 1440, height: 900 },
    });
    expect(manager.context).toBe(context);
    expect(manager.pages.openCount).toBe(1);
    expect(() => mkdirSync(profileDir)).toThrow();

    await manager.close();
  });

  it('passes an explicit ChatGPT proxy server to the persistent context', async () => {
    const profileDir = tempProfile();
    const context = fakeContext();
    const launch = vi.fn(async () => context);

    const manager = await createBrowserManager({
      profileDir,
      maxActivePages: 4,
      proxyServer: 'http://proxy.example:7890',
      launchPersistentContext: launch,
    });

    expect(launch).toHaveBeenCalledWith(profileDir, {
      headless: false,
      viewport: { width: 1440, height: 900 },
      proxy: { server: 'http://proxy.example:7890' },
    });

    await manager.close();
  });

  it('maps persistent-context launch failures to browser_unavailable', async () => {
    const profileDir = tempProfile();
    const launch = vi.fn(async () => {
      throw new Error('profile lock details that must stay internal');
    });

    await expect(
      createBrowserManager({ profileDir, maxActivePages: 4, launchPersistentContext: launch }),
    ).rejects.toMatchObject({
      name: 'BrowserRuntimeError',
      code: 'browser_unavailable',
    });
  });

  it('closes the PagePool before the context and is idempotent', async () => {
    const events: string[] = [];
    const context = fakeContext(events);
    const manager = await createBrowserManager({
      profileDir: tempProfile(),
      maxActivePages: 4,
      launchPersistentContext: async () => context,
    });

    await manager.close();
    await manager.close();

    expect(events).toEqual(['page-close', 'context-close']);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
