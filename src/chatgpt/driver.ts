import type { Page } from 'playwright';

import { TextStreamAbortedError } from '../stream/errors.js';
import type { AssistantSnapshot } from '../stream/types.js';
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
  signal?: AbortSignal;
  /** @deprecated Navigation is performed by openFresh/openConversation; retained until legacy executor removal. */
  target?: ChatGptTextTarget;
}

export interface ChatGptTextResult {
  text: string;
  conversationUrl: string;
}

export interface ChatGptTextTurn {
  observe(): Promise<AssistantSnapshot>;
  stop(): Promise<'stopped' | 'already_complete'>;
  conversationUrl(): Promise<string>;
}

export interface ChatGptTextDriver {
  openFresh(page: Page): Promise<void>;
  openConversation(page: Page, conversationUrl: string): Promise<'restored' | 'not_restorable'>;
  sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult>;
}

export interface ChatGptStreamingTextDriver extends ChatGptTextDriver {
  startText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextTurn>;
}

export type ChatGptDriver = ChatGptTextDriver;

export interface CreateChatGptDriverOptions {
  probeAuth?: typeof probeAuth;
  inspectCollection?: typeof inspectCollection;
  inspectUnique?: typeof inspectUnique;
  resolveUnique?: typeof resolveUnique;
  waitForAssistantCompletion?: (options: WaitForAssistantCompletionOptions) => Promise<string>;
  navigationTimeoutMs?: number;
  stopPollIntervalMs?: number;
  stopTimeoutMs?: number;
}

