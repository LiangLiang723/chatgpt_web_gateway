import type { Page } from 'playwright';

import { probeAuth } from './auth.js';
import {
  waitForAssistantCompletion,
  type WaitForAssistantCompletionOptions,
} from './completion.js';
import { asChatGptDriverError, ChatGptDriverError } from './errors.js';
import { inspectCollection, inspectUnique, resolveUnique } from './selector-registry.js';
import { chatGptSelectors } from './selectors.js';

export interface ChatGptTextRequest {
  prompt: string;
}

export interface ChatGptTextResult {
  text: string;
  conversationUrl: string;
}

export interface ChatGptDriver {
  sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult>;
}

export interface CreateChatGptDriverOptions {
  probeAuth?: typeof probeAuth;
  inspectCollection?: typeof inspectCollection;
  inspectUnique?: typeof inspectUnique;
  resolveUnique?: typeof resolveUnique;
  waitForAssistantCompletion?: (options: WaitForAssistantCompletionOptions) => Promise<string>;
  navigationTimeoutMs?: number;
}

export function createChatGptDriver(options: CreateChatGptDriverOptions = {}): ChatGptDriver {
  const authProbe = options.probeAuth ?? probeAuth;
  const inspectCollectionSelector = options.inspectCollection ?? inspectCollection;
  const inspectUniqueSelector = options.inspectUnique ?? inspectUnique;
  const resolveUniqueSelector = options.resolveUnique ?? resolveUnique;
  const waitForCompletion = options.waitForAssistantCompletion ?? waitForAssistantCompletion;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;

  return {
    async sendText(page, request) {
      try {
        await page.goto('https://chatgpt.com/', {
          waitUntil: 'domcontentloaded',
          timeout: navigationTimeoutMs,
        });

        const auth = await authProbe(page);
        if (auth.state === 'auth_required') {
          throw new ChatGptDriverError({
            code: 'auth_required',
            message: 'ChatGPT authentication is required',
          });
        }
        if (auth.state !== 'authenticated') {
          throw new ChatGptDriverError({
            code: 'selector_missing',
            message: 'Unable to determine authenticated ChatGPT composer state',
            selectorName: chatGptSelectors.composer.name,
          });
        }

        const assistantTurns = await inspectCollectionSelector(
          page,
          chatGptSelectors.assistantTurns,
        );
        const baseline = assistantTurns.count;
        const composer = await resolveUniqueSelector(page, chatGptSelectors.composer);
        await composer.locator.fill(request.prompt);
        const sendButton = await resolveUniqueSelector(page, chatGptSelectors.sendButton);
        await sendButton.locator.click();

        const text = await waitForCompletion({
          observe: async () => {
            const count = await assistantTurns.locator.count();
            if (count <= baseline) return { exists: false, generating: false, text: '' };

            const turn = assistantTurns.locator.nth(baseline);
            const stopControl = await inspectUniqueSelector(page, chatGptSelectors.stopControl);
            if (stopControl.status === 'ambiguous') {
              throw new ChatGptDriverError({
                code: 'selector_ambiguous',
                message: 'ChatGPT stop control is ambiguous',
                selectorName: chatGptSelectors.stopControl.name,
                candidateName: stopControl.candidateName,
              });
            }
            const thinking = await inspectCollectionSelector(
              page,
              chatGptSelectors.thinkingIndicators,
            );
            return {
              exists: true,
              generating: stopControl.status === 'unique' || thinking.count > 0,
              text: await turn.innerText(),
            };
          },
        });

        return { text, conversationUrl: page.url() };
      } catch (error) {
        throw asChatGptDriverError(error);
      }
    },
  };
}
