import { randomUUID as defaultRandomUuid } from 'node:crypto';

import type {
  ConversationExecutionEngine,
  NormalizedExecutionHandler,
  StreamingExecutionOptions,
  TextExecutionResult,
} from '../api/execution.js';
import type { NormalizedRequest } from '../api/normalized.js';
import type {
  ChatGptStreamingTextDriver,
  ChatGptTextDriver,
  ChatGptTextResult,
  ChatGptTextTurn,
} from '../chatgpt/driver.js';
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
import { streamAssistantText } from '../stream/text-stream.js';
import type { StreamClock } from '../stream/types.js';

import { buildFinalConversationAggregate } from './aggregate-builder.js';
import type { ConversationPageRegistry, ConversationPageSession } from './page-registry.js';
import { buildAppendPrompt, buildContextPrompt } from './prompts.js';
import type { ConversationQueue } from './conversation-queue.js';
import {
  toCanonicalConversationRequest,
  toCanonicalStreamingConversationRequest,
} from './request-context.js';

export interface CreateConversationEngineOptions {
  pageRegistry: ConversationPageRegistry;
  queue: ConversationQueue;
  driver: ChatGptTextDriver;
  conversationStore: ConversationStore;
  now?: () => number;
  randomUuid?: () => string;
  streamClock?: StreamClock;
  streamPollIntervalMs?: number;
  streamStableSamples?: number;
  streamTimeoutMs?: number;
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

function buildPrompt(options: {
  promptMode: 'context' | 'append';
  canonicalRequest: CanonicalConversationRequest;
  plan: ContextSyncPlan;
  stored?: CanonicalStoredConversation;
}): string {
  return options.promptMode === 'append'
    ? buildAppendPrompt(options.plan.currentUser)
    : buildContextPrompt({
        instructions: options.canonicalRequest.instructions,
        history: contextHistory({
          canonicalRequest: options.canonicalRequest,
          plan: options.plan,
          ...(options.stored === undefined ? {} : { stored: options.stored }),
        }),
        currentUser: options.plan.currentUser,
      });
}

function startCheckpoint(options: {
  engine: CreateConversationEngineOptions;
  existing?: ConversationAggregate;
  conversationId: string;
  conversationKey?: string;
  request: NormalizedRequest;
  startedAt: number;
}): ConversationAggregate {
  if (options.existing !== undefined) {
    options.engine.conversationStore.markSyncInFlight(options.conversationId, options.startedAt);
    return options.existing;
  }

  const initial = createInFlightConversation({
    conversationId: options.conversationId,
    ...(options.conversationKey === undefined ? {} : { conversationKey: options.conversationKey }),
    request: options.request,
    startedAt: options.startedAt,
  });
  options.engine.conversationStore.save(initial);
  return initial;
}

function buildFinalResult(options: {
  engine: CreateConversationEngineOptions;
  existing?: ConversationAggregate;
  initial: ConversationAggregate;
  request: NormalizedRequest;
  canonicalRequest: CanonicalConversationRequest;
  plan: ContextSyncPlan;
  stored?: CanonicalStoredConversation;
  assistantText: string;
  conversationUrl: string;
  completedAt: number;
}): TextExecutionResult {
  const finalAggregate = buildFinalConversationAggregate({
    ...(options.existing === undefined ? {} : { stored: options.existing }),
    conversation: finalConversationRecord({
      existing: options.existing,
      initial: options.initial,
      request: options.request,
    }),
    authoritativeMessages: authoritativeMessages({
      canonicalRequest: options.canonicalRequest,
      plan: options.plan,
      ...(options.stored === undefined ? {} : { stored: options.stored }),
    }),
    assistantText: options.assistantText,
    conversationUrl: options.conversationUrl,
    completedAt: options.completedAt,
  });
  options.engine.conversationStore.save(finalAggregate);
  return {
    type: 'text',
    text: options.assistantText,
    conversationUrl: options.conversationUrl,
    completedAt: options.completedAt,
  };
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
    const initial = startCheckpoint({
      engine: options.engine,
      existing,
      conversationId,
      conversationKey: options.conversationKey,
      request: options.request,
      startedAt,
    });
    const prompt = buildPrompt({
      promptMode,
      canonicalRequest: options.canonicalRequest,
      plan,
      stored,
    });
    const result: ChatGptTextResult = await options.engine.driver.sendText(session.page, {
      prompt,
    });
    const completedAt = options.now();
    const finalResult = buildFinalResult({
      engine: options.engine,
      existing,
      initial,
      request: options.request,
      canonicalRequest: options.canonicalRequest,
      plan,
      stored,
      assistantText: result.text,
      conversationUrl: result.conversationUrl,
      completedAt,
    });
    await session.complete();
    completed = true;
    return finalResult;
  } finally {
    if (!completed) await session.fail();
  }
}