export function createChatGptDriver(
  options: CreateChatGptDriverOptions = {},
): ChatGptStreamingTextDriver {
  const authProbe = options.probeAuth ?? probeAuth;
  const inspectCollectionSelector = options.inspectCollection ?? inspectCollection;
  const inspectUniqueSelector = options.inspectUnique ?? inspectUnique;
  const resolveUniqueSelector = options.resolveUnique ?? resolveUnique;
  const waitForCompletion = options.waitForAssistantCompletion ?? waitForAssistantCompletion;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;
  const stopPollIntervalMs = options.stopPollIntervalMs ?? 100;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;

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

  const dismissConversationHistoryRateLimitModal = async (page: Page): Promise<void> => {
    const modal = await inspectUniqueSelector(
      page,
      chatGptSelectors.conversationHistoryRateLimitModal,
    );
    if (modal.status === 'missing') return;
    if (modal.status === 'ambiguous') {
      throw new ChatGptDriverError({
        code: 'selector_ambiguous',
        message: 'ChatGPT conversation-history rate-limit modal is ambiguous',
        selectorName: chatGptSelectors.conversationHistoryRateLimitModal.name,
        candidateName: modal.candidateName,
      });
    }
    if (!(await modal.locator.isVisible())) return;

    const acknowledge = chatGptSelectors.conversationHistoryRateLimitAcknowledge.locate(
      modal.locator,
    );
    const acknowledgeCount = await acknowledge.count();
    if (acknowledgeCount === 0) {
      throw new ChatGptDriverError({
        code: 'selector_missing',
        message: 'ChatGPT conversation-history rate-limit acknowledgement is missing',
        selectorName: chatGptSelectors.conversationHistoryRateLimitAcknowledge.name,
        candidateName: chatGptSelectors.conversationHistoryRateLimitAcknowledge.candidateName,
      });
    }
    if (acknowledgeCount > 1) {
      throw new ChatGptDriverError({
        code: 'selector_ambiguous',
        message: 'ChatGPT conversation-history rate-limit acknowledgement is ambiguous',
        selectorName: chatGptSelectors.conversationHistoryRateLimitAcknowledge.name,
        candidateName: chatGptSelectors.conversationHistoryRateLimitAcknowledge.candidateName,
      });
    }
    await acknowledge.click();
  };

  const readConversationUrl = (page: Page): string => {
    const conversationUrl = parseSafeChatGptConversationUrl(page.url());
    if (!conversationUrl) {
      throw new ChatGptDriverError({
        code: 'conversation_restore_failed',
        message: 'ChatGPT did not produce a safe Conversation URL',
      });
    }
    return conversationUrl.href;
  };

  const startText = async (page: Page, request: ChatGptTextRequest): Promise<ChatGptTextTurn> => {
    const throwIfAborted = () => {
      if (request.signal?.aborted) throw new TextStreamAbortedError();
    };

    try {
      throwIfAborted();
      let waitingForStableConversationRoute =
        parseSafeChatGptConversationUrl(page.url()) === undefined;
      const assistantTurns = await inspectCollectionSelector(page, chatGptSelectors.assistantTurns);
      throwIfAborted();
      const baseline = assistantTurns.count;
      const composer = await resolveUniqueSelector(page, chatGptSelectors.composer);
      throwIfAborted();
      await composer.locator.fill(request.prompt);
      throwIfAborted();
      await dismissConversationHistoryRateLimitModal(page);
      throwIfAborted();
      const sendButton = await resolveUniqueSelector(page, chatGptSelectors.sendButton);
      throwIfAborted();
      await sendButton.locator.click();

      const observe = async (): Promise<AssistantSnapshot> => {
        if (waitingForStableConversationRoute) {
          if (!parseSafeChatGptConversationUrl(page.url())) {
            return { exists: false, text: '', completionMarkerPresent: false };
          }
          waitingForStableConversationRoute = false;
        }

        const count = await assistantTurns.locator.count();
        if (count <= baseline) {
          return { exists: false, text: '', completionMarkerPresent: false };
        }

        const turn = assistantTurns.locator.nth(baseline);
        const textContent = chatGptSelectors.assistantTextContent.locate(turn);
        const textContentCount = await textContent.count();
        if (textContentCount === 0) {
          return { exists: false, text: '', completionMarkerPresent: false };
        }
        if (textContentCount > 1) {
          throw new ChatGptDriverError({
            code: 'selector_ambiguous',
            message: 'ChatGPT Assistant text content is ambiguous',
            selectorName: chatGptSelectors.assistantTextContent.name,
            candidateName: chatGptSelectors.assistantTextContent.candidateName,
          });
        }

        const completionMarker = chatGptSelectors.assistantTurnCompletion.locate(turn);
        const completionMarkerCount = await completionMarker.count();
        if (completionMarkerCount > 1) {
          throw new ChatGptDriverError({
            code: 'selector_ambiguous',
            message: 'ChatGPT Assistant turn completion marker is ambiguous',
            selectorName: chatGptSelectors.assistantTurnCompletion.name,
            candidateName: chatGptSelectors.assistantTurnCompletion.candidateName,
          });
        }

        return {
          exists: true,
          text: await textContent.innerText(),
          completionMarkerPresent: completionMarkerCount === 1,
        };
      };

      const stop = async (): Promise<'stopped' | 'already_complete'> => {
        const current = await observe();
        if (current.exists && current.completionMarkerPresent) return 'already_complete';

        const stopControl = await inspectUniqueSelector(page, chatGptSelectors.stopControl);
        if (stopControl.status === 'ambiguous') {
          throw new ChatGptDriverError({
            code: 'selector_ambiguous',
            message: 'ChatGPT stop control is ambiguous',
            selectorName: chatGptSelectors.stopControl.name,
            candidateName: stopControl.candidateName,
          });
        }
        if (stopControl.status !== 'unique') {
          throw new ChatGptDriverError({
            code: 'selector_missing',
            message: 'ChatGPT stop control is unavailable for cancellation',
            selectorName: chatGptSelectors.stopControl.name,
          });
        }

        await stopControl.locator.click();
        const startedAt = Date.now();
        while (Date.now() - startedAt <= stopTimeoutMs) {
          const observation = await observe();
          if (observation.exists && observation.completionMarkerPresent) return 'stopped';
          const remainingStopControl = await inspectUniqueSelector(
            page,
            chatGptSelectors.stopControl,
          );
          if (remainingStopControl.status === 'missing') return 'stopped';
          if (remainingStopControl.status === 'ambiguous') {
            throw new ChatGptDriverError({
              code: 'selector_ambiguous',
              message: 'ChatGPT stop control is ambiguous after cancellation',
              selectorName: chatGptSelectors.stopControl.name,
              candidateName: remainingStopControl.candidateName,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, stopPollIntervalMs));
        }
        throw new ChatGptDriverError({
          code: 'chatgpt_generation_timeout',
          message: 'ChatGPT generation did not stop before the cancellation timeout',
        });
      };

      return {
        observe,
        stop,
        conversationUrl: async () => readConversationUrl(page),
      };
    } catch (error) {
      if (error instanceof TextStreamAbortedError) throw error;
      throw asChatGptDriverError(error);
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

    startText,

    async sendText(page, request) {
      try {
        const turn = await startText(page, request);
        const text = await waitForCompletion({
          observe: async () => {
            const observation = await turn.observe();
            return {
              exists: observation.exists,
              generating: observation.exists && !observation.completionMarkerPresent,
              text: observation.text,
            };
          },
        });
        return { text, conversationUrl: await turn.conversationUrl() };
      } catch (error) {
        if (error instanceof TextStreamAbortedError) throw error;
        throw asChatGptDriverError(error);
      }
    },
  };
}
