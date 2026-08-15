import { randomUUID as defaultRandomUUID } from 'node:crypto';

import type { NormalizedExecutionHandler, TextExecutionResult } from '../api/execution.js';
import type { NormalizedMessage, NormalizedRequest } from '../api/normalized.js';
import type { PagePool } from '../browser/types.js';
import type { ChatGptDriver, ChatGptTextResult, ChatGptTextTarget } from '../chatgpt/driver.js';
import { ChatGptDriverError } from '../chatgpt/errors.js';
import { planContextSync, type ContextSyncPlan } from '../context/sync.js';
import type { ConversationStore } from '../persistence/conversation-store.js';
import type { ConversationAggregate, MessageRecord } from '../persistence/types.js';

import type { ConversationPageLease, ConversationPageManager } from './conversation-pages.js';
import type { ConversationQueue } from './conversation-queue.js';
import {
  buildAppendPrompt,
  buildFullContextPrompt,
  validatePhase4Request,
} from './phase4-request.js';

export type ConversationExecutorPageManager = Pick<ConversationPageManager, 'acquire'>;

export interface CreateConversationExecutorOptions {
  pagePool: Pick<PagePool, 'acquire'>;
  pageManager: ConversationExecutorPageManager;
  queue: Pick<ConversationQueue, 'run'>;
  driver: ChatGptDriver;
  conversationStore: Pick<ConversationStore, 'loadByKey' | 'save'>;
  now?: () => number;
  randomUUID?: () => string;
}

function normalizedMessages(aggregate: ConversationAggregate): NormalizedMessage[] {
  return aggregate.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  }));
}

function isRestoreFailure(error: unknown): error is ChatGptDriverError {
  return error instanceof ChatGptDriverError && error.code === 'conversation_restore_failed';
}

function targetForAppend(mode: 'APPEND' | 'RESTORE', conversationUrl: string): ChatGptTextTarget {
  return mode === 'APPEND'
    ? { kind: 'current', conversationUrl }
    : { kind: 'restore', conversationUrl };
}

async function executePlan(options: {
  driver: ChatGptDriver;
  page: ConversationPageLease['page'];
  request: NormalizedRequest;
  plan: ContextSyncPlan;
  conversationUrl?: string;
}): Promise<ChatGptTextResult> {
  if (options.plan.mode === 'FRESH' || options.plan.mode === 'REBUILD') {
    return options.driver.sendText(options.page, {
      prompt: buildFullContextPrompt(options.request),
      target: { kind: 'fresh' },
    });
  }

  const conversationUrl = options.conversationUrl;
  if (!conversationUrl) {
    return options.driver.sendText(options.page, {
      prompt: buildFullContextPrompt(options.request),
      target: { kind: 'fresh' },
    });
  }

  const appendMessage = options.plan.appendMessages[0]!;
  const appendPrompt = buildAppendPrompt(appendMessage);
  const initialTarget = targetForAppend(options.plan.mode, conversationUrl);

  try {
    return await options.driver.sendText(options.page, {
      prompt: appendPrompt,
      target: initialTarget,
    });
  } catch (error) {
    if (!isRestoreFailure(error)) throw error;
  }

  if (options.plan.mode === 'APPEND') {
    try {
      return await options.driver.sendText(options.page, {
        prompt: appendPrompt,
        target: { kind: 'restore', conversationUrl },
      });
    } catch (error) {
      if (!isRestoreFailure(error)) throw error;
    }
  }

  return options.driver.sendText(options.page, {
    prompt: buildFullContextPrompt(options.request),
    target: { kind: 'fresh' },
  });
}

function buildMessageRecords(options: {
  conversationId: string;
  messages: NormalizedMessage[];
  assistantText: string;
  now: number;
  randomUUID: () => string;
}): MessageRecord[] {
  const synchronized: NormalizedMessage[] = [
    ...options.messages,
    { role: 'assistant', content: [{ type: 'text', text: options.assistantText }] },
  ];

  return synchronized.map((message, sequence) => ({
    id: options.randomUUID(),
    conversationId: options.conversationId,
    sequence,
    role: message.role,
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    createdAt: options.now,
    updatedAt: options.now,
  }));
}

function buildSuccessfulAggregate(options: {
  existing?: ConversationAggregate;
  request: NormalizedRequest;
  conversationKey: string;
  result: ChatGptTextResult;
  completedAt: number;
  randomUUID: () => string;
}): ConversationAggregate {
  const conversationId = options.existing?.conversation.id ?? options.randomUUID();
  return {
    conversation: {
      id: conversationId,
      conversationKey: options.conversationKey,
      chatgptConversationUrl: options.result.conversationUrl,
      instructions: options.request.instructions,
      tools: [],
      toolChoice: { mode: 'auto' },
      sync: { status: 'clean', syncedMessageCount: options.request.messages.length + 1 },
      createdAt: options.existing?.conversation.createdAt ?? options.completedAt,
      updatedAt: options.completedAt,
      lastUsedAt: options.completedAt,
    },
    messages: buildMessageRecords({
      conversationId,
      messages: options.request.messages,
      assistantText: options.result.text,
      now: options.completedAt,
      randomUUID: options.randomUUID,
    }),
    toolCalls: [],
    attachments: [],
    generatedImages: [],
  };
}

async function executeEphemeral(
  options: CreateConversationExecutorOptions,
  request: NormalizedRequest,
  now: () => number,
): Promise<TextExecutionResult> {
  const lease = await options.pagePool.acquire();
  try {
    const result = await options.driver.sendText(lease.page, {
      prompt: buildFullContextPrompt(request),
      target: { kind: 'fresh' },
    });
    return {
      type: 'text',
      text: result.text,
      conversationUrl: result.conversationUrl,
      completedAt: now(),
    };
  } finally {
    await lease.release();
  }
}

export function createConversationExecutor(
  options: CreateConversationExecutorOptions,
): NormalizedExecutionHandler {
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? defaultRandomUUID;

  return async (request) => {
    validatePhase4Request(request);
    const conversationKey = request.conversationKey;
    if (conversationKey === undefined) return executeEphemeral(options, request, now);

    return options.queue.run(conversationKey, async () => {
      const existing = options.conversationStore.loadByKey(conversationKey);
      const lease = await options.pageManager.acquire(conversationKey);
      let succeeded = false;
      try {
        const plan = planContextSync({
          instructions: request.instructions,
          messages: request.messages,
          ...(existing === undefined
            ? {}
            : {
                persisted: {
                  instructions: existing.conversation.instructions,
                  messages: normalizedMessages(existing),
                  conversationUrl: existing.conversation.chatgptConversationUrl,
                },
              }),
          hasWarmPage: lease.reused,
        });

        const result = await executePlan({
          driver: options.driver,
          page: lease.page,
          request,
          plan,
          conversationUrl: existing?.conversation.chatgptConversationUrl,
        });
        const completedAt = now();
        options.conversationStore.save(
          buildSuccessfulAggregate({
            ...(existing === undefined ? {} : { existing }),
            request,
            conversationKey,
            result,
            completedAt,
            randomUUID,
          }),
        );
        succeeded = true;
        return {
          type: 'text',
          text: result.text,
          conversationUrl: result.conversationUrl,
          completedAt,
        } satisfies TextExecutionResult;
      } finally {
        await lease.release(succeeded ? {} : { discard: true });
      }
    });
  };
}
