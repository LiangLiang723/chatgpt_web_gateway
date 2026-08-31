import { Buffer } from 'node:buffer';

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
  const keyboard = {
    insertText: vi.fn(async (text: string) => events.push(`insertText:${text}`)),
  };
  const page = {
    goto: vi.fn(async (url: string, options: unknown) => {
      events.push(`goto:${url}:${JSON.stringify(options)}`);
      currentUrl = redirectAfterGoto ?? url;
    }),
    reload: vi.fn(async (options: unknown) => {
      events.push(`reload:${JSON.stringify(options)}`);
    }),
    url: vi.fn(() => currentUrl),
    keyboard,
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
  redirectAfterAuth?: string;
  authState?: 'authenticated' | 'auth_required' | 'unknown';
  restoreHistory?: {
    userCounts: number[];
    assistantCounts: number[];
  };
}) {
  const { page, events, setUrl } = fakePage(options.initialUrl, options.redirectAfterGoto);
  const userCounts = [...(options.restoreHistory?.userCounts ?? [1, 1])];
  const assistantCounts = [...(options.restoreHistory?.assistantCounts ?? [1, 1])];
  const restoredAssistantTurn = {
    locator: vi.fn((selector: string) =>
      selector.includes('copy-turn-action-button')
        ? ({ count: async () => 1 } as unknown as Locator)
        : ({ count: async () => 0 } as unknown as Locator),
    ),
  } as unknown as Locator;
  const restoredAssistantTurns = {
    nth: vi.fn(() => restoredAssistantTurn),
  } as unknown as Locator;
  const driver = createChatGptDriver({
    probeAuth: async () => {
      events.push('auth');
      if (options.redirectAfterAuth) setUrl(options.redirectAfterAuth);
      if (options.authState === 'auth_required') return { state: 'auth_required' };
      if (options.authState === 'unknown') return { state: 'unknown', reason: 'unknown-dom' };
      return { state: 'authenticated' };
    },
    inspectCollection: async (_page, definition) => {
      if (definition.name === 'userTurns') {
        const count = userCounts.length > 1 ? userCounts.shift()! : (userCounts[0] ?? 0);
        events.push(`restore:user:${count}`);
        return {
          status: 'collection',
          candidateName: 'user-test',
          count,
          locator: { count: async () => count } as unknown as Locator,
        };
      }
      if (definition.name === 'assistantTurns') {
        const count =
          assistantCounts.length > 1 ? assistantCounts.shift()! : (assistantCounts[0] ?? 0);
        events.push(`restore:assistant:${count}`);
        return {
          status: 'collection',
          candidateName: 'assistant-test',
          count,
          locator: restoredAssistantTurns,
        };
      }
      throw new Error(`Unexpected collection selector ${definition.name}`);
    },
    restorePollIntervalMs: 0,
    restoreTimeoutMs: 50,
  });
  return { page, events, driver };
}

