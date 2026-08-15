import { randomUUID as defaultRandomUuid } from 'node:crypto';

import type { NormalizedExecutionHandler, TextExecutionResult } from '../api/execution.js';
import type { NormalizedRequest } from '../api/normalized.js';
import type { ChatGptTextDriver, ChatGptTextResult } from '../chatgpt/driver.js';
import { ChatGptDriverError } from '../chatgpt/errors.js';
import { canonicalizeInstructions, canonicalizeText } from '../context/canonicalize.js';
import { planContextSync } from '../context/planner.js';
import type {
  CanonicalConversationRequest,
  CanonicalStoredConversation,
  CanonicalTextMessage,
  ContextSyncPlan,
} from '../context/types.js';
import type { ConversationStore } from '../persistence/conversation-store.js';
import type { ConversationAggregate, ConversationRecord } from '../persistence/types.js';

import { buildFinalConversationAggregate } from './aggregate-builder.js';
import type { ConversationPageRegistry, ConversationPageSession } from './page-registry.js';
import { buildAppendPrompt, buildContextPrompt } from './prompts.js';
import type { ConversationQueue } from './conversation-queue.js';
import { toCanonicalConversationRequest } from './request-context.js';

export interface CreateConversationEngineOptions {
  pageRegistry: ConversationPageRegistry;
  queue: ConversationQueue;
  driver: ChatGptTextDriver;
  conversationStore: ConversationStore;
  now?: () => number;
  randomUuid?: () => string;
}

function canonicalStoredMessage(
  record: ConversationAggregate['messages'][number],
): CanonicalTextMessage {
  if (record.role !== 'user' && record.role !== 'assistant') {
    throw new Error('Phase 4 stored Conversation contains a non-text-history role');
  }
  if (record.content.some((part) => part.type !== 'text')) {
    throw new Error('Phase 4 stored Conversation contains non-text content');
  }
  return {
    role: record.role,
    text: canonicalizeText(record.content.map((part) => (part.type === 'text' ? part.text : ''))),
  };
}

function canonicalStoredConversation(
  aggregate: ConversationAggregate,
): CanonicalStoredConversation {
  return {
    instructions: canonicalizeInstructions(aggregate.conversation.instructions),
    messages: aggregate.messages.map(canonicalStoredMessage),
    conversationUrl: aggregate.conversation.chatgptConversationUrl,
    sync: {
      status: aggregate.conversation.sync.status,
      syncedMessageCount: aggregate.conversation.sync.syncedMessageCount,
    },
  };
}

function createInFlightConversation(options: {
  conversationId: string;
  conversationKey?: string;
  request: NormalizedRequest;
  startedAt: number;
}): ConversationAggregate {
  return {
    conversation: {
      id: options.conversationId,
      ...(options.conversationKey === undefined
        ? {}
        : { conversationKey: options.conversationKey }),
      instructions: options.request.instructions,
      tools: [],
      toolChoice: { mode: 'auto' },
      sync: { status: 'in_flight', syncedMessageCount: 0, startedAt: options.startedAt },
      createdAt: options.startedAt,
      updatedAt: options.startedAt,
      lastUsedAt: options.startedAt,
    },
    messages: [],
    toolCalls: [],
    attachments: [],
    generatedImages: [],
  };
}

function finalConversationRecord(options: {
  existing?: ConversationAggregate;
  initial: ConversationAggregate;
  request: NormalizedRequest;
}): ConversationRecord {
  return {
    ...(options.existing?.conversation ?? options.initial.conversation),
    instructions: options.request.instructions,
    tools: [],
    toolChoice: { mode: 'auto' },
  };
}

function contextHistory(options: {
  canonicalRequest: CanonicalConversationRequest;
  plan: ContextSyncPlan;
  stored?: CanonicalStoredConversation;
}): CanonicalTextMessage[] {
  if (options.plan.mode === 'FRESH' || options.plan.mode === 'REBUILD') {
    return options.plan.history;
  }
  if (options.canonicalRequest.mode === 'full') {
    return options.canonicalRequest.messages.slice(0, -1);
  }
  return options.stored?.messages.slice(0, options.stored.sync.syncedMessageCount) ?? [];
}

function authoritativeMessages(options: {
  canonicalRequest: CanonicalConversationRequest;
  plan: ContextSyncPlan;
  stored?: CanonicalStoredConversation;
}): CanonicalTextMessage[] {
  if (options.plan.mode === 'FRESH' || options.plan.mode === 'REBUILD') {
    return [...options.plan.history, options.plan.currentUser];
  }
  if (options.canonicalRequest.mode === 'full') return options.canonicalRequest.messages;
  const confirmed = options.stored?.messages.slice(0, options.stored.sync.syncedMessageCount) ?? [];
  return [...confirmed, options.plan.currentUser];
}

