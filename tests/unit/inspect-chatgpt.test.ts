import { resolve } from 'node:path';

import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { inspectChatGptPage, parseInspectEnvironment } from '../../src/chatgpt/inspect.js';

function fakeLocator(count = 0): Locator {
  return { count: async () => count } as unknown as Locator;
}

function fakePage(
  screenshot = vi.fn(async () => undefined),
  content = vi.fn(async () => '<html/>'),
) {
  return {
    goto: vi.fn(async () => undefined),
    url: () => 'https://chatgpt.com/',
    locator: () => fakeLocator(0),
    getByRole: () => fakeLocator(0),
    screenshot,
    content,
  } as unknown as Page;
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

  it('inspects an already-owned Page without writing artifacts by default', async () => {
    const screenshot = vi.fn(async () => undefined);
    const content = vi.fn(async () => '<html>sensitive</html>');
    const writeFile = vi.fn();

    await expect(
      inspectChatGptPage(fakePage(screenshot, content), { writeFile }),
    ).resolves.toMatchObject({
      url: 'https://chatgpt.com/',
      auth: 'unknown',
    });
    expect(screenshot).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes only controlled screenshot and HTML artifacts when diagnostics are explicit', async () => {
    const screenshot = vi.fn(async () => undefined);
    const content = vi.fn(async () => '<html>diagnostic</html>');
    const writeFile = vi.fn();
    const mkdir = vi.fn();

    await inspectChatGptPage(fakePage(screenshot, content), {
      diagnosticsDir: '/tmp/chatgpt-diagnostics',
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
