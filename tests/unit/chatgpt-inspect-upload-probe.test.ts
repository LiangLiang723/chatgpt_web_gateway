import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { inspectChatGptPage } from '../../src/chatgpt/inspect.js';

interface ProbePageOptions {
  pendingCounts?: number[];
  alertCounts?: number[];
}

function sequence(values: number[], fallback: number): () => number {
  const remaining = [...values];
  return () => (remaining.length > 0 ? (remaining.shift() as number) : fallback);
}

function countLocator(count: number): Locator {
  return {
    count: vi.fn(async () => count),
    waitFor: vi.fn(async () => undefined),
  } as unknown as Locator;
}

function probePage(options: ProbePageOptions = {}) {
  let uploaded = false;
  const pendingCount = sequence(options.pendingCounts ?? [2, 0], 0);
  const alertCount = sequence(options.alertCounts ?? [0, 0], 0);
  const setInputFiles = vi.fn(async () => {
    uploaded = true;
  });
  const reload = vi.fn(async () => undefined);
  const waitForTimeout = vi.fn(async () => undefined);

  const ownedTile = {
    getAttribute: vi.fn(async (name: string) => (name === 'aria-label' ? 'probe-ready.txt' : null)),
    locator: vi.fn((selector: string) => {
      if (selector !== 'button.cursor-wait, circle') {
        throw new Error(`Unexpected owned tile selector: ${selector}`);
      }
      return {
        count: vi.fn(async () => pendingCount()),
      } as unknown as Locator;
    }),
  } as unknown as Locator;

  const attachmentTiles = {
    count: vi.fn(async () => (uploaded ? 1 : 0)),
    nth: vi.fn(() => ownedTile),
  } as unknown as Locator;

  const attachmentAlerts = {
    count: vi.fn(async () => (uploaded ? alertCount() : 0)),
  } as unknown as Locator;

  const fileInputs = {
    count: vi.fn(async () => 1),
    evaluateAll: vi.fn(async () => [
      {
        tag: 'INPUT',
        testId: null,
        name: null,
        accept: null,
        className: null,
        multiple: true,
        disabled: false,
      },
    ]),
    nth: vi.fn(() => ({ setInputFiles }) as unknown as Locator),
  } as unknown as Locator;

  const page = {
    goto: vi.fn(async () => undefined),
    reload,
    waitForTimeout,
    url: vi.fn(() => 'https://chatgpt.com/'),
    getByRole: vi.fn(() => countLocator(0)),
    locator: vi.fn((selector: string) => {
      if (selector === '#prompt-textarea') return countLocator(1);
      if (selector === 'input[type="file"]') return fileInputs;
      if (selector === '[role="group"]:has(button[aria-label^="Remove file "])') {
        return attachmentTiles;
      }
      if (selector === '[role="alert"]') return attachmentAlerts;
      if (
        selector === 'button, [role="button"], [data-testid]' ||
        selector === '[data-testid], [data-state], [data-status], [aria-busy], [aria-invalid]'
      ) {
        return {
          count: vi.fn(async () => 0),
          evaluateAll: vi.fn(async () => []),
        } as unknown as Locator;
      }
      return countLocator(0);
    }),
  } as unknown as Page;

  return { page, setInputFiles, reload, waitForTimeout };
}

describe('inspect:chatgpt attachment readiness probe', () => {
  it('reports an owned pending-to-ready transition using tile baseline ownership', async () => {
    const { page, setInputFiles, reload } = probePage({ pendingCounts: [2, 0] });

    await expect(
      inspectChatGptPage(page, { attachmentProbePath: '/tmp/probe.txt' }),
    ).resolves.toMatchObject({
      auth: 'authenticated',
      attachments: {
        probe: {
          status: 'observed',
          filename: 'probe.txt',
          inputIndex: 0,
          baselineTiles: 0,
          baselineAlerts: 0,
          outcome: 'ready',
          snapshots: [
            {
              elapsedMs: 0,
              tileCount: 1,
              alertCount: 0,
              ownedPendingCount: 2,
              ownedLabel: 'probe-ready.txt',
            },
            {
              elapsedMs: 250,
              tileCount: 1,
              alertCount: 0,
              ownedPendingCount: 0,
              ownedLabel: 'probe-ready.txt',
            },
          ],
        },
      },
    });
    expect(setInputFiles).toHaveBeenCalledWith('/tmp/probe.txt');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reports a new role alert as an upload error and reloads the composer', async () => {
    const { page, reload } = probePage({ pendingCounts: [2], alertCounts: [1] });

    await expect(
      inspectChatGptPage(page, { attachmentProbePath: '/tmp/empty.txt' }),
    ).resolves.toMatchObject({
      attachments: {
        probe: {
          status: 'observed',
          outcome: 'error',
          snapshots: [
            expect.objectContaining({
              elapsedMs: 0,
              tileCount: 1,
              alertCount: 1,
            }),
          ],
        },
      },
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