async function preparePage(options: {
  driver: ChatGptTextDriver;
  session: ConversationPageSession;
  plan: ContextSyncPlan;
  conversationUrl?: string;
}): Promise<'context' | 'append'> {
  if (options.plan.mode === 'FRESH' || options.plan.mode === 'REBUILD') {
    await options.driver.openFresh(options.session.page);
    return 'context';
  }

  const conversationUrl = options.conversationUrl;
  if (!conversationUrl) {
    throw new ChatGptDriverError({
      code: 'conversation_restore_failed',
      message: 'Conversation URL is unavailable for append',
    });
  }
  const restored = await options.driver.openConversation(options.session.page, conversationUrl);
  if (restored === 'restored') return 'append';

  await options.driver.openFresh(options.session.page);
  return 'context';
}

async function executeConversation(options: {
  engine: CreateConversationEngineOptions;
  request: NormalizedRequest;
  canonicalRequest: CanonicalConversationRequest;
  conversationKey?: string;
  existing?: ConversationAggregate;
  now: () => number;
  randomUuid: () => string;
}): Promise<TextExecutionResult> {
  const existing = options.existing;
  const conversationId = existing?.conversation.id ?? options.randomUuid();
  const stored = existing === undefined ? undefined : canonicalStoredConversation(existing);
  const plan = planContextSync({
    ...(stored === undefined ? {} : { stored }),
    request: options.canonicalRequest,
    hasAffinityPage:
      existing === undefined ? false : options.engine.pageRegistry.hasAffinity(conversationId),
  });
  const session = await options.engine.pageRegistry.acquire(
    options.conversationKey === undefined ? undefined : conversationId,
  );
  let completed = false;

  try {
    const promptMode = await preparePage({
      driver: options.engine.driver,
      session,
      plan,
      conversationUrl: existing?.conversation.chatgptConversationUrl,
    });

    const startedAt = options.now();
    let initial: ConversationAggregate;
    if (existing === undefined) {
      initial = createInFlightConversation({
        conversationId,
        ...(options.conversationKey === undefined
          ? {}
          : { conversationKey: options.conversationKey }),
        request: options.request,
        startedAt,
      });
      options.engine.conversationStore.save(initial);
    } else {
      initial = existing;
      options.engine.conversationStore.markSyncInFlight(conversationId, startedAt);
    }

    const prompt =
      promptMode === 'append'
        ? buildAppendPrompt(plan.currentUser)
        : buildContextPrompt({
            instructions: options.canonicalRequest.instructions,
            history: contextHistory({
              canonicalRequest: options.canonicalRequest,
              plan,
              ...(stored === undefined ? {} : { stored }),
            }),
            currentUser: plan.currentUser,
          });
    const result: ChatGptTextResult = await options.engine.driver.sendText(session.page, {
      prompt,
    });
    const completedAt = options.now();
    const finalAggregate = buildFinalConversationAggregate({
      ...(existing === undefined ? {} : { stored: existing }),
      conversation: finalConversationRecord({ existing, initial, request: options.request }),
      authoritativeMessages: authoritativeMessages({
        canonicalRequest: options.canonicalRequest,
        plan,
        ...(stored === undefined ? {} : { stored }),
      }),
      assistantText: result.text,
      conversationUrl: result.conversationUrl,
      completedAt,
    });
    options.engine.conversationStore.save(finalAggregate);
    await session.complete();
    completed = true;

    return {
      type: 'text',
      text: result.text,
      conversationUrl: result.conversationUrl,
      completedAt,
    };
  } finally {
    if (!completed) await session.fail();
  }
}

export function createConversationEngine(
  options: CreateConversationEngineOptions,
): NormalizedExecutionHandler {
  const now = options.now ?? Date.now;
  const randomUuid = options.randomUuid ?? defaultRandomUuid;

  return async (request) => {
    const conversationKey = request.conversationKey;
    if (conversationKey === undefined) {
      const canonicalRequest = toCanonicalConversationRequest(request);
      return executeConversation({
        engine: options,
        request,
        canonicalRequest,
        now,
        randomUuid,
      });
    }

    return options.queue.run(conversationKey, async () => {
      const existing = options.conversationStore.loadByKey(conversationKey);
      const canonicalRequest = toCanonicalConversationRequest(request);
      return executeConversation({
        engine: options,
        request,
        canonicalRequest,
        conversationKey,
        ...(existing === undefined ? {} : { existing }),
        now,
        randomUuid,
      });
    });
  };
}
