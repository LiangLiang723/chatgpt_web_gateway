import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { createChatGptDriver } from '../../src/chatgpt/driver.js';

function harness(
  options: {
    completed?: boolean;
    unsafeUrl?: boolean;
    initialUrl?: string;
    rateLimitModal?: 'missing' | 'visible' | 'ambiguous' | 'appears-on-send' | 'appears-on-stop';
    connectionInterruptedStatus?: boolean;
    stopCompletesBeforeClick?: boolean;
    stopInitiallyVisible?: boolean;
    completionMarkerInitiallyVisible?: boolean;
    verificationCompletion?: boolean;
  } = {},
) {
  const events: string[] = [];
  let completed = options.completed ?? false;
  let stopped = false;
  let stopVisible = options.stopInitiallyVisible ?? true;
  let rateLimitVisible = options.rateLimitModal === 'visible';
  let sendAttempts = 0;
  let currentUrl =
    options.initialUrl ??
    (options.unsafeUrl ? 'https://chatgpt.com/' : 'https://chatgpt.com/c/stream-thread?model=auto');
  let completionNow = 0;
  let assistantText = 'streaming answer';
  let assistantContentCount = 1;
  const completionMarker = {
    count: vi.fn(async () =>
      options.completionMarkerInitiallyVisible || completed || stopped ? 1 : 0,
    ),
  } as unknown as Locator;
  const assistantContent = {
    count: vi.fn(async () => assistantContentCount),
    innerText: vi.fn(async () => assistantText),
  } as unknown as Locator;
  const allMarkdownContent = {
    count: vi.fn(async () => (options.connectionInterruptedStatus ? 2 : assistantContentCount)),
  } as unknown as Locator;
  const assistantTransientStatus = {
    count: vi.fn(async () => (options.connectionInterruptedStatus ? 1 : 0)),
  } as unknown as Locator;
  const assistantTurn = {
    innerText: vi.fn(async () => assistantText),
    locator: vi.fn((selector: string) => {
      if (selector === '.markdown.prose') return assistantContent;
      if (selector === '.markdown') return allMarkdownContent;
      if (selector === '.markdown:not(.prose)') return assistantTransientStatus;
      return completionMarker;
    }),
  } as unknown as Locator;
  const assistantTurns = {
    count: vi.fn(async () => 3),
    nth: vi.fn((index: number) => {
      events.push(`turn:${index}`);
      return assistantTurn;
    }),
  } as unknown as Locator;
  const verificationCompletionMarker = {
    count: vi.fn(async () => (options.verificationCompletion ? 1 : 0)),
  } as unknown as Locator;
  const verificationAssistantTurn = {
    locator: vi.fn((selector: string) => {
      if (selector === '.markdown.prose') return assistantContent;
      if (selector === '.markdown:not(.prose)') {
        return { count: vi.fn(async () => 0) } as unknown as Locator;
      }
      return verificationCompletionMarker;
    }),
  } as unknown as Locator;
  const verificationAssistantTurns = {
    count: vi.fn(async () => 3),
    nth: vi.fn(() => verificationAssistantTurn),
  } as unknown as Locator;
  const composer = {
    focus: vi.fn(async () => events.push('focus:composer')),
    fill: vi.fn(async (text: string) => events.push(`fill:${text}`)),
    evaluate: vi.fn(async (_callback: unknown, text: string) => events.push(`paste:${text}`)),
  } as unknown as Locator;
  const keyboard = {
    insertText: vi.fn(async (text: string) => events.push(`insertText:${text}`)),
  };
  const send = {
    click: vi.fn(async () => {
      sendAttempts += 1;
      if (options.rateLimitModal === 'appears-on-send' && sendAttempts === 1) {
        rateLimitVisible = true;
        events.push('click:send-blocked');
        throw new Error('conversation-history rate-limit modal intercepted Send');
      }
      events.push('click:send');
    }),
  } as unknown as Locator;
  const rateLimitAcknowledge = {
    count: vi.fn(async () => 1),
    click: vi.fn(async () => {
      events.push('click:rate-limit-got-it');
      rateLimitVisible = false;
    }),
  } as unknown as Locator;
  const rateLimitModal = {
    isVisible: vi.fn(async () => true),
    getByRole: vi.fn(() => rateLimitAcknowledge),
  } as unknown as Locator;
  let stopAttempts = 0;
  const stop = {
    click: vi.fn(async () => {
      stopAttempts += 1;
      if (options.rateLimitModal === 'appears-on-stop' && stopAttempts === 1) {
        rateLimitVisible = true;
        events.push('click:stop-blocked');
        throw new Error('conversation-history rate-limit modal intercepted Stop');
      }
      if (options.stopCompletesBeforeClick) {
        completed = true;
        events.push('click:stop-detached');
        throw new Error('Stop control detached before click');
      }
      events.push('click:stop');
      stopped = true;
    }),
  } as unknown as Locator;
  const verificationPage = {
    goto: vi.fn(async (url: string) => {
      events.push(`verify:goto:${url}`);
    }),
    url: vi.fn(() => currentUrl),
    close: vi.fn(async () => events.push('verify:close')),
  } as unknown as Page;
  const context = {
    newPage: vi.fn(async () => {
      events.push('verify:new-page');
      return verificationPage;
    }),
  };
  const page = {
    url: vi.fn(() => currentUrl),
    keyboard,
    context: vi.fn(() => context),
    reload: vi.fn(async () => {
      events.push('source:reload');
      stopVisible = false;
    }),
  } as unknown as Page;

  const driver = createChatGptDriver({
    probeAuth: async () => ({ state: 'authenticated' }),
    inspectCollection: async (_page, definition) => {
      if (definition.name !== 'assistantTurns') throw new Error('unexpected collection');
      if (_page === verificationPage) {
        return {
          status: 'collection',
          candidateName: 'verification-assistant-test',
          count: 3,
          locator: verificationAssistantTurns,
        };
      }
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
        if (options.rateLimitModal === 'ambiguous') {
          return {
            status: 'ambiguous',
            candidateName: 'conversation-history-rate-limit-modal-testid',
            count: 2,
          };
        }
        if (rateLimitVisible) {
          return {
            status: 'unique',
            candidateName: 'conversation-history-rate-limit-modal-testid',
            count: 1,
            locator: rateLimitModal,
          };
        }
        return { status: 'missing', count: 0 };
      }
      if (definition.name === 'sendButton') {
        return { status: 'unique', candidateName: 'send-test', count: 1, locator: send };
      }
      if (definition.name !== 'stopControl') return { status: 'missing', count: 0 };
      return stopped || completed || !stopVisible
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
    completionNow: () => completionNow,
    completionVerificationStableMs: 100,
    completionVerificationRetryMs: 1_000,
  });

  return {
    page,
    driver,
    events,
    stop,
    composer,
    keyboard,
    setUrl(value: string) {
      currentUrl = value;
    },
    setAssistantText(value: string) {
      assistantText = value;
    },
    setAssistantContentCount(value: number) {
      assistantContentCount = value;
    },
    setStopVisible(value: boolean) {
      stopVisible = value;
    },
    advanceCompletionTime(ms: number) {
      completionNow += ms;
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

    expect(events).toEqual([
      'baseline',
      'focus:composer',
      'insertText:hello',
      'click:send',
      'turn:2',
    ]);
  });

  it('pastes multiline Composer text as one ProseMirror transaction instead of using fill or multiline insertText', async () => {
    const { page, driver, composer, keyboard, events } = harness();
    const prompt = 'first line\nsecond line\nthird line';

    await driver.startText(page, { prompt });

    expect(composer.fill).not.toHaveBeenCalled();
    expect(composer.focus).toHaveBeenCalledTimes(1);
    expect(keyboard.insertText).not.toHaveBeenCalled();
    expect(composer.evaluate).toHaveBeenCalledTimes(1);
    expect(events).toContain(`paste:${prompt}`);
  });

  it('acknowledges the known conversation-history rate-limit modal before clicking Send', async () => {
    const { page, driver, events } = harness({ rateLimitModal: 'visible' });

    await driver.startText(page, { prompt: 'hello' });

    expect(events).toEqual([
      'baseline',
      'focus:composer',
      'insertText:hello',
      'click:rate-limit-got-it',
      'click:send',
    ]);
  });

  it('retries Send when the known conversation-history rate-limit modal appears during click', async () => {
    const { page, driver, events } = harness({ rateLimitModal: 'appears-on-send' });

    await driver.startText(page, { prompt: 'hello' });

    expect(events).toEqual([
      'baseline',
      'focus:composer',
      'insertText:hello',
      'click:send-blocked',
      'click:rate-limit-got-it',
      'click:send',
    ]);
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

  it('ignores a non-prose connection-interrupted status block beside authoritative Assistant Markdown', async () => {
    const { page, driver } = harness({ connectionInterruptedStatus: true });
    const turn = await driver.startText(page, { prompt: 'hello' });

    await expect(turn.observe()).resolves.toEqual({
      exists: true,
      text: 'streaming answer',
      completionMarkerPresent: false,
    });
  });

  it('resynchronizes the original Page when a target completion marker appears while Stop is still active', async () => {
    const { page, driver, events } = harness({ completionMarkerInitiallyVisible: true });
    const turn = await driver.startText(page, { prompt: 'hello' });

    await expect(turn.observe()).resolves.toEqual({
      exists: true,
      text: 'streaming answer',
      completionMarkerPresent: true,
    });
    expect(events).toContain('source:reload');
  });

  it('verifies a stalled generating Page and resynchronizes the original Page before reporting completion', async () => {
    const { page, driver, events, advanceCompletionTime } = harness({
      verificationCompletion: true,
    });
    const turn = await driver.startText(page, { prompt: 'hello' });

    await expect(turn.observe()).resolves.toMatchObject({ completionMarkerPresent: false });
    advanceCompletionTime(100);
    await expect(turn.observe()).resolves.toEqual({
      exists: true,
      text: 'streaming answer',
      completionMarkerPresent: true,
    });
    expect(events).toContain('verify:new-page');
    expect(events).toContain('verify:goto:https://chatgpt.com/c/stream-thread?model=auto');
    expect(events).toContain('source:reload');
    expect(events).toContain('verify:close');
  });

  it('does not run stalled-page verification while a non-prose Assistant status block is present', async () => {
    const { page, driver, events, advanceCompletionTime } = harness({
      connectionInterruptedStatus: true,
      verificationCompletion: true,
    });
    const turn = await driver.startText(page, { prompt: 'hello' });

    await expect(turn.observe()).resolves.toMatchObject({ completionMarkerPresent: false });
    advanceCompletionTime(500);
    await expect(turn.observe()).resolves.toMatchObject({ completionMarkerPresent: false });
    expect(events).not.toContain('verify:new-page');
  });

  it('does not verify a stalled Page when this request never observed a generating Stop control', async () => {
    const { page, driver, events, advanceCompletionTime } = harness({
      stopInitiallyVisible: false,
      verificationCompletion: true,
    });
    const turn = await driver.startText(page, { prompt: 'hello' });

    await expect(turn.observe()).resolves.toMatchObject({ completionMarkerPresent: false });
    advanceCompletionTime(500);
    await expect(turn.observe()).resolves.toMatchObject({ completionMarkerPresent: false });
    expect(events).not.toContain('verify:new-page');
  });

  it('rejects multiple authoritative Assistant text content nodes instead of truncating structured UI to one node', async () => {
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

  it('dismisses the known conversation-history rate-limit modal and retries Stop once', async () => {
    const { page, driver, events, stop } = harness({ rateLimitModal: 'appears-on-stop' });
    const turn = await driver.startText(page, { prompt: 'hello' });

    await expect(turn.stop()).resolves.toBe('stopped');
    expect(stop.click).toHaveBeenCalledTimes(2);
    expect(events).toContain('click:stop-blocked');
    expect(events).toContain('click:rate-limit-got-it');
    expect(events).toContain('click:stop');
  });

  it('returns already_complete when the owned turn completes while the Stop click is racing', async () => {
    const { page, driver, stop } = harness({ stopCompletesBeforeClick: true });
    const turn = await driver.startText(page, { prompt: 'hello' });

    await expect(turn.stop()).resolves.toBe('already_complete');
    expect(stop.click).toHaveBeenCalledTimes(1);
  });
});
