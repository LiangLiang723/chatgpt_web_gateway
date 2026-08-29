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

export const loginIndicatorSelector: SelectorDefinition<'collection'> = {
  name: 'loginIndicator',
  cardinality: 'collection',
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

export const generatedImagesSelector: SelectorDefinition<'collection'> = {
  name: 'generatedImages',
  cardinality: 'collection',
  candidates: [
    {
      name: 'conversation-turn-images',
      locate: (page) => page.locator('section[data-testid^="conversation-turn-"] img'),
    },
  ],
};

export const assistantTextContentSelector = {
  name: 'assistantTextContent',
  candidateName: 'assistant-markdown-content',
  locate: (assistantTurn: Locator): Locator => assistantTurn.locator('.markdown.prose'),
} as const;

export const assistantTurnCompletionSelector = {
  name: 'assistantTurnCompletion',
  candidateName: 'copy-turn-action-button',
  locate: (assistantTurn: Locator): Locator =>
    assistantTurn.locator(
      'xpath=ancestor::section[@data-turn="assistant"][1]//*[@data-testid="copy-turn-action-button"]',
    ),
} as const;

export const assistantTransientStatusSelector = {
  name: 'assistantTransientStatus',
  candidateName: 'assistant-non-prose-markdown-status',
  locate: (assistantTurn: Locator): Locator => assistantTurn.locator('.markdown:not(.prose)'),
} as const;

export const conversationHistoryRateLimitModalSelector: SelectorDefinition<'unique'> = {
  name: 'conversationHistoryRateLimitModal',
  cardinality: 'unique',
  candidates: [
    {
      name: 'conversation-history-rate-limit-modal-testid',
      locate: (page) => page.locator('[data-testid="modal-conversation-history-rate-limit"]'),
    },
  ],
};

export const conversationHistoryRateLimitAcknowledgeSelector = {
  name: 'conversationHistoryRateLimitAcknowledge',
  candidateName: 'got-it-button-role',
  locate: (modal: Locator): Locator => modal.getByRole('button', { name: 'Got it', exact: true }),
} as const;

export const attachmentFileInputsSelector: SelectorDefinition<'collection'> = {
  name: 'attachmentFileInputs',
  cardinality: 'collection',
  candidates: [
    {
      name: 'all-file-inputs',
      locate: (page) => page.locator('input[type="file"]'),
    },
  ],
};

export const attachmentDiagnosticControlsSelector: SelectorDefinition<'collection'> = {
  name: 'attachmentDiagnosticControls',
  cardinality: 'collection',
  candidates: [
    {
      name: 'attachment-diagnostic-controls',
      locate: (page) => page.locator('button, [role="button"], [data-testid]'),
    },
  ],
};

export const attachmentDiagnosticStatesSelector: SelectorDefinition<'collection'> = {
  name: 'attachmentDiagnosticStates',
  cardinality: 'collection',
  candidates: [
    {
      name: 'attachment-diagnostic-states',
      locate: (page) =>
        page.locator('[data-testid], [data-state], [data-status], [aria-busy], [aria-invalid]'),
    },
  ],
};

export const attachmentInputSelector: SelectorDefinition<'unique'> = {
  name: 'attachmentInput',
  cardinality: 'unique',
  candidates: [
    {
      name: 'generic-file-input-without-accept',
      locate: (page) => page.locator('input[type="file"]:not([accept])'),
    },
  ],
};

export const attachmentTilesSelector: SelectorDefinition<'collection'> = {
  name: 'attachmentTiles',
  cardinality: 'collection',
  candidates: [
    {
      name: 'file-tile-remove-control',
      locate: (page) => page.locator('[role="group"]:has(button[aria-label^="Remove file "])'),
    },
  ],
};

export const attachmentUploadAlertsSelector: SelectorDefinition<'collection'> = {
  name: 'attachmentUploadAlerts',
  cardinality: 'collection',
  candidates: [
    {
      name: 'role-alert',
      locate: (page) => page.locator('[role="alert"]'),
    },
  ],
};

export const attachmentTilePendingSelector = {
  name: 'attachmentTilePending',
  candidateName: 'cursor-wait-or-progress-circle',
  locate: (tile: Locator): Locator => tile.locator('button.cursor-wait, circle'),
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
  generatedImages: generatedImagesSelector,
  assistantTextContent: assistantTextContentSelector,
  assistantTurnCompletion: assistantTurnCompletionSelector,
  assistantTransientStatus: assistantTransientStatusSelector,
  conversationHistoryRateLimitModal: conversationHistoryRateLimitModalSelector,
  conversationHistoryRateLimitAcknowledge: conversationHistoryRateLimitAcknowledgeSelector,
  attachmentFileInputs: attachmentFileInputsSelector,
  attachmentDiagnosticControls: attachmentDiagnosticControlsSelector,
  attachmentDiagnosticStates: attachmentDiagnosticStatesSelector,
  attachmentInput: attachmentInputSelector,
  attachmentTiles: attachmentTilesSelector,
  attachmentUploadAlerts: attachmentUploadAlertsSelector,
  attachmentTilePending: attachmentTilePendingSelector,
  stopControl: stopControlSelector,
  thinkingIndicators: thinkingIndicatorsSelector,
} as const;
