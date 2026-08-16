import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { createChatGptDriver } from '../../src/chatgpt/driver.js';

describe('ChatGPT streaming submit cancellation', () => {
  it('does not fill or click Send when the request signal is already aborted', async () => {
    const composer = { fill: vi.fn(async () => {}) } as unknown as Locator;
    const send = { click: vi.fn(async () => {}) } as unknown as Locator;
    const assistantTurns = {
      count: vi.fn(async () => 0),
      nth: vi.fn(),
    } as unknown as Locator;
    const driver = createChatGptDriver({
      inspectCollection: async () => ({
        status: 'collection',
        candidateName: 'assistant-test',
        count: 0,
        locator: assistantTurns,
      }),
      resolveUnique: async (_page, definition) => {
        if (definition.name === 'composer') {
          return { locator: composer, candidateName: 'composer-test' };
        }
        if (definition.name === 'sendButton') {
          return { locator: send, candidateName: 'send-test' };
        }
        throw new Error(`unexpected selector ${definition.name}`);
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      driver.startText({} as Page, { prompt: 'hello', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'stream_aborted' });

    expect(composer.fill).not.toHaveBeenCalled();
    expect(send.click).not.toHaveBeenCalled();
  });
});
