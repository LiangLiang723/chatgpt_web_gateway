import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { createChatGptDriver } from '../../src/chatgpt/driver.js';
import { ChatGptDriverError } from '../../src/chatgpt/errors.js';

function fakePage(
  initialUrl = 'https://chatgpt.com/c/test-conversation',
  redirectAfterGoto?: string,
) {
  let currentUrl = initialUrl;
  const events: string[] = [];
  const page = {
    goto: vi.fn(async (url: string, options: unknown) => {
      events.push(`goto:${url}:${JSON.stringify(options)}`);
      currentUrl = redirectAfterGoto ?? url;
    }),
    url: vi.fn(() => currentUrl),
  } as unknown as Page;
  return {
    page,
    events,
    setUrl(value: string) {
      currentUrl = value;
    },
  };
}

function readinessDriver(options: {
  initialUrl?: string;
  redirectAfterGoto?: string;
  authState?: 'authenticated' | 'auth_required' | 'unknown';
}) {
  const { page, events } = fakePage(options.initialUrl, options.redirectAfterGoto);
  const driver = createChatGptDriver({
    probeAuth: async () => {
      events.push('auth');
      if (options.authState === 'auth_required') return { state: 'auth_required' };
      if (options.authState === 'unknown') return { state: 'unknown', reason: 'unknown-dom' };
      return { state: 'authenticated' };
    },
  });
  return { page, events, driver };
}

function successfulSendHarness(currentUrl = 'https://chatgpt.com/c/test-conversation') {
  const { page, events } = fakePage(currentUrl);
  const composer = {
    fill: vi.fn(async (text: string) => events.push(`fill:${text}`)),
  } as unknown as Locator;
  const send = {
    click: vi.fn(async () => events.push('click:send')),
  } as unknown as Locator;
  const assistantTurn = {
    innerText: vi.fn(async () => 'final answer'),
  } as unknown as Locator;
  const assistantTurns = {
    count: vi.fn(async () => 4),
    nth: vi.fn((index: number) => {
      events.push(`turn:${index}`);
      return assistantTurn;
    }),
  } as unknown as Locator;

  const driver = createChatGptDriver({
    probeAuth: async () => {
      events.push('auth');
      return { state: 'authenticated' };
    },
    inspectCollection: async (_page, definition) => {
      if (definition.name === 'assistantTurns') {
        events.push('baseline');
        return {
          status: 'collection',
          candidateName: 'assistant-test',
          count: 3,
          locator: assistantTurns,
        };
      }
      return {
        status: 'collection',
        candidateName: 'state-test',
        count: 0,
        locator: { count: async () => 0 } as unknown as Locator,
      };
    },
    inspectUnique: async () => ({ status: 'missing', count: 0 }),
    resolveUnique: async (_page, definition) => {
      if (definition.name === 'composer') {
        return { locator: composer, candidateName: 'composer-test' };
      }
      if (definition.name === 'sendButton') {
        return { locator: send, candidateName: 'send-test' };
      }
      throw new Error(`Unexpected selector ${definition.name}`);
    },
    waitForAssistantCompletion: async (options) => {
      events.push('completion');
      const observation = await options.observe();
      expect(observation).toEqual({ exists: true, generating: false, text: 'final answer' });
      return 'final answer';
    },
  });

  return { page, events, driver };
}

