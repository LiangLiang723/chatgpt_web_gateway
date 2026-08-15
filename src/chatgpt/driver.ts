import type { Page } from 'playwright';

import { probeAuth } from './auth.js';
import {
  waitForAssistantCompletion,
  type WaitForAssistantCompletionOptions,
} from './completion.js';
import { parseSafeChatGptConversationUrl } from './conversation-url.js';
import { asChatGptDriverError, ChatGptDriverError } from './errors.js';
import { inspectCollection, inspectUnique, resolveUnique } from './selector-registry.js';
import { chatGptSelectors } from './selectors.js';

export type ChatGptTextTarget =
  | { kind: 'fresh' }
  | { kind: 'current'; conversationUrl: string }
  | { kind: 'restore'; conversationUrl: string };

export interface ChatGptTextRequest {
  prompt: string;
  /** @deprecated Navigation is performed by openFresh/openConversation; retained until legacy executor removal. */
  target?: ChatGptTextTarget;
}

export interface ChatGptTextResult {
  text: string;
  conversationUrl: string;
}

export interface ChatGptTextDriver {
  openFresh(page: Page): Promise<void>;
  openConversation(page: Page, conversationUrl: string): Promise<'restored' | 'not_restorable'>;
  sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult>;
}

export type ChatGptDriver = ChatGptTextDriver;

export interface CreateChatGptDriverOptions {
  probeAuth?: typeof probeAuth;
  inspectCollection?: typeof inspectCollection;
  inspectUnique?: typeof inspectUnique;
  resolveUnique?: typeof resolveUnique;
  waitForAssistantCompletion?: (options: WaitForAssistantCompletionOptions) => Promise<string>;
  navigationTimeoutMs?: number;
}

export function createChatGptDriver(options: CreateChatGptDriverOptions = {}): ChatGptTextDriver {
  const authProbe = options.probeAuth ?? probeAuth;
  const inspectCollectionSelector = options.inspectCollection ?? inspectCollection;
  const inspectUniqueSelector = options.inspectUnique ?? inspectUnique;
  const resolveUniqueSelector = options.resolveUnique ?? resolveUnique;
  const waitForCompletion = options.waitForAssistantCompletion ?? waitForAssistantCompletion;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;

  const ensureReady = async (page: Page): Promise<void> => {
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
  };

  return {
    async openFresh(page) {
      try {
        await page.goto('https://chatgpt.com/', {
          waitUntil: 'domcontentloaded',
          timeout: navigationTimeoutMs,
        });
        await ensureReady(page);
      } catch (error) {
        throw asChatGptDriverError(error);
      }
    },

    async openConversation(page, conversationUrl) {
      try {
        const expected = parseSafeChatGptConversationUrl(conversationUrl);
        if (!expected) return 'not_restorable';

        const current = parseSafeChatGptConversationUrl(page.url());
        if (current?.pathname !== expected.pathname) {
          await page.goto(expected.href, {
            waitUntil: 'domcontentloaded',
            timeout: navigationTimeoutMs,
          });
        }

        const restored = parseSafeChatGptConversationUrl(page.url());
        if (!restored || restored.pathname !== expected.pathname) return 'not_restorable';

        await ensureReady(page);
        return 'restored';
      } catch (error) {
        throw asChatGptDriverError(error);
      }
    },

    async sendText(page, request) {
      try {
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

        const conversationUrl = parseSafeChatGptConversationUrl(page.url());
        if (!conversationUrl) {
          throw new ChatGptDriverError({
            code: 'conversation_restore_failed',
            message: 'ChatGPT did not produce a safe Conversation URL',
          });
        }

        return { text, conversationUrl: conversationUrl.href };
      } catch (error) {
        throw asChatGptDriverError(error);
      }
    },
  };
}
