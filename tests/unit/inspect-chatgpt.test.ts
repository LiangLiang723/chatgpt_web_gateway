import { resolve } from 'node:path';

import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { inspectChatGptPage, parseInspectEnvironment } from '../../src/chatgpt/inspect.js';

function fakeLocator(count = 0, rows: unknown[] = []): Locator {
  return {
    count: async () => count,
    evaluateAll: async () => rows,
    setInputFiles: vi.fn(async () => undefined),
  } as unknown as Locator;
}

function fakePage(
  screenshot = vi.fn(async () => undefined),
  content = vi.fn(async () => '<html/>'),
) {
  return {
    goto: vi.fn(async () => undefined),
    url: () => 'https://chatgpt.com/',
    locator: (selector: string) => {
      if (selector === 'input[type="file"]') {
        return fakeLocator(1, [
          {
            tag: 'INPUT',
            testId: 'file-upload',
            name: null,
            accept: 'image/*,.pdf',
            className: 'attachment-input',
            multiple: true,
            disabled: false,
          },
        ]);
      }
      if (selector === 'button, [role="button"], [data-testid]') {
        return fakeLocator(1, [
          {
            tag: 'BUTTON',
            className: 'attachment-control',
            testId: 'composer-plus-btn',
            ariaLabel: 'Add files and more',
            role: null,
            dataState: null,
            dataStatus: null,
            ariaBusy: null,
            ariaInvalid: null,
            title: null,
            disabled: false,
          },
        ]);
      }
      return fakeLocator(0);
    },
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

  it('normalizes an explicit isolated Profile and optional diagnostics/probe paths', () => {
    expect(
      parseInspectEnvironment({
        DATA_DIR: '/data',
        CHATGPT_PROFILE_DIR: './e2e-browser-profile',
        CHATGPT_DIAGNOSTICS_DIR: './chatgpt-diagnostics',
        CHATGPT_ATTACHMENT_PROBE_PATH: './tests/fixtures/phase6-inspect-upload.txt',
        CHATGPT_PROXY_SERVER: ' http://proxy.example:7890 ',
      } as Parameters<typeof parseInspectEnvironment>[0] & {
        CHATGPT_ATTACHMENT_PROBE_PATH: string;
      }),
    ).toEqual({
      profileDir: resolve('./e2e-browser-profile'),
      diagnosticsDir: resolve('./chatgpt-diagnostics'),
      attachmentProbePath: resolve('./tests/fixtures/phase6-inspect-upload.txt'),
      proxyServer: 'http://proxy.example:7890',
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
      attachments: {
        fileInputs: {
          status: 'unique',
          count: 1,
          items: [
            {
              tag: 'INPUT',
              testId: 'file-upload',
              accept: 'image/*,.pdf',
              className: 'attachment-input',
              multiple: true,
              disabled: false,
            },
          ],
        },
        candidateControls: [
          {
            tag: 'BUTTON',
            className: 'attachment-control',
            testId: 'composer-plus-btn',
            ariaLabel: 'Add files and more',
            disabled: false,
          },
        ],
        candidateStates: [],
      },
    });
    expect(screenshot).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('maps page navigation failures to browser_unavailable', async () => {
    const page = {
      goto: vi.fn(async () => {
        throw new Error('raw page navigation detail');
      }),
    } as unknown as Page;

    await expect(inspectChatGptPage(page)).rejects.toMatchObject({
      code: 'browser_unavailable',
    });
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