function requireStreamingDriver(driver: ChatGptTextDriver): ChatGptStreamingTextDriver {
  if (!('startText' in driver) || typeof driver.startText !== 'function') {
    throw new ChatGptDriverError({
      code: 'browser_unavailable',
      message: 'ChatGPT streaming driver is unavailable',
    });
  }
  return driver as ChatGptStreamingTextDriver;
}

function isStreamAborted(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'stream_aborted'
  );
}

async function streamConversation(options: {
  engine: CreateConversationEngineOptions;
  request: NormalizedRequest;
  canonicalRequest: CanonicalConversationRequest;
  streamOptions: StreamingExecutionOptions;
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
  const driver = requireStreamingDriver(options.engine.driver);
  let completed = false;
  let turn: ChatGptTextTurn | undefined;

  try {
    const promptMode = await preparePage({
      driver,
      session,
      plan,
      conversationUrl: existing?.conversation.chatgptConversationUrl,
    });
    const startedAt = options.now();
    await options.streamOptions.sink({ type: 'started', startedAt });

    const initial = startCheckpoint({
      engine: options.engine,
      existing,
      conversationId,
      conversationKey: options.conversationKey,
      request: options.request,
      startedAt,
    });
    const prompt = buildPrompt({
      promptMode,
      canonicalRequest: options.canonicalRequest,
      plan,
      stored,
    });
    turn = await driver.startText(session.page, { prompt });
    const assistantText = await streamAssistantText({
      observe: turn.observe,
      onDelta: async (delta) => {
        await options.streamOptions.sink({ type: 'text.delta', delta });
      },
      signal: options.streamOptions.signal,
      ...(options.engine.streamClock === undefined ? {} : { clock: options.engine.streamClock }),
      ...(options.engine.streamPollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.engine.streamPollIntervalMs }),
      ...(options.engine.streamStableSamples === undefined
        ? {}
        : { stableSamples: options.engine.streamStableSamples }),
      ...(options.engine.streamTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.engine.streamTimeoutMs }),
    });
    const conversationUrl = await turn.conversationUrl();
    const completedAt = options.now();
    const finalResult = buildFinalResult({
      engine: options.engine,
      existing,
      initial,
      request: options.request,
      canonicalRequest: options.canonicalRequest,
      plan,
      stored,
      assistantText,
      conversationUrl,
      completedAt,
    });
    await session.complete();
    completed = true;
    try {
      await options.streamOptions.sink({ type: 'completed', result: finalResult });
    } catch (error) {
      if (!isStreamAborted(error)) throw error;
    }
    return finalResult;
  } catch (error) {
    if (!completed && turn !== undefined && isStreamAborted(error)) {
      try {
        await turn.stop();
      } catch {
        // The transport is already gone. Keep the checkpoint in_flight and preserve the original abort.
      }
    }
    throw error;
  } finally {
    if (!completed) await session.fail();
  }
}

function executeHandler(
  options: CreateConversationEngineOptions,
  now: () => number,
  randomUuid: () => string,
): NormalizedExecutionHandler {
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

export function createConversationExecutionEngine(
  options: CreateConversationEngineOptions,
): ConversationExecutionEngine {
  const now = options.now ?? Date.now;
  const randomUuid = options.randomUuid ?? defaultRandomUuid;
  const execute = executeHandler(options, now, randomUuid);

  return {
    execute,
    stream: async (request, streamOptions) => {
      const conversationKey = request.conversationKey;
      if (conversationKey === undefined) {
        const canonicalRequest = toCanonicalStreamingConversationRequest(request);
        return streamConversation({
          engine: options,
          request,
          canonicalRequest,
          streamOptions,
          now,
          randomUuid,
        });
      }

      return options.queue.run(conversationKey, async () => {
        const existing = options.conversationStore.loadByKey(conversationKey);
        const canonicalRequest = toCanonicalStreamingConversationRequest(request);
        return streamConversation({
          engine: options,
          request,
          canonicalRequest,
          streamOptions,
          conversationKey,
          ...(existing === undefined ? {} : { existing }),
          now,
          randomUuid,
        });
      });
    },
  };
}

export function createConversationEngine(
  options: CreateConversationEngineOptions,
): NormalizedExecutionHandler {
  return createConversationExecutionEngine(options).execute;
}
