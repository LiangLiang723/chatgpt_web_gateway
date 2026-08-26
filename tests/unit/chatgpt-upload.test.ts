import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { createChatGptDriver } from '../../src/chatgpt/driver.js';

interface UploadHarnessOptions {
  baselineTiles?: number;
  ownedPendingSequences?: number[][];
  alertCountsAfterUpload?: number[];
  tileCountsAfterUpload?: number[];
  uploadNow?: () => number;
  uploadSleep?: (ms: number) => Promise<void>;
  uploadTimeoutMs?: number;
  uploadPollIntervalMs?: number;
}

function sequenceValue(sequence: number[] | undefined, fallback: number): () => number {
  const values = [...(sequence ?? [])];
  return () => (values.length > 0 ? (values.shift() as number) : fallback);
}

function uploadHarness(options: UploadHarnessOptions = {}) {
  const events: string[] = [];
  const baselineTiles = options.baselineTiles ?? 1;
  let uploaded = false;
  const tileCountAfterUpload = sequenceValue(
    options.tileCountsAfterUpload,
    baselineTiles + (options.ownedPendingSequences?.length ?? 2),
  );
  const alertCountAfterUpload = sequenceValue(options.alertCountsAfterUpload, 0);

  const assistantTurns = {
    count: vi.fn(async () => 3),
    nth: vi.fn(() => ({}) as Locator),
  } as unknown as Locator;

  const ownedPendingCounts = (
    options.ownedPendingSequences ?? [
      [2, 0, 0],
      [2, 0, 0],
    ]
  ).map((sequence) => sequenceValue(sequence, 0));

  const tileLocators: Locator[] = Array.from(
    { length: baselineTiles + ownedPendingCounts.length },
    (_, index) =>
      ({
        locator: vi.fn((selector: string) => {
          if (selector !== 'button.cursor-wait, circle') {
            throw new Error(`Unexpected tile selector ${selector}`);
          }
          return {
            count: vi.fn(async () => {
              if (index < baselineTiles) {
                events.push(`pending:${index}:existing`);
                return 99;
              }
              const ownedIndex = index - baselineTiles;
              const count = ownedPendingCounts[ownedIndex]?.() ?? 0;
              events.push(`pending:${ownedIndex}:${count}`);
              return count;
            }),
          } as unknown as Locator;
        }),
      }) as unknown as Locator,
  );

  const attachmentTiles = {
    count: vi.fn(async () => (uploaded ? tileCountAfterUpload() : baselineTiles)),
    nth: vi.fn((index: number) => tileLocators[index] as Locator),
  } as unknown as Locator;

  const attachmentAlerts = {
    count: vi.fn(async () => (uploaded ? alertCountAfterUpload() : 0)),
  } as unknown as Locator;

  const attachmentInput = {
    setInputFiles: vi.fn(async (paths: string[]) => {
      events.push(`upload:${paths.join(',')}`);
      uploaded = true;
    }),
  } as unknown as Locator;

  const composer = {
    fill: vi.fn(async (text: string) => events.push(`fill:${text}`)),
  } as unknown as Locator;

  const send = {
    click: vi.fn(async () => events.push('click:send')),
  } as unknown as Locator;

  const page = {
    url: vi.fn(() => 'https://chatgpt.com/c/upload-test'),
  } as unknown as Page;

  const driver = createChatGptDriver({
    inspectCollection: async (_page, definition) => {
      if (definition.name === 'assistantTurns') {
        events.push('baseline:assistant');
        return {
          status: 'collection',
          candidateName: 'assistant-test',
          count: 3,
          locator: assistantTurns,
        };
      }
      if (definition.name === 'attachmentTiles') {
        events.push('baseline:tiles');
        return {
          status: 'collection',
          candidateName: 'attachment-tiles-test',
          count: baselineTiles,
          locator: attachmentTiles,
        };
      }
      if (definition.name === 'attachmentUploadAlerts') {
        events.push('baseline:alerts');
        return {
          status: 'collection',
          candidateName: 'attachment-alerts-test',
          count: 0,
          locator: attachmentAlerts,
        };
      }
      throw new Error(`Unexpected collection selector ${definition.name}`);
    },
    inspectUnique: async (_page, definition) =>
      definition.name === 'sendButton'
        ? { status: 'unique', candidateName: 'send-test', count: 1, locator: send }
        : { status: 'missing', count: 0 },
    resolveUnique: async (_page, definition) => {
      if (definition.name === 'attachmentInput') {
        return { locator: attachmentInput, candidateName: 'attachment-input-test' };
      }
      if (definition.name === 'composer') {
        return { locator: composer, candidateName: 'composer-test' };
      }
      if (definition.name === 'sendButton') {
        return { locator: send, candidateName: 'send-test' };
      }
      throw new Error(`Unexpected unique selector ${definition.name}`);
    },
    uploadNow: options.uploadNow,
    uploadSleep: options.uploadSleep,
    uploadTimeoutMs: options.uploadTimeoutMs,
    uploadPollIntervalMs: options.uploadPollIntervalMs,
    sendPollIntervalMs: 0,
    sendTimeoutMs: 10,
  } as Parameters<typeof createChatGptDriver>[0] & {
    uploadNow?: () => number;
    uploadSleep?: (ms: number) => Promise<void>;
    uploadTimeoutMs?: number;
    uploadPollIntervalMs?: number;
  });

  return { page, events, driver, send, attachmentInput };
}

