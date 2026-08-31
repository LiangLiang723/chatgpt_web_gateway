import { Buffer } from 'node:buffer';

import type { Locator, Page } from 'playwright';

import { TextStreamAbortedError } from '../stream/errors.js';
import type { AssistantSnapshot } from '../stream/types.js';
import { probeAuth } from './auth.js';
import { enterComposerPrompt } from './composer-input.js';
import {
  waitForAssistantFinalSnapshot,
  type WaitForAssistantCompletionOptions,
} from './completion.js';
import {
  parseSafeChatGptConversationUrl,
  type SafeChatGptConversationUrl,
} from './conversation-url.js';
import { ChatGptDriverError, type ChatGptDriverDiagnostics } from './errors.js';
import {
  inspectCollection,
  inspectUnique,
  resolveUnique,
  type SelectorDefinition,
} from './selector-registry.js';
import { chatGptSelectors } from './selectors.js';

export type ChatGptTextTarget =
  | { kind: 'fresh' }
  | { kind: 'current'; conversationUrl: string }
  | { kind: 'restore'; conversationUrl: string };

export interface ChatGptPreparedUpload {
  localAttachmentId: string;
  kind: 'image' | 'file';
  path: string;
  displayFilename: string;
}

export interface ChatGptTextRequest {
  prompt: string;
  signal?: AbortSignal;
  attachments?: readonly ChatGptPreparedUpload[];
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
  waitForAssistantFinalSnapshot?: (options: WaitForAssistantCompletionOptions) => Promise<string>;
  navigationTimeoutMs?: number;
  stopPollIntervalMs?: number;
  stopTimeoutMs?: number;
  sendPollIntervalMs?: number;
  sendTimeoutMs?: number;
  restorePollIntervalMs?: number;
  restoreTimeoutMs?: number;
  restoreStableSamples?: number;
  uploadPollIntervalMs?: number;
  uploadTimeoutMs?: number;
  uploadNow?: () => number;
  uploadSleep?: (ms: number) => Promise<void>;
  completionNow?: () => number;
  completionVerificationStableMs?: number;
  completionVerificationRetryMs?: number;
  completionVerificationPageTimeoutMs?: number;
}

function promptDiagnostics(prompt: string): NonNullable<ChatGptDriverDiagnostics['prompt']> {
  return {
    characters: prompt.length,
    utf8Bytes: Buffer.byteLength(prompt),
    lines: prompt.split(/\r\n|\n|\r/).length,
  };
}

async function capturePageDiagnostics(
  page: Page,
): Promise<NonNullable<ChatGptDriverDiagnostics['page']>> {
  const runtimePage = page as Page & {
    isClosed?: () => boolean;
    title?: () => Promise<string>;
    evaluate?: <T>(callback: () => T) => Promise<T>;
  };
  let closed = false;
  try {
    closed = runtimePage.isClosed?.() ?? false;
  } catch {
    // Keep the conservative default when Page state cannot be read.
  }

  let url: string | undefined;
  try {
    url = page.url();
  } catch {
    url = undefined;
  }

  let title: string | undefined;
  let documentReadyState: string | undefined;
  if (!closed) {
    try {
      title = await runtimePage.title?.();
    } catch {
      title = undefined;
    }
    try {
      documentReadyState = await runtimePage.evaluate?.(() => document.readyState);
    } catch {
      documentReadyState = undefined;
    }
  }

  return {
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    ...(documentReadyState === undefined ? {} : { documentReadyState }),
    closed,
  };
}

async function asChatGptDriverErrorWithDiagnostics(options: {
  error: unknown;
  page: Page;
  operation: string;
  prompt?: string;
  message?: string;
}): Promise<ChatGptDriverError> {
  if (options.error instanceof ChatGptDriverError) return options.error;
  return new ChatGptDriverError({
    code: 'browser_unavailable',
    message: options.message ?? 'ChatGPT page operation failed',
    cause: options.error,
    diagnostics: {
      operation: options.operation,
      page: await capturePageDiagnostics(options.page),
      ...(options.prompt === undefined ? {} : { prompt: promptDiagnostics(options.prompt) }),
    },
  });
}