describe('ChatGptDriver navigation readiness', () => {
  it('openFresh navigates to root and probes authenticated composer readiness', async () => {
    const { page, events, driver } = readinessDriver({
      initialUrl: 'https://chatgpt.com/c/old',
    });

    await expect(driver.openFresh(page)).resolves.toBeUndefined();

    expect(page.goto).toHaveBeenCalledWith('https://chatgpt.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    expect(events).toEqual([
      'goto:https://chatgpt.com/:{"waitUntil":"domcontentloaded","timeout":60000}',
      'auth',
    ]);
  });

  it('openConversation short-circuits navigation for the same canonical pathname but probes readiness', async () => {
    const { page, events, driver } = readinessDriver({
      initialUrl: 'https://chatgpt.com/c/thread-1?model=auto#current',
    });

    await expect(
      driver.openConversation(page, 'https://chatgpt.com/c/thread-1?temporary-chat=false#stored'),
    ).resolves.toBe('restored');

    expect(page.goto).not.toHaveBeenCalled();
    expect(events).toEqual(['auth']);
  });

  it('openConversation navigates a different Page to the validated saved URL', async () => {
    const { page, events, driver } = readinessDriver({
      initialUrl: 'https://chatgpt.com/c/other',
    });
    const saved = 'https://chatgpt.com/c/thread-1?model=auto';

    await expect(driver.openConversation(page, saved)).resolves.toBe('restored');

    expect(page.goto).toHaveBeenCalledWith(saved, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    expect(events.at(-1)).toBe('auth');
  });

  it.each([
    'https://chatgpt.com/',
    'https://example.com/c/thread-1',
    'http://chatgpt.com/c/thread-1',
    'not-a-url',
  ])('returns not_restorable for unsafe saved URL without navigating: %s', async (saved) => {
    const { page, events, driver } = readinessDriver({});

    await expect(driver.openConversation(page, saved)).resolves.toBe('not_restorable');
    expect(page.goto).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('returns not_restorable when restore is redirected to ChatGPT root', async () => {
    const { page, events, driver } = readinessDriver({
      initialUrl: 'https://chatgpt.com/c/other',
      redirectAfterGoto: 'https://chatgpt.com/',
    });

    await expect(
      driver.openConversation(page, 'https://chatgpt.com/c/thread-1'),
    ).resolves.toBe('not_restorable');
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('goto:https://chatgpt.com/c/thread-1:');
  });

  it('keeps auth_required as an error rather than not_restorable', async () => {
    const { page, driver } = readinessDriver({
      initialUrl: 'https://chatgpt.com/c/thread-1',
      authState: 'auth_required',
    });

    await expect(
      driver.openConversation(page, 'https://chatgpt.com/c/thread-1'),
    ).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('keeps selector errors as errors rather than not_restorable', async () => {
    const { page } = fakePage('https://chatgpt.com/c/thread-1');
    const driver = createChatGptDriver({
      probeAuth: async () => {
        throw new ChatGptDriverError({
          code: 'selector_ambiguous',
          message: 'ambiguous',
          selectorName: 'composer',
        });
      },
    });

    await expect(
      driver.openConversation(page, 'https://chatgpt.com/c/thread-1'),
    ).rejects.toMatchObject({ code: 'selector_ambiguous' });
  });

  it('maps navigation runtime failures to browser_unavailable', async () => {
    const page = {
      goto: vi.fn(async () => {
        throw new Error('raw Playwright network detail');
      }),
      url: vi.fn(() => 'https://chatgpt.com/c/other'),
    } as unknown as Page;
    const driver = createChatGptDriver();

    await expect(driver.openConversation(page, 'https://chatgpt.com/c/thread-1')).rejects.toMatchObject({
      code: 'browser_unavailable',
    });
  });

  it('maps unknown readiness state to selector_missing', async () => {
    const { page, driver } = readinessDriver({ authState: 'unknown' });

    await expect(driver.openFresh(page)).rejects.toMatchObject({ code: 'selector_missing' });
  });
});

describe('ChatGptDriver sendText', () => {
  it('never navigates, captures the assistant baseline, submits, and observes only the new turn', async () => {
    const { page, events, driver } = successfulSendHarness(
      'https://chatgpt.com/c/test-conversation?model=auto#latest',
    );

    await expect(driver.sendText(page, { prompt: 'hello' })).resolves.toEqual({
      text: 'final answer',
      conversationUrl: 'https://chatgpt.com/c/test-conversation?model=auto#latest',
    });

    expect(page.goto).not.toHaveBeenCalled();
    expect(events).toEqual([
      'baseline',
      'fill:hello',
      'click:send',
      'completion',
      'turn:3',
    ]);
  });

  it('rejects an unsafe final URL instead of returning it for persistence', async () => {
    const { page, driver } = successfulSendHarness('https://chatgpt.com/');

    await expect(driver.sendText(page, { prompt: 'hello' })).rejects.toMatchObject({
      code: 'conversation_restore_failed',
    });
  });
});
