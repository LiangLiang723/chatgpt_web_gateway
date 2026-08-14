import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { createChatGptDriver } from '../../src/chatgpt/driver.js';

function fakePage() {
  const events: string[] = [];
  const page = {
    goto: vi.fn(async (_url: string, options: unknown) => {
      events.push(`goto:${JSON.stringify(options)}`);
    }),
    url: vi.fn(() => 'https://chatgpt.com/c/test-conversation'),
  } as unknown as Page;
  return { page, events };
}

describe('ChatGptDriver', () => {
  it('navigates, captures the assistant baseline, submits, and observes only the new turn', async () => {
    const { page, events } = fakePage();
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
      inspectUnique: async (_page, definition) => ({
        status: 'missing',
        count: 0,
        ...(definition.name === 'stopControl' ? {} : {}),
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

    await expect(driver.sendText(page, { prompt: 'hello' })).resolves.toEqual({
      text: 'final answer',
      conversationUrl: 'https://chatgpt.com/c/test-conversation',
    });

    expect(page.goto).toHaveBeenCalledWith('https://chatgpt.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    expect(events).toEqual([
      'goto:{"waitUntil":"domcontentloaded","timeout":60000}',
      'auth',
      'baseline',
      'fill:hello',
      'click:send',
      'completion',
      'turn:3',
    ]);
  });

  it('maps explicit unauthenticated state to auth_required', async () => {
    const { page } = fakePage();
    const driver = createChatGptDriver({
      probeAuth: async () => ({ state: 'auth_required' }),
    });

    await expect(driver.sendText(page, { prompt: 'hello' })).rejects.toMatchObject({
      code: 'auth_required',
    });
  });

  it('maps unknown auth state to selector_missing rather than auth_required', async () => {
    const { page } = fakePage();
    const driver = createChatGptDriver({
      probeAuth: async () => ({ state: 'unknown', reason: 'unknown-dom' }),
    });

    await expect(driver.sendText(page, { prompt: 'hello' })).rejects.toMatchObject({
      code: 'selector_missing',
    });
  });
});
