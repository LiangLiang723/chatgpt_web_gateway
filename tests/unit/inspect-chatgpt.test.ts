import { join, resolve } from 'node:path';

import type { BrowserContext, Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserManager, PagePool } from '../../src/browser/types.js';
import { inspectChatGpt, parseInspectEnvironment } from '../../src/chatgpt/inspect.js';

function fakeLocator(count = 0): Locator {
  return {
    count: async () => count,
  } as unknown as Locator;
}

function fakeBrowser(page: Page): BrowserManager {
  const pool: PagePool = {
    openCount: 1,
    leasedCount: 0,
    idleCount: 1,
    acquire: vi.fn(async () => ({ page, release: vi.fn(async () => undefined) })),
    close: vi.fn(async () => undefined),
  };
  return {
    context: {} as BrowserContext,
    pages: pool,
    close: vi.fn(async () => undefined),
  };
}

describe('inspect:chatgpt safety', () => {
  it('requires an explicit isolated ChatGPT Profile', () => {
    expect(() => parseInspectEnvironment({})).toThrow(/e2e_profile_required/);

    expect(() =>
      parseInspectEnvironment({
        DATA_DIR: '/data',
        CHATGPT_PROFILE_DIR: '/data/browser-profile',
      }),
    ).toThrow(/e2e_profile_must_be_isolated/);
  });

  it('normalizes an explicit isolated Profile and optional diagnostics directory', () => {
    expect(
      parseInspectEnvironment({
        DATA_DIR: '/data',
        CHATGPT_PROFILE_DIR: './e2e-browser-profile',
        CHATGPT_DIAGNOSTICS_DIR: './chatgpt-diagnostics',
      }),
    ).toEqual({
      profileDir: resolve('./e2e-browser-profile'),
      diagnosticsDir: resolve('./chatgpt-diagnostics'),
    });
  });

  it('does not write screenshots or HTML unless a diagnostics directory is supplied', async () => {
    const screenshot = vi.fn(async () => undefined);
    const content = vi.fn(async () => '<html>sensitive</html>');
    const page = {
      goto: vi.fn(async () => undefined),
      url: () => 'https://chatgpt.com/',
      locator: () => fakeLocator(0),
      getByRole: () => fakeLocator(0),
      screenshot,
      content,
    } as unknown as Page;
    const browser = fakeBrowser(page);
    const writeFile = vi.fn();

    const result = await inspectChatGpt({
      profileDir: join('/tmp', 'isolated-profile'),
      createBrowserManager: async () => browser,
      writeFile,
    });

    expect(result).toMatchObject({
      url: 'https://chatgpt.com/',
      auth: 'unknown',
    });
    expect(screenshot).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('writes only controlled screenshot and HTML artifacts when diagnostics are explicit', async () => {
    const screenshot = vi.fn(async () => undefined);
    const content = vi.fn(async () => '<html>diagnostic</html>');
    const page = {
      goto: vi.fn(async () => undefined),
      url: () => 'https://chatgpt.com/',
      locator: () => fakeLocator(0),
      getByRole: () => fakeLocator(0),
      screenshot,
      content,
    } as unknown as Page;
    const writeFile = vi.fn();
    const mkdir = vi.fn();

    await inspectChatGpt({
      profileDir: '/tmp/isolated-profile',
      diagnosticsDir: '/tmp/chatgpt-diagnostics',
      createBrowserManager: async () => fakeBrowser(page),
      mkdir,
      writeFile,
    });

    expect(mkdir).toHaveBeenCalledWith('/tmp/chatgpt-diagnostics', { recursive: true });
    expect(screenshot).toHaveBeenCalledWith({
      path: '/tmp/chatgpt-diagnostics/chatgpt.png',
      fullPage: true,
    });
    expect(content).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/chatgpt-diagnostics/chatgpt.html',
      '<html>diagnostic</html>',
      'utf8',
    );
  });
});