export function createChatGptDriver(
  options: CreateChatGptDriverOptions = {},
): ChatGptStreamingTextDriver {
  const authProbe = options.probeAuth ?? probeAuth;
  const inspectCollectionSelector = options.inspectCollection ?? inspectCollection;
  const inspectUniqueSelector = options.inspectUnique ?? inspectUnique;
  const resolveUniqueSelector = options.resolveUnique ?? resolveUnique;
  const waitForFinalSnapshot =
    options.waitForAssistantFinalSnapshot ??
    options.waitForAssistantCompletion ??
    waitForAssistantFinalSnapshot;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 60_000;
  const stopPollIntervalMs = options.stopPollIntervalMs ?? 100;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const sendPollIntervalMs = options.sendPollIntervalMs ?? 100;
  const sendTimeoutMs = options.sendTimeoutMs ?? 5_000;
  const restorePollIntervalMs = options.restorePollIntervalMs ?? 100;
  const restoreTimeoutMs = options.restoreTimeoutMs ?? 15_000;
  const restoreStableSamples = options.restoreStableSamples ?? 2;
  const uploadPollIntervalMs = options.uploadPollIntervalMs ?? 100;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? 60_000;
  const uploadNow = options.uploadNow ?? Date.now;
  const uploadSleep =
    options.uploadSleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const completionNow = options.completionNow ?? Date.now;
  const completionVerificationStableMs = options.completionVerificationStableMs ?? 5_000;
  const completionVerificationRetryMs = options.completionVerificationRetryMs ?? 30_000;
  const completionVerificationPageTimeoutMs = options.completionVerificationPageTimeoutMs ?? 15_000;

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

  const waitForRequiredControl = async (
    page: Page,
    definition: SelectorDefinition<'unique'>,
    context: string,
  ): Promise<Locator> => {
    const startedAt = Date.now();
    let lastMissing: ChatGptDriverError | undefined;
    while (Date.now() - startedAt <= sendTimeoutMs) {
      try {
        return (await resolveUniqueSelector(page, definition)).locator;
      } catch (error) {
        if (
          !(error instanceof ChatGptDriverError) ||
          error.code !== 'selector_missing' ||
          error.selectorName !== definition.name
        ) {
          throw error;
        }
        lastMissing = error;
      }
      await new Promise((resolve) => setTimeout(resolve, sendPollIntervalMs));
    }
    throw new ChatGptDriverError({
      code: 'selector_missing',
      message: `ChatGPT ${definition.name} did not appear ${context}`,
      selectorName: definition.name,
      cause: lastMissing,
    });
  };

  const waitForSendControl = async (page: Page, context: string): Promise<Locator> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= sendTimeoutMs) {
      const sendControl = await inspectUniqueSelector(page, chatGptSelectors.sendButton);
      if (sendControl.status === 'unique') return sendControl.locator;
      if (sendControl.status === 'ambiguous') {
        throw new ChatGptDriverError({
          code: 'selector_ambiguous',
          message: `ChatGPT send control is ambiguous ${context}`,
          selectorName: chatGptSelectors.sendButton.name,
          candidateName: sendControl.candidateName,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, sendPollIntervalMs));
    }
    throw new ChatGptDriverError({
      code: 'selector_missing',
      message: `ChatGPT send control did not appear ${context}`,
      selectorName: chatGptSelectors.sendButton.name,
    });
  };

  const dismissConversationHistoryRateLimitModal = async (page: Page): Promise<boolean> => {
    const modal = await inspectUniqueSelector(
      page,
      chatGptSelectors.conversationHistoryRateLimitModal,
    );
    if (modal.status === 'missing') return false;
    if (modal.status === 'ambiguous') {
      throw new ChatGptDriverError({
        code: 'selector_ambiguous',
        message: 'ChatGPT conversation-history rate-limit modal is ambiguous',
        selectorName: chatGptSelectors.conversationHistoryRateLimitModal.name,
        candidateName: modal.candidateName,
      });
    }
    if (!(await modal.locator.isVisible())) return false;

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
    return true;
  };

  const clickSendControl = async (
    page: Page,
    context: string,
    throwIfAborted: () => void,
  ): Promise<void> => {
    const click = async (): Promise<void> => {
      const sendButton = await waitForSendControl(page, context);
      throwIfAborted();
      await sendButton.click({ timeout: sendTimeoutMs });
    };

    try {
      await click();
    } catch (error) {
      throwIfAborted();
      const dismissed = await dismissConversationHistoryRateLimitModal(page);
      if (!dismissed) throw error;
      throwIfAborted();
      await click();
    }
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

  const inspectOwnedAttachmentState = async (options: {
    tiles: Awaited<ReturnType<typeof inspectCollection>>;
    alerts: Awaited<ReturnType<typeof inspectCollection>>;
    baselineTiles: number;
    baselineAlerts: number;
    expectedOwned: number;
    throwIfAborted: () => void;
  }): Promise<'pending' | 'ready'> => {
    const alertCount = await options.alerts.locator.count();
    options.throwIfAborted();
    if (alertCount > options.baselineAlerts) {
      throw new ChatGptDriverError({
        code: 'chatgpt_upload_failed',
        message: 'ChatGPT reported an attachment upload error',
        selectorName: chatGptSelectors.attachmentUploadAlerts.name,
      });
    }

    const tileCount = await options.tiles.locator.count();
    options.throwIfAborted();
    const expectedTotal = options.baselineTiles + options.expectedOwned;
    if (tileCount < options.baselineTiles || tileCount > expectedTotal) {
      throw new ChatGptDriverError({
        code: 'chatgpt_upload_failed',
        message: 'ChatGPT attachment preview ownership changed unexpectedly',
        selectorName: chatGptSelectors.attachmentTiles.name,
      });
    }
    if (tileCount < expectedTotal) return 'pending';

    for (let index = options.baselineTiles; index < expectedTotal; index += 1) {
      const tile = options.tiles.locator.nth(index);
      const pending = chatGptSelectors.attachmentTilePending.locate(tile);
      const pendingCount = await pending.count();
      options.throwIfAborted();
      if (pendingCount > 0) return 'pending';
    }
    return 'ready';
  };

  const waitForRestoredConversationHydration = async (
    page: Page,
    expectedConversationUrl: SafeChatGptConversationUrl,
  ): Promise<boolean> => {
    const startedAt = Date.now();
    let stableSignature: string | undefined;
    let stableSamples = 0;

    while (Date.now() - startedAt <= restoreTimeoutMs) {
      const current = parseSafeChatGptConversationUrl(page.url());
      if (!current || current.pathname !== expectedConversationUrl.pathname) return false;

      const userTurns = await inspectCollectionSelector(page, chatGptSelectors.userTurns);
      const assistantTurns = await inspectCollectionSelector(page, chatGptSelectors.assistantTurns);
      let readySignature: string | undefined;

      if (
        userTurns.count > 0 &&
        assistantTurns.count > 0 &&
        userTurns.count === assistantTurns.count
      ) {
        const lastAssistantTurn = assistantTurns.locator.nth(assistantTurns.count - 1);
        const completionMarker = chatGptSelectors.assistantTurnCompletion.locate(lastAssistantTurn);
        const completionMarkerCount = await completionMarker.count();
        if (completionMarkerCount > 1) {
          throw new ChatGptDriverError({
            code: 'selector_ambiguous',
            message: 'Restored ChatGPT Assistant completion marker is ambiguous',
            selectorName: chatGptSelectors.assistantTurnCompletion.name,
            candidateName: chatGptSelectors.assistantTurnCompletion.candidateName,
          });
        }
        const transientStatus = chatGptSelectors.assistantTransientStatus.locate(lastAssistantTurn);
        if (completionMarkerCount === 1 && (await transientStatus.count()) === 0) {
          readySignature = `${userTurns.count}:${assistantTurns.count}`;
        }
      }

      if (readySignature !== undefined) {
        if (readySignature === stableSignature) {
          stableSamples += 1;
        } else {
          stableSignature = readySignature;
          stableSamples = 1;
        }
        if (stableSamples >= restoreStableSamples) return true;
      } else {
        stableSignature = undefined;
        stableSamples = 0;
      }

      await new Promise((resolve) => setTimeout(resolve, restorePollIntervalMs));
    }

    return false;
  };

  const waitForAttachmentsReady = async (options: {
    tiles: Awaited<ReturnType<typeof inspectCollection>>;
    alerts: Awaited<ReturnType<typeof inspectCollection>>;
    baselineTiles: number;
    baselineAlerts: number;
    expectedOwned: number;
    throwIfAborted: () => void;
  }): Promise<void> => {
    const startedAt = uploadNow();
    while (true) {
      const state = await inspectOwnedAttachmentState(options);
      if (state === 'ready') return;
      if (uploadNow() - startedAt >= uploadTimeoutMs) {
        throw new ChatGptDriverError({
          code: 'chatgpt_upload_timeout',
          message: 'ChatGPT attachment upload did not become ready before the timeout',
          selectorName: chatGptSelectors.attachmentTiles.name,
        });
      }
      await uploadSleep(uploadPollIntervalMs);
      options.throwIfAborted();
    }
  };

  const resynchronizeCompletedSourcePage = async (options: {
    sourcePage: Page;
    conversationUrl: string;
    throwIfAborted: () => void;
  }): Promise<boolean> => {
    const expected = parseSafeChatGptConversationUrl(options.conversationUrl);
    if (!expected) return false;
    await options.sourcePage.reload({
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeoutMs,
    });
    options.throwIfAborted();
    const resynced = parseSafeChatGptConversationUrl(options.sourcePage.url());
    if (!resynced || resynced.pathname !== expected.pathname) return false;
    await ensureReady(options.sourcePage);
    options.throwIfAborted();
    await waitForRequiredControl(
      options.sourcePage,
      chatGptSelectors.composer,
      'after completed Conversation reload',
    );
    options.throwIfAborted();
    const remainingStop = await inspectUniqueSelector(
      options.sourcePage,
      chatGptSelectors.stopControl,
    );
    return remainingStop.status === 'missing';
  };

  const verifyCompletedConversation = async (options: {
    sourcePage: Page;
    conversationUrl: string;
    baseline: number;
    expectedText: string;
    throwIfAborted: () => void;
  }): Promise<boolean> => {
    let verificationPage: Page | undefined;
    try {
      verificationPage = await options.sourcePage.context().newPage();
      options.throwIfAborted();
      await verificationPage.goto(options.conversationUrl, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeoutMs,
      });
      options.throwIfAborted();

      const expected = parseSafeChatGptConversationUrl(options.conversationUrl);
      const restored = parseSafeChatGptConversationUrl(verificationPage.url());
      if (!expected || !restored || restored.pathname !== expected.pathname) return false;

      await ensureReady(verificationPage);
      options.throwIfAborted();
      const startedAt = Date.now();
      while (Date.now() - startedAt <= completionVerificationPageTimeoutMs) {
        const assistantTurns = await inspectCollectionSelector(
          verificationPage,
          chatGptSelectors.assistantTurns,
        );
        options.throwIfAborted();
        if (assistantTurns.count > options.baseline) {
          const turn = assistantTurns.locator.nth(options.baseline);
          const textContent = chatGptSelectors.assistantTextContent.locate(turn);
          const textContentCount = await textContent.count();
          options.throwIfAborted();
          if (textContentCount > 1) return false;
          if (textContentCount === 1) {
            const transientStatus = chatGptSelectors.assistantTransientStatus.locate(turn);
            const transientStatusCount = await transientStatus.count();
            options.throwIfAborted();
            const completionMarker = chatGptSelectors.assistantTurnCompletion.locate(turn);
            const completionMarkerCount = await completionMarker.count();
            options.throwIfAborted();
            if (completionMarkerCount > 1) return false;
            if (
              transientStatusCount === 0 &&
              completionMarkerCount === 1 &&
              (await textContent.innerText()) === options.expectedText
            ) {
              return resynchronizeCompletedSourcePage({
                sourcePage: options.sourcePage,
                conversationUrl: options.conversationUrl,
                throwIfAborted: options.throwIfAborted,
              });
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        options.throwIfAborted();
      }
      return false;
    } catch (error) {
      if (error instanceof TextStreamAbortedError) throw error;
      return false;
    } finally {
      if (verificationPage) await verificationPage.close().catch(() => undefined);
    }
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
      const attachments = request.attachments ?? [];
      let attachmentState:
        | {
            tiles: Awaited<ReturnType<typeof inspectCollection>>;
            alerts: Awaited<ReturnType<typeof inspectCollection>>;
            baselineTiles: number;
            baselineAlerts: number;
            expectedOwned: number;
            throwIfAborted: () => void;
          }
        | undefined;

      if (attachments.length > 0) {
        const tiles = await inspectCollectionSelector(page, chatGptSelectors.attachmentTiles);
        throwIfAborted();
        const alerts = await inspectCollectionSelector(
          page,
          chatGptSelectors.attachmentUploadAlerts,
        );
        throwIfAborted();
        const attachmentInput = await waitForRequiredControl(
          page,
          chatGptSelectors.attachmentInput,
          'before attachment upload',
        );
        throwIfAborted();
        try {
          await attachmentInput.setInputFiles(attachments.map((attachment) => attachment.path));
        } catch (error) {
          throw new ChatGptDriverError({
            code: 'chatgpt_upload_failed',
            message: 'ChatGPT attachment input rejected the prepared upload',
            selectorName: chatGptSelectors.attachmentInput.name,
            cause: error,
          });
        }
        throwIfAborted();
        attachmentState = {
          tiles,
          alerts,
          baselineTiles: tiles.count,
          baselineAlerts: alerts.count,
          expectedOwned: attachments.length,
          throwIfAborted,
        };
        await waitForAttachmentsReady(attachmentState);
        throwIfAborted();
      }

      const composer = await waitForRequiredControl(
        page,
        chatGptSelectors.composer,
        'before Composer input',
      );
      throwIfAborted();
      await composer.focus();
      throwIfAborted();
      await enterComposerPrompt(page, composer, request.prompt);
      throwIfAborted();
      await dismissConversationHistoryRateLimitModal(page);
      throwIfAborted();
      if (attachmentState !== undefined) {
        const state = await inspectOwnedAttachmentState(attachmentState);
        if (state !== 'ready') {
          throw new ChatGptDriverError({
            code: 'chatgpt_upload_failed',
            message: 'ChatGPT attachment readiness changed before Send',
            selectorName: chatGptSelectors.attachmentTiles.name,
          });
        }
      }
      await clickSendControl(page, 'after Composer input', throwIfAborted);

      let sawGeneratingStopControl = false;
      let verificationStableText = '';
      let verificationStableSince = completionNow();
      let lastVerificationAttemptAt = Number.NEGATIVE_INFINITY;
      const resetCompletionVerificationWindow = (): void => {
        verificationStableText = '';
        verificationStableSince = completionNow();
        lastVerificationAttemptAt = Number.NEGATIVE_INFINITY;
      };

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

        const text = await textContent.innerText();
        let completionMarkerPresent = completionMarkerCount === 1;
        if (completionMarkerPresent) {
          const stopControl = await inspectUniqueSelector(page, chatGptSelectors.stopControl);
          if (stopControl.status === 'ambiguous') {
            throw new ChatGptDriverError({
              code: 'selector_ambiguous',
              message: 'ChatGPT stop control is ambiguous beside a completed target turn',
              selectorName: chatGptSelectors.stopControl.name,
              candidateName: stopControl.candidateName,
            });
          }
          if (stopControl.status === 'unique') {
            sawGeneratingStopControl = true;
            const conversationUrl = parseSafeChatGptConversationUrl(page.url());
            completionMarkerPresent =
              conversationUrl !== undefined &&
              (await resynchronizeCompletedSourcePage({
                sourcePage: page,
                conversationUrl: conversationUrl.href,
                throwIfAborted,
              }));
            if (!completionMarkerPresent) {
              resetCompletionVerificationWindow();
              return { exists: true, text, completionMarkerPresent: false };
            }
          }
        }
        if (!completionMarkerPresent) {
          const transientStatus = chatGptSelectors.assistantTransientStatus.locate(turn);
          const transientStatusCount = await transientStatus.count();
          if (transientStatusCount > 0 || text.trim().length === 0) {
            resetCompletionVerificationWindow();
          } else {
            const stopControl = await inspectUniqueSelector(page, chatGptSelectors.stopControl);
            if (stopControl.status === 'unique') sawGeneratingStopControl = true;

            const now = completionNow();
            if (text !== verificationStableText) {
              verificationStableText = text;
              verificationStableSince = now;
              lastVerificationAttemptAt = Number.NEGATIVE_INFINITY;
            } else if (
              sawGeneratingStopControl &&
              now - verificationStableSince >= completionVerificationStableMs &&
              now - lastVerificationAttemptAt >= completionVerificationRetryMs
            ) {
              lastVerificationAttemptAt = now;
              const conversationUrl = parseSafeChatGptConversationUrl(page.url());
              if (conversationUrl) {
                completionMarkerPresent = await verifyCompletedConversation({
                  sourcePage: page,
                  conversationUrl: conversationUrl.href,
                  baseline,
                  expectedText: text,
                  throwIfAborted,
                });
              }
            }
          }
        }

        return {
          exists: true,
          text,
          completionMarkerPresent,
        };
      };

      const stop = async (): Promise<'stopped' | 'already_complete'> => {
        const current = await observe();
        if (current.exists && current.completionMarkerPresent) return 'already_complete';

        const resolveStopControl = async (): Promise<Locator> => {
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
          return stopControl.locator;
        };

        await dismissConversationHistoryRateLimitModal(page);
        let stopControl = await resolveStopControl();
        try {
          await stopControl.click({ timeout: stopTimeoutMs });
        } catch (error) {
          const dismissed = await dismissConversationHistoryRateLimitModal(page);
          const afterClickRace = await observe();
          if (afterClickRace.exists && afterClickRace.completionMarkerPresent) {
            return 'already_complete';
          }
          if (!dismissed) throw error;
          stopControl = await resolveStopControl();
          await stopControl.click({ timeout: stopTimeoutMs });
        }
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
      throw await asChatGptDriverErrorWithDiagnostics({
        error,
        page,
        operation: 'startText',
        prompt: request.prompt,
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
        throw await asChatGptDriverErrorWithDiagnostics({
          error,
          page,
          operation: 'openFresh',
        });
      }
    },

    async openConversation(page, conversationUrl) {
      try {
        const expected = parseSafeChatGptConversationUrl(conversationUrl);
        if (!expected) return 'not_restorable';

        const current = parseSafeChatGptConversationUrl(page.url());
        const navigated = current?.pathname !== expected.pathname;
        if (navigated) {
          await page.goto(expected.href, {
            waitUntil: 'domcontentloaded',
            timeout: navigationTimeoutMs,
          });
        }

        const restored = parseSafeChatGptConversationUrl(page.url());
        if (!restored || restored.pathname !== expected.pathname) return 'not_restorable';

        await ensureReady(page);
        const readyUrl = parseSafeChatGptConversationUrl(page.url());
        if (!readyUrl || readyUrl.pathname !== expected.pathname) return 'not_restorable';
        if (navigated && !(await waitForRestoredConversationHydration(page, expected))) {
          return 'not_restorable';
        }
        return 'restored';
      } catch (error) {
        throw await asChatGptDriverErrorWithDiagnostics({
          error,
          page,
          operation: 'openConversation',
        });
      }
    },

    startText,

    async sendText(page, request) {
      try {
        const turn = await startText(page, request);
        const text = await waitForFinalSnapshot({
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
        throw await asChatGptDriverErrorWithDiagnostics({
          error,
          page,
          operation: 'sendText',
          prompt: request.prompt,
        });
      }
    },
  };
}
