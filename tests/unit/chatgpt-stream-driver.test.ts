import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { createChatGptDriver } from '../../src/chatgpt/driver.js';

function harness(options: { completed?: boolean; unsafeUrl?: boolean } = {}) {
  const events: string[] = [];
  let stopped = false;
  const completionMarker = {
    count: vi.fn(async () => (options.completed || stopped ? 1 : 0)),
  } as unknown as Locator;
  const assistantTurn = {
    innerText: vi.fn(async () => 'streaming answer'),
    locator: vi.fn(() => completionMarker),
  } as unknown as Locator;
  const assistantTurns = {
    count: vi.fn(async () => 3),
    nth: vi.fn((index: number) => {
      events.push(`turn:${index}`);
      return assistantTurn;
    }),
  } as unknown as Locator;
  const composer = {
    fill: vi.fn(async (text: string) => events.push(`fill:${text}`)),
  } as unknown as Locator;
  const send = {
    click: vi.fn(async () => events.push('click:send')),
  } as unknown as Locator;
  const stop = {
    click: vi.fn(async () => {
      events.push('click:stop');
      stopped = true;
    }),
  } as unknown as Locator;
  const page = {
    url: vi.fn(() =>
      options.unsafeUrl ? 'https://chatgpt.com/' : 'https://chatgpt.com/c/stream-thread?model=auto',
    ),
  } as unknown as Page;

  const driver = createChatGptDriver({
    inspectCollection: async (_page, definition) => {
      if (definition.name !== 'assistantTurns') throw new Error('unexpected collection');
      events.push('baseline');
      return {
        status: 'collection',
        candidateName: 'assistant-test',
        count: 2,
        locator: assistantTurns,
      };
    },
    inspectUnique: async (_page, definition) => {
      if (definition.name !== 'stopControl') return { status: 'missing', count: 0 };
      return stopped
        ? { status: 'missing', count: 0 }
        : { status: 'unique', candidateName: 'stop-test', count: 1, locator: stop };
    },
    resolveUnique: async (_page, definition) => {
      if (definition.name === 'composer') {
        return { locator: composer, candidateName: 'composer-test' };
      }
      if (definition.name === 'sendButton') {
        return { locator: send, candidateName: 'send-test' };
      }
      throw new Error(`unexpected selector ${definition.name}`);
    },
    stopPollIntervalMs: 0,
    stopTimeoutMs: 10,
  });

  return { page, driver, events, stop };
}

describe('ChatGptTextTurn', () => {
  it('captures Assistant baseline before submit and observes only the owned target turn', async () => {
    const { page, driver, events } = harness();

    const turn = await driver.startText(page, { prompt: 'hello' });
    await expect(turn.observe()).resolves.toEqual({
      exists: true,
      text: 'streaming answer',
      completionMarkerPresent: false,
    });

    expect(events).toEqual(['baseline', 'fill:hello', 'click:send', 'turn:2']);
  });

  it('returns only a safe ChatGPT Conversation URL', async () => {
    const safe = harness();
    const safeTurn = await safe.driver.startText(safe.page, { prompt: 'hello' });
    await expect(safeTurn.conversationUrl()).resolves.toBe(
      'https://chatgpt.com/c/stream-thread?model=auto',
    );

    const unsafe = harness({ unsafeUrl: true });
    const unsafeTurn = await unsafe.driver.startText(unsafe.page, { prompt: 'hello' });
    await expect(unsafeTurn.conversationUrl()).rejects.toMatchObject({
      code: 'conversation_restore_failed',
    });
  });

  it('does not click Stop after the owned turn has already completed', async () => {
    const { page, driver, stop } = harness({ completed: true });
    const turn = await driver.startText(page, { prompt: 'hello' });

    await expect(turn.stop()).resolves.toBe('already_complete');
    expect(stop.click).not.toHaveBeenCalled();
  });

  it('clicks the unique Stop control once for an in-progress owned turn', async () => {
    const { page, driver, events, stop } = harness();
    const turn = await driver.startText(page, { prompt: 'hello' });

    await expect(turn.stop()).resolves.toBe('stopped');
    expect(stop.click).toHaveBeenCalledTimes(1);
    expect(events).toContain('click:stop');
  });
});
