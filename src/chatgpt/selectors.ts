import type { Locator } from 'playwright';

import type { SelectorDefinition } from './selector-registry.js';

export const composerSelector: SelectorDefinition<'unique'> = {
  name: 'composer',
  cardinality: 'unique',
  candidates: [
    {
      name: 'prompt-textarea-id',
      locate: (page) => page.locator('#prompt-textarea'),
    },
    {
      name: 'message-textbox-role',
      locate: (page) => page.getByRole('textbox', { name: /message|prompt/i }),
    },
  ],
};

export const sendButtonSelector: SelectorDefinition<'unique'> = {
  name: 'sendButton',
  cardinality: 'unique',
  candidates: [
    {
      name: 'send-button-testid',
      locate: (page) => page.locator('[data-testid="send-button"]'),
    },
    {
      name: 'send-button-role',
      locate: (page) => page.getByRole('button', { name: /^send/i }),
    },
  ],
};

export const loginIndicatorSelector: SelectorDefinition<'unique'> = {
  name: 'loginIndicator',
  cardinality: 'unique',
  candidates: [
    {
      name: 'login-button-role',
      locate: (page) => page.getByRole('button', { name: /log in|sign in/i }),
    },
    {
      name: 'login-link-role',
      locate: (page) => page.getByRole('link', { name: /log in|sign in/i }),
    },
  ],
};

export const assistantTurnsSelector: SelectorDefinition<'collection'> = {
  name: 'assistantTurns',
  cardinality: 'collection',
  candidates: [
    {
      name: 'assistant-author-role',
      locate: (page) => page.locator('[data-message-author-role="assistant"]'),
    },
  ],
};

export const userTurnsSelector: SelectorDefinition<'collection'> = {
  name: 'userTurns',
  cardinality: 'collection',
  candidates: [
    {
      name: 'user-author-role',
      locate: (page) => page.locator('[data-message-author-role="user"]'),
    },
  ],
};

export const assistantTurnCompletionSelector = {
  name: 'assistantTurnCompletion',
  candidateName: 'copy-turn-action-button',
  locate: (assistantTurn: Locator): Locator =>
    assistantTurn.locator(
      'xpath=ancestor::section[@data-turn="assistant"][1]//*[@data-testid="copy-turn-action-button"]',
    ),
} as const;

export const stopControlSelector: SelectorDefinition<'unique'> = {
  name: 'stopControl',
  cardinality: 'unique',
  candidates: [
    {
      name: 'stop-button-testid',
      locate: (page) => page.locator('[data-testid="stop-button"]'),
    },
    {
      name: 'stop-button-role',
      locate: (page) => page.getByRole('button', { name: /^stop/i }),
    },
  ],
};

export const thinkingIndicatorsSelector: SelectorDefinition<'collection'> = {
  name: 'thinkingIndicators',
  cardinality: 'collection',
  candidates: [
    {
      name: 'thinking-searching-testid',
      locate: (page) => page.locator('[data-testid*="thinking"], [data-testid*="searching"]'),
    },
  ],
};

export const chatGptSelectors = {
  composer: composerSelector,
  sendButton: sendButtonSelector,
  loginIndicator: loginIndicatorSelector,
  assistantTurns: assistantTurnsSelector,
  userTurns: userTurnsSelector,
  assistantTurnCompletion: assistantTurnCompletionSelector,
  stopControl: stopControlSelector,
  thinkingIndicators: thinkingIndicatorsSelector,
} as const;
