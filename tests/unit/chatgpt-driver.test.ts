import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { createChatGptDriver } from '../../src/chatgpt/driver.js';

function fakePage(currentUrl = 'https://chatgpt.com/c/test-conversation') {
  const events: string[] = [];
  const page = {
    goto: vi.fn(async (url: string, options: unknown) => {
      events.push(`goto:${url}:${JSON.stringify(options)}`);
    }),
    url: vi.fn(() => currentUrl),
  } as unknown as Page;
  return { page, events };
}

function successfulHarness(currentUrl = 'https://chatgpt.com/c/test-conversation') {
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
    inspectUnique: async () => ({
      status: 'missing',
      count: 0,
    }),
    resolveUnique: async (_page, definition) => {
      if (definition.name === 'composer')
        return { locator: composer, candidateName: 'composer-test' };
      if (definition.name === 'sendButton') return { locator: send, candidateName: 'send-test' };
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

describe('ChatGptDriver', () => {
  it('uses a Fresh target, captures the assistant baseline, submits, and observes only the new turn', async () => {
    const { page, events, driver } = successfulHarness();

    await expect(
      driver.sendText(page, { prompt: 'hello', target: { kind: 'fresh' } }),
    ).resolves.toEqual({
      text: 'final answer',
      conversationUrl: 'https://chatgpt.com/c/test-conversation',
    });

    expect(page.goto).toHaveBeenCalledWith('https://chatgpt.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    expect(events).toEqual([
      'goto:https://chatgpt.com/:{"waitUntil":"domcontentloaded","timeout":60000}',
      'auth',
      'baseline',
      'fill:hello',
      'click:send',
      'completion',
      'turn:3',
    ]);
  });

  it('uses the current warm Conversation without navigation', async () => {
    const { page, events, driver } = successfulHarness(
      'https://chatgpt.com/c/test-conversation?model=auto#latest',
    );

    await expect(
      driver.sendText(page, {
        prompt: 'next',
        target: {
          kind: 'current',
          conversationUrl: 'https://chatgpt.com/c/test-conversation?temporary-chat=false',
        },
      }),
    ).resolves.toMatchObject({ text: 'final answer' });

    expect(page.goto).not.toHaveBeenCalled();
    expect(events[0]).toBe('auth');
  });

  it('restores a saved Conversation URL before submitting', async () => {
    const restoredUrl = 'https://chatgpt.com/c/test-conversation?model=auto';
    const { page, driver } = successfulHarness(
      'https://chatgpt.com/c/test-conversation#restored',
    );

    await driver.sendText(page, {
      prompt: 'next',
      target: { kind: 'restore', conversationUrl: restoredUrl },
    });

    expect(page.goto).toHaveBeenCalledWith(restoredUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
  });

  it('rejects a restore redirect that no longer identifies the saved Conversation', async () => {
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => 'https://chatgpt.com/'),
    } as unknown as Page;
    const probeAuth = vi.fn(async () => ({ state: 'authenticated' as const }));
    const driver = createChatGptDriver({ probeAuth });

    await expect(
      driver.sendText(page, {
        prompt: 'next',
        target: {
          kind: 'restore',
          conversationUrl: 'https://chatgpt.com/c/test-conversation',
        },
      }),
    ).rejects.toMatchObject({ code: 'conversation_restore_failed' });
    expect(probeAuth).not.toHaveBeenCalled();
  });

  it('rejects a current target when the Page has moved to another origin or Conversation', async () => {
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => 'https://example.com/c/test-conversation'),
    } as unknown as Page;
    const driver = createChatGptDriver({
      probeAuth: async () => ({ state: 'authenticated' }),
    });

    await expect(
      driver.sendText(page, {
        prompt: 'next',
        target: {
          kind: 'current',
          conversationUrl: 'https://chatgpt.com/c/test-conversation',
        },
      }),
    ).rejects.toMatchObject({ code: 'conversation_restore_failed' });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('maps Fresh navigation/runtime failures to browser_unavailable', async () => {
    const page = {
      goto: vi.fn(async () => {
        throw new Error('raw Playwright network detail');
      }),
    } as unknown as Page;
    const driver = createChatGptDriver();

    await expect(
      driver.sendText(page, { prompt: 'hello', target: { kind: 'fresh' } }),
    ).rejects.toMatchObject({
      code: 'browser_unavailable',
    });
  });

  it('maps explicit unauthenticated state to auth_required', async () => {
    const { page } = fakePage();
    const driver = createChatGptDriver({
      probeAuth: async () => ({ state: 'auth_required' }),
    });

    await expect(
      driver.sendText(page, { prompt: 'hello', target: { kind: 'fresh' } }),
    ).rejects.toMatchObject({
      code: 'auth_required',
    });
  });

  it('maps unknown auth state to selector_missing rather than auth_required', async () => {
    const { page } = fakePage();
    const driver = createChatGptDriver({
      probeAuth: async () => ({ state: 'unknown', reason: 'unknown-dom' }),
    });

    await expect(
      driver.sendText(page, { prompt: 'hello', target: { kind: 'fresh' } }),
    ).rejects.toMatchObject({
      code: 'selector_missing',
    });
  });
});