function successfulSendHarness(
  currentUrl = 'https://chatgpt.com/c/test-conversation',
  options: {
    completionMarkerCount?: number;
    stopControlStatus?: 'missing' | 'unique';
    expectedGenerating?: boolean;
    finalUrlAfterCompletion?: string;
    postCompletionSendStatuses?: Array<'missing' | 'unique'>;
    sendResolveFails?: boolean;
    composerResolveMissingAttempts?: number;
  } = {},
) {
  const { page, events, setUrl } = fakePage(currentUrl);
  const composer = {
    focus: vi.fn(async () => events.push('focus:composer')),
    fill: vi.fn(async (text: string) => events.push(`fill:${text}`)),
  } as unknown as Locator;
  const send = {
    click: vi.fn(async () => events.push('click:send')),
  } as unknown as Locator;
  const assistantTurnCompletion = {
    count: vi.fn(async () => options.completionMarkerCount ?? 1),
  } as unknown as Locator;
  const assistantTextContent = {
    count: vi.fn(async () => 1),
    innerText: vi.fn(async () => 'final answer'),
  } as unknown as Locator;
  const assistantTurn = {
    innerText: vi.fn(async () => 'final answer'),
    locator: vi.fn((selector: string) =>
      selector === '.markdown.prose' ? assistantTextContent : assistantTurnCompletion,
    ),
  } as unknown as Locator;
  const assistantTurns = {
    count: vi.fn(async () => 4),
    nth: vi.fn((index: number) => {
      events.push(`turn:${index}`);
      return assistantTurn;
    }),
  } as unknown as Locator;
  let composerResolveMissingAttempts = options.composerResolveMissingAttempts ?? 0;
  const trackComposerResolution = options.composerResolveMissingAttempts !== undefined;
  let remainingStaleStopChecks = options.stopControlStatus === 'unique' ? 1 : 0;

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
    inspectUnique: async (_page, definition) => {
      if (definition.name === 'sendButton') {
        const status = options.postCompletionSendStatuses?.shift() ?? 'unique';
        events.push(`inspect:send:${status}`);
        return status === 'unique'
          ? {
              status: 'unique',
              candidateName: 'send-test',
              count: 1,
              locator: send,
            }
          : { status: 'missing', count: 0 };
      }
      if (definition.name === 'stopControl' && remainingStaleStopChecks > 0) {
        remainingStaleStopChecks -= 1;
        return {
          status: 'unique',
          candidateName: 'stop-test',
          count: 1,
          locator: { count: async () => 1 } as unknown as Locator,
        };
      }
      return { status: 'missing', count: 0 };
    },
    resolveUnique: async (_page, definition) => {
      if (definition.name === 'composer') {
        if (composerResolveMissingAttempts > 0) {
          composerResolveMissingAttempts -= 1;
          if (trackComposerResolution) events.push('resolve:composer:missing');
          throw new ChatGptDriverError({
            code: 'selector_missing',
            message: 'Composer is temporarily not mounted',
            selectorName: 'composer',
          });
        }
        if (trackComposerResolution) events.push('resolve:composer:unique');
        return { locator: composer, candidateName: 'composer-test' };
      }
      if (definition.name === 'sendButton') {
        if (options.sendResolveFails) {
          throw new ChatGptDriverError({
            code: 'selector_missing',
            message: 'Send button is not mounted yet',
            selectorName: 'sendButton',
          });
        }
        return { locator: send, candidateName: 'send-test' };
      }
      throw new Error(`Unexpected selector ${definition.name}`);
    },
    stopPollIntervalMs: 1,
    stopTimeoutMs: 50,
    sendPollIntervalMs: 1,
    sendTimeoutMs: 5,
    waitForAssistantCompletion: async (completionOptions) => {
      events.push('completion');
      const observation = await completionOptions.observe();
      expect(observation).toEqual({
        exists: true,
        generating: options.expectedGenerating ?? false,
        text: 'final answer',
      });
      if (options.finalUrlAfterCompletion) setUrl(options.finalUrlAfterCompletion);
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

  it('openConversation navigates a different Page and waits for restored history after Composer readiness', async () => {
    const { page, events, driver } = readinessDriver({
      initialUrl: 'https://chatgpt.com/c/other',
      restoreHistory: {
        userCounts: [0, 2, 2],
        assistantCounts: [0, 2, 2],
      },
    });
    const saved = 'https://chatgpt.com/c/thread-1?model=auto';

    await expect(driver.openConversation(page, saved)).resolves.toBe('restored');

    expect(page.goto).toHaveBeenCalledWith(saved, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    expect(events).toEqual([
      expect.stringContaining('goto:https://chatgpt.com/c/thread-1?model=auto:'),
      'auth',
      'restore:user:0',
      'restore:assistant:0',
      'restore:user:2',
      'restore:assistant:2',
      'restore:user:2',
      'restore:assistant:2',
    ]);
  });

  it('returns not_restorable when navigation redirects after authenticated Composer readiness', async () => {
    const { page, driver } = readinessDriver({
      initialUrl: 'https://chatgpt.com/c/other',
      redirectAfterAuth: 'https://chatgpt.com/',
    });

    await expect(driver.openConversation(page, 'https://chatgpt.com/c/thread-1')).resolves.toBe(
      'not_restorable',
    );
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

    await expect(driver.openConversation(page, 'https://chatgpt.com/c/thread-1')).resolves.toBe(
      'not_restorable',
    );
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

    await expect(
      driver.openConversation(page, 'https://chatgpt.com/c/thread-1'),
    ).rejects.toMatchObject({
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
      'focus:composer',
      'insertText:hello',
      'inspect:send:unique',
      'click:send',
      'completion',
      'turn:3',
    ]);
  });

  it('does not require an empty Composer to expose Send after the target turn is complete', async () => {
    const { page, events, driver } = successfulSendHarness(
      'https://chatgpt.com/c/test-conversation',
      {
        postCompletionSendStatuses: ['unique', 'missing', 'missing', 'missing'],
      },
    );

    await expect(driver.sendText(page, { prompt: 'hello' })).resolves.toMatchObject({
      text: 'final answer',
    });

    expect(events.filter((event) => event.startsWith('inspect:send:'))).toEqual([
      'inspect:send:unique',
    ]);
  });

  it('keeps safe page and prompt metrics with the raw cause for an unknown Composer failure', async () => {
    const prompt = 'SECRET_SYSTEM_PROMPT\nwith tools';
    const raw = new Error('locator.focus: Target page changed while focusing');
    const composer = {
      focus: vi.fn(async () => {
        throw raw;
      }),
    } as unknown as Locator;
    const page = {
      url: vi.fn(() => 'https://chatgpt.com/c/diag-thread'),
      title: vi.fn(async () => 'ChatGPT - diagnostic thread'),
      isClosed: vi.fn(() => false),
      evaluate: vi.fn(async () => 'interactive'),
      keyboard: { insertText: vi.fn() },
    } as unknown as Page;
    const driver = createChatGptDriver({
      inspectCollection: async () => ({
        status: 'collection',
        candidateName: 'assistant-test',
        count: 0,
        locator: { count: async () => 0 } as unknown as Locator,
      }),
      resolveUnique: async (_page, definition) => {
        if (definition.name === 'composer') {
          return { locator: composer, candidateName: 'composer-test' };
        }
        throw new Error(`Unexpected selector ${definition.name}`);
      },
    });

    let failure: unknown;
    try {
      await driver.sendText(page, { prompt });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ChatGptDriverError);
    expect(failure).toMatchObject({
      code: 'browser_unavailable',
      cause: raw,
      diagnostics: {
        operation: 'startText',
        page: {
          url: 'https://chatgpt.com/c/diag-thread',
          title: 'ChatGPT - diagnostic thread',
          documentReadyState: 'interactive',
          closed: false,
        },
        prompt: {
          characters: prompt.length,
          utf8Bytes: Buffer.byteLength(prompt),
          lines: 2,
        },
      },
    });
    expect(JSON.stringify((failure as ChatGptDriverError).diagnostics)).not.toContain(
      'SECRET_SYSTEM_PROMPT',
    );
  });

  it('waits for a transiently unmounted Composer between retained-page turns', async () => {
    const { page, events, driver } = successfulSendHarness(
      'https://chatgpt.com/c/test-conversation',
      { composerResolveMissingAttempts: 2 },
    );

    await expect(driver.sendText(page, { prompt: 'hello' })).resolves.toMatchObject({
      text: 'final answer',
    });
    expect(events.filter((event) => event.startsWith('resolve:composer:'))).toEqual([
      'resolve:composer:missing',
      'resolve:composer:missing',
      'resolve:composer:unique',
    ]);
  });

  it('waits for the Send control to appear after Composer input instead of failing a transient fresh-page race', async () => {
    const { page, events, driver } = successfulSendHarness(
      'https://chatgpt.com/c/test-conversation',
      {
        sendResolveFails: true,
        postCompletionSendStatuses: ['missing', 'missing', 'unique', 'unique'],
      },
    );

    await expect(driver.sendText(page, { prompt: 'hello' })).resolves.toMatchObject({
      text: 'final answer',
    });
    expect(events.filter((event) => event.startsWith('inspect:send:'))).toEqual([
      'inspect:send:missing',
      'inspect:send:missing',
      'inspect:send:unique',
    ]);
  });

  it('resynchronizes a completed target turn when a stale global Stop control remains', async () => {
    const { page, driver, events } = successfulSendHarness(
      'https://chatgpt.com/c/test-conversation',
      {
        completionMarkerCount: 1,
        stopControlStatus: 'unique',
      },
    );

    await expect(driver.sendText(page, { prompt: 'hello' })).resolves.toMatchObject({
      text: 'final answer',
    });
    expect(events).toContain('reload:{"waitUntil":"domcontentloaded","timeout":60000}');
  });

  it('keeps observing until the target Assistant turn exposes its completion marker', async () => {
    const { page, driver } = successfulSendHarness('https://chatgpt.com/c/test-conversation', {
      completionMarkerCount: 0,
      stopControlStatus: 'missing',
      expectedGenerating: true,
    });

    await expect(driver.sendText(page, { prompt: 'hello' })).resolves.toMatchObject({
      text: 'final answer',
    });
  });

  it('rejects an unsafe final URL instead of returning it for persistence', async () => {
    const { page, driver } = successfulSendHarness('https://chatgpt.com/c/test-conversation', {
      finalUrlAfterCompletion: 'https://chatgpt.com/',
    });

    await expect(driver.sendText(page, { prompt: 'hello' })).rejects.toMatchObject({
      code: 'conversation_restore_failed',
    });
  });
});