const twoAttachments = [
  {
    localAttachmentId: 'attachment-1',
    kind: 'file' as const,
    path: '/tmp/request/a.txt',
    displayFilename: 'a.txt',
  },
  {
    localAttachmentId: 'attachment-2',
    kind: 'image' as const,
    path: '/tmp/request/b.png',
    displayFilename: 'b.png',
  },
];

describe('ChatGptDriver attachment upload ownership', () => {
  it('ignores baseline previews, waits exactly for owned tiles, and sends only after all owned uploads are ready', async () => {
    const { page, events, driver, send, attachmentInput } = uploadHarness({
      baselineTiles: 1,
      ownedPendingSequences: [
        [2, 0, 0],
        [2, 0, 0],
      ],
      uploadPollIntervalMs: 0,
    });

    await expect(
      driver.startText(page, {
        prompt: 'inspect attachments',
        attachments: twoAttachments,
      } as Parameters<typeof driver.startText>[1] & { attachments: typeof twoAttachments }),
    ).resolves.toBeDefined();

    expect(attachmentInput.setInputFiles).toHaveBeenCalledWith([
      '/tmp/request/a.txt',
      '/tmp/request/b.png',
    ]);
    expect(events).not.toContain('pending:0:existing');
    expect(events.indexOf('upload:/tmp/request/a.txt,/tmp/request/b.png')).toBeLessThan(
      events.indexOf('fill:inspect attachments'),
    );
    expect(events.indexOf('fill:inspect attachments')).toBeLessThan(events.indexOf('click:send'));
    expect(events.slice(0, 3)).toEqual(['baseline:assistant', 'baseline:tiles', 'baseline:alerts']);
    expect(send.click).toHaveBeenCalledTimes(1);
  });

  it('maps a new upload alert to chatgpt_upload_failed and never sends', async () => {
    const { page, driver, send } = uploadHarness({
      baselineTiles: 0,
      ownedPendingSequences: [[2, 2]],
      alertCountsAfterUpload: [1],
      uploadPollIntervalMs: 0,
    });

    await expect(
      driver.startText(page, {
        prompt: 'should not send',
        attachments: [twoAttachments[0]],
      } as Parameters<typeof driver.startText>[1] & {
        attachments: [(typeof twoAttachments)[0]];
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_upload_failed' });
    expect(send.click).not.toHaveBeenCalled();
  });

  it('times out when the exact owned previews never become ready', async () => {
    let now = 0;
    const { page, driver, send } = uploadHarness({
      baselineTiles: 0,
      ownedPendingSequences: [[2, 2, 2, 2]],
      uploadNow: () => now,
      uploadSleep: async (ms) => {
        now += ms;
      },
      uploadTimeoutMs: 200,
      uploadPollIntervalMs: 100,
    });

    await expect(
      driver.startText(page, {
        prompt: 'timeout',
        attachments: [twoAttachments[0]],
      } as Parameters<typeof driver.startText>[1] & {
        attachments: [(typeof twoAttachments)[0]];
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_upload_timeout' });
    expect(send.click).not.toHaveBeenCalled();
  });

  it('aborts during upload readiness without sending', async () => {
    const controller = new AbortController();
    let now = 0;
    const { page, driver, send } = uploadHarness({
      baselineTiles: 0,
      ownedPendingSequences: [[2]],
      uploadNow: () => now,
      uploadSleep: async (ms) => {
        now += ms;
        controller.abort();
      },
      uploadTimeoutMs: 1_000,
      uploadPollIntervalMs: 100,
    });

    await expect(
      driver.startText(page, {
        prompt: 'abort',
        signal: controller.signal,
        attachments: [twoAttachments[0]],
      } as Parameters<typeof driver.startText>[1] & {
        attachments: [(typeof twoAttachments)[0]];
      }),
    ).rejects.toMatchObject({ code: 'stream_aborted' });
    expect(send.click).not.toHaveBeenCalled();
  });

  it('fails ownership when more previews appear than were uploaded', async () => {
    const { page, driver, send } = uploadHarness({
      baselineTiles: 0,
      ownedPendingSequences: [[0]],
      tileCountsAfterUpload: [2],
      uploadPollIntervalMs: 0,
    });

    await expect(
      driver.startText(page, {
        prompt: 'ambiguous ownership',
        attachments: [twoAttachments[0]],
      } as Parameters<typeof driver.startText>[1] & {
        attachments: [(typeof twoAttachments)[0]];
      }),
    ).rejects.toMatchObject({ code: 'chatgpt_upload_failed' });
    expect(send.click).not.toHaveBeenCalled();
  });
});
