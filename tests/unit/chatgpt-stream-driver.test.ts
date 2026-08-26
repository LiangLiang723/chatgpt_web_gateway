import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { createChatGptDriver } from '../../src/chatgpt/driver.js';

function harness(
  options: {
    completed?: boolean;
    unsafeUrl?: boolean;
    initialUrl?: string;
    rateLimitModal?: 'missing' | 'visible' | 'ambiguous';
  } = {},
) {
  const events: string[] = [];
  let stopped = false;
  let currentUrl =
    options.initialUrl ??
    (options.unsafeUrl ? 'https://chatgpt.com/' : 'https://chatgpt.com/c/stream-thread?model=auto');
  let assistantText = 'streaming answer';
  let assistantContentCount = 1;
  const completionMarker = {
    count: vi.fn(async () => (options.completed || stopped ? 1 : 0)),
  } as unknown as Locator;
  const assistantContent = {
    count: vi.fn(async () => assistantContentCount),
    innerText: vi.fn(async () => assistantText),
  } as unknown as Locator;
  const assistantTurn = {
    innerText: vi.fn(async () => assistantText),
    locator: vi.fn((selector: string) =>
      selector === '.markdown' ? assistantContent : completionMarker,
    ),
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
  const rateLimitAcknowledge = {
    count: vi.fn(async () => 1),
    click: vi.fn(async () => events.push('click:rate-limit-got-it')),
  } as unknown as Locator;
  const rateLimitModal = {
    isVisible: vi.fn(async () => true),
    getByRole: vi.fn(() => rateLimitAcknowledge),
  } as unknown as Locator;
  const stop = {
    click: vi.fn(async () => {
      events.push('click:stop');
      stopped = true;
    }),
  } as unknown as Locator;
  const page = {
    url: vi.fn(() => currentUrl),
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
      if (definition.name === 'conversationHistoryRateLimitModal') {
        if (options.rateLimitModal === 'visible') {
          return {
            status: 'unique',
            candidateName: 'conversation-history-rate-limit-modal-testid',
            count: 1,
            locator: rateLimitModal,
          };
        }
        if (options.rateLimitModal === 'ambiguous') {
          return {
            status: 'ambiguous',
            candidateName: 'conversation-history-rate-limit-modal-testid',
            count: 2,
          };
        }
        return { status: 'missing', count: 0 };
      }
      if (definition.name === 'sendButton') {
        return { status: 'unique', candidateName: 'send-test', count: 1, locator: send };
      }
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
    sendPollIntervalMs: 0,
    sendTimeoutMs: 10,
  });

  return {
    page,
    driver,
    events,
    stop,
    setUrl(value: string) {
      currentUrl = value;
    },
    setAssistantText(value: string) {
      assistantText = value;
    },
    setAssistantContentCount(value: number) {
      assistantContentCount = value;
    },
  };
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

  it('acknowledges the known conversation-history rate-limit modal before clicking Send', async () => {
    const { page, driver, events } = harness({ rateLimitModal: 'visible' });

    await driver.startText(page, { prompt: 'hello' });

    expect(events).toEqual(['baseline', 'fill:hello', 'click:rate-limit-got-it', 'click:send']);
  });

  it('ignores a new Assistant placeholder until the owned turn exposes text content', async () => {
    const { page, driver, setAssistantText, setAssistantContentCount } = harness();
    const turn = await driver.startText(page, { prompt: 'hello' });

    setAssistantText('temporary');
    setAssistantContentCount(0);
    await expect(turn.observe()).resolves.toEqual({
      exists: false,
      text: '',
      completionMarkerPresent: false,
    });

    setAssistantText('stable answer');
    setAssistantContentCount(1);
    await expect(turn.observe()).resolves.toEqual({
      exists: true,
      text: 'stable answer',
      completionMarkerPresent: false,
    });
  });

  it('rejects multiple Assistant text content nodes instead of truncating structured UI to one node', async () => {
    const { page, driver, setAssistantContentCount } = harness();
    const turn = await driver.startText(page, { prompt: 'hello' });

    setAssistantContentCount(2);
    await expect(turn.observe()).rejects.toMatchObject({
      code: 'selector_ambiguous',
      selectorName: 'assistantTextContent',
      candidateName: 'assistant-markdown-content',
    });
  });

  it('ignores provisional Fresh Assistant content until ChatGPT establishes a stable Conversation URL', async () => {
    const { page, driver, setUrl, setAssistantText } = harness({
      initialUrl: 'https://chatgpt.com/',
    });
    const turn = await driver.startText(page, { prompt: 'hello' });

    setUrl('https://chatgpt.com/c/WEB:temporary-bootstrap');
    setAssistantText('temporary');
    await expect(turn.observe()).resolves.toEqual({
      exists: false,
      text: '',
      completionMarkerPresent: false,
    });

    setUrl('https://chatgpt.com/c/stable-thread');
    setAssistantText('stable answer');
    await expect(turn.observe()).resolves.toEqual({
      exists: true,
      text: 'stable answer',
      completionMarkerPresent: false,
    });
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
