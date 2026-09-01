import { randomUUID as defaultRandomUuid } from 'node:crypto';

import type {
  ConversationExecutionEngine,
  NormalizedExecutionHandler,
  NormalizedExecutionResult,
  StreamingExecutionOptions,
} from '../api/execution.js';
import type { NormalizedRequest, NormalizedToolCall } from '../api/normalized.js';
import {
  storedAttachmentReference,
  type ResolvedAttachment,
  type ResolvedAttachmentHandle,
  type RetainedAttachmentHandle,
} from '../attachments/resolver.js';
import type {
  ChatGptStreamingTextDriver,
  ChatGptTextDriver,
  ChatGptTextResult,
  ChatGptTextTurn,
} from '../chatgpt/driver.js';
import { ChatGptDriverError } from '../chatgpt/errors.js';
import { canonicalizeInstructions, canonicalizeText } from '../context/canonicalize.js';
import {
  isCanonicalAssistantToolCallMessage,
  selectUploadAttachmentReferences,
  type ResolvedAttachmentSemanticMap,
} from '../context/multimodal.js';
import { planContextSync } from '../context/planner.js';
import type {
  CanonicalContentPart,
  CanonicalConversationRequest,
  CanonicalMessage,
  CanonicalStoredConversation,
  ContextSyncPlan,
} from '../context/types.js';
import type { ConversationStore } from '../persistence/conversation-store.js';
import type {
  AttachmentRecord,
  ConversationAggregate,
  ConversationRecord,
} from '../persistence/types.js';
import { TextStreamAbortedError } from '../stream/errors.js';
import { streamAssistantText } from '../stream/text-stream.js';
import { validateStructuredAssistantText } from '../structured/output.js';
import { fingerprintTools } from '../tools/canonicalize.js';
import { ToolDetectionBuffer } from '../tools/detection-buffer.js';
import { parseAssistantOutput } from '../tools/parser.js';
import type { StreamClock } from '../stream/types.js';

import {
  buildFinalConversationAggregate,
  type AssistantAggregateResult,
  type PersistenceAttachmentBinding,
} from './aggregate-builder.js';
import type { ConversationPageRegistry, ConversationPageSession } from './page-registry.js';
import { buildAppendPrompt, buildContextPrompt } from './prompts.js';
import type { ConversationQueue } from './conversation-queue.js';
import {
  toCanonicalPhase7ConversationRequest,
  toCanonicalPhase7StreamingConversationRequest,
} from './request-context.js';

export interface ConversationAttachmentResolver {
  resolveAll(
    attachments: readonly NormalizedRequest['attachments'][number][],
    request: { requestId: string; signal?: AbortSignal },
  ): Promise<ResolvedAttachmentHandle>;
  retainStored(attachments: readonly AttachmentRecord[]): Promise<RetainedAttachmentHandle>;
}

export interface CreateConversationEngineOptions {
  pageRegistry: ConversationPageRegistry;
  queue: ConversationQueue;
  driver: ChatGptTextDriver;
  conversationStore: ConversationStore;
  attachmentResolver?: ConversationAttachmentResolver;
  now?: () => number;
  randomUuid?: () => string;
  streamClock?: StreamClock;
  streamPollIntervalMs?: number;
  streamStableSamples?: number;
  streamTimeoutMs?: number;
}

function retainedByAttachmentRecord(
  aggregate: ConversationAggregate,
  resolved: readonly ResolvedAttachment[],
): Map<string, ResolvedAttachment> {
  if (aggregate.attachments.length !== resolved.length) {
    throw new Error('Stored Attachment resolution count does not match persistence');
  }
  return new Map(
    aggregate.attachments.map((attachment, index) => [
      attachment.id,
      resolved[index] as ResolvedAttachment,
    ]),
  );
}

function canonicalStoredMessage(options: {
  aggregate: ConversationAggregate;
  record: ConversationAggregate['messages'][number];
  retained: ReadonlyMap<string, ResolvedAttachment>;
}): CanonicalMessage {
  const { aggregate, record, retained } = options;
  if (record.role === 'tool') {
    if (!record.toolCallId || record.content.some((part) => part.type !== 'text')) {
      throw new Error('Stored Tool Result is invalid');
    }
    return {
      role: 'tool',
      toolCallId: record.toolCallId,
      text: canonicalizeText(record.content.map((part) => (part.type === 'text' ? part.text : ''))),
    };
  }
  if (record.role !== 'user' && record.role !== 'assistant') {
    throw new Error('Stored Conversation contains an unsupported history role');
  }
  const calls = aggregate.toolCalls.filter((call) => call.messageId === record.id);
  if (calls.length > 0) {
    if (record.role !== 'assistant' || record.content.some((part) => part.type !== 'text')) {
      throw new Error('Stored Tool Call message is invalid');
    }
    return {
      role: 'assistant',
      text: canonicalizeText(record.content.map((part) => (part.type === 'text' ? part.text : ''))),
      toolCalls: calls.map((call) => ({
        externalCallId: call.externalCallId,
        name: call.name,
        arguments: call.argumentsText,
      })),
    };
  }
  if (record.content.every((part) => part.type === 'text')) {
    return {
      role: record.role,
      text: canonicalizeText(record.content.map((part) => (part.type === 'text' ? part.text : ''))),
    };
  }

  const records = new Map(
    aggregate.attachments
      .filter((attachment) => attachment.messageId === record.id)
      .map((attachment) => [attachment.localAttachmentId, attachment]),
  );
  const content: CanonicalContentPart[] = [];
  let pendingText: string[] = [];
  const flushText = (): void => {
    if (pendingText.length === 0) return;
    content.push({ type: 'text', text: canonicalizeText(pendingText) });
    pendingText = [];
  };

  for (const part of record.content) {
    if (part.type === 'text') {
      pendingText.push(part.text);
      continue;
    }
    flushText();
    const attachment = records.get(part.attachmentId);
    if (!attachment) throw new Error('Stored Message attachment reference is missing');
    const resolved = retained.get(attachment.id);
    if (!resolved) throw new Error('Stored Attachment File metadata is missing');
    content.push({
      type: 'attachment',
      reference: storedAttachmentReference(attachment.id),
      kind: attachment.kind,
      sha256: resolved.file.sha256,
      filename: resolved.filename,
      ...(resolved.mimeType === undefined ? {} : { mimeType: resolved.mimeType }),
    });
  }
  flushText();
  return { role: record.role, content };
}

function canonicalStoredConversation(
  aggregate: ConversationAggregate,
  retainedResolved: readonly ResolvedAttachment[] = [],
): CanonicalStoredConversation {
  const retained = retainedByAttachmentRecord(aggregate, retainedResolved);
  return {
    instructions: canonicalizeInstructions(aggregate.conversation.instructions),
    messages: aggregate.messages.map((record) =>
      canonicalStoredMessage({ aggregate, record, retained }),
    ),
    ...(aggregate.conversation.toolFingerprint === undefined
      ? {}
      : { toolFingerprint: aggregate.conversation.toolFingerprint }),
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
      tools: options.request.tools,
      toolChoice: options.request.toolChoice,
      ...(fingerprintTools(options.request.tools, options.request.toolChoice) === undefined
        ? {}
        : {
            toolFingerprint: fingerprintTools(options.request.tools, options.request.toolChoice),
          }),
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
  const result: ConversationRecord = {
    ...(options.existing?.conversation ?? options.initial.conversation),
    instructions: options.request.instructions,
    tools: options.request.tools,
    toolChoice: options.request.toolChoice,
  };
  const fingerprint = fingerprintTools(options.request.tools, options.request.toolChoice);
  if (fingerprint === undefined) delete result.toolFingerprint;
  else result.toolFingerprint = fingerprint;
  return result;
}

function contextHistory(options: {
  canonicalRequest: CanonicalConversationRequest;
  plan: ContextSyncPlan;
  stored?: CanonicalStoredConversation;
}): CanonicalMessage[] {
  if (options.plan.mode === 'FRESH' || options.plan.mode === 'REBUILD') {
    return options.plan.history;
  }
  if (options.canonicalRequest.mode === 'full') {
    return options.canonicalRequest.messages.slice(0, -options.plan.pending.length);
  }
  return options.stored?.messages.slice(0, options.stored.sync.syncedMessageCount) ?? [];
}

function authoritativeMessages(options: {
  canonicalRequest: CanonicalConversationRequest;
  plan: ContextSyncPlan;
  stored?: CanonicalStoredConversation;
}): CanonicalMessage[] {
  if (options.plan.mode === 'FRESH' || options.plan.mode === 'REBUILD') {
    return [...options.plan.history, ...options.plan.pending];
  }
  if (options.canonicalRequest.mode === 'full') return options.canonicalRequest.messages;
  const confirmed = options.stored?.messages.slice(0, options.stored.sync.syncedMessageCount) ?? [];
  return [...confirmed, ...options.plan.pending];
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

function toolNameMap(messages: readonly CanonicalMessage[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const message of messages) {
    if (!isCanonicalAssistantToolCallMessage(message)) continue;
    for (const call of message.toolCalls) result.set(call.externalCallId, call.name);
  }
  return result;
}

function buildPrompt(options: {
  promptMode: 'context' | 'append';
  request: NormalizedRequest;
  canonicalRequest: CanonicalConversationRequest;
  plan: ContextSyncPlan;
  stored?: CanonicalStoredConversation;
  uploadFilenameByReference?: ReadonlyMap<string, string>;
}): string {
  const history = contextHistory({
    canonicalRequest: options.canonicalRequest,
    plan: options.plan,
    ...(options.stored === undefined ? {} : { stored: options.stored }),
  });
  const names = toolNameMap([...history, ...options.plan.pending]);
  return options.promptMode === 'append'
    ? buildAppendPrompt(options.plan.pending, options.uploadFilenameByReference, {
        toolChoice: options.request.tools.length === 0 ? undefined : options.request.toolChoice,
        structuredOutput: options.request.output.structured,
        toolNameByCallId: names,
      })
    : buildContextPrompt({
        instructions: options.canonicalRequest.instructions,
        tools: options.request.tools,
        toolChoice: options.request.toolChoice,
        structuredOutput: options.request.output.structured,
        history,
        pending: options.plan.pending,
        toolNameByCallId: names,
        ...(options.uploadFilenameByReference === undefined
          ? {}
          : { uploadFilenameByReference: options.uploadFilenameByReference }),
      });
}

function semanticMap(resolved: readonly ResolvedAttachment[]): ResolvedAttachmentSemanticMap {
  return new Map(
    resolved.map((item) => [
      item.localAttachmentId,
      {
        kind: item.kind,
        sha256: item.file.sha256,
        filename: item.filename,
        ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
      },
    ]),
  );
}

function attachmentBindings(options: {
  current: readonly ResolvedAttachment[];
  storedAggregate?: ConversationAggregate;
  retained: readonly ResolvedAttachment[];
}): Map<string, PersistenceAttachmentBinding> {
  const result = new Map<string, PersistenceAttachmentBinding>();
  for (const item of options.current) {
    result.set(item.localAttachmentId, {
      localAttachmentId: item.localAttachmentId,
      kind: item.kind,
      source: item.source,
      fileId: item.file.id,
    });
  }
  if (options.storedAggregate !== undefined) {
    if (options.storedAggregate.attachments.length !== options.retained.length) {
      throw new Error('Stored Attachment binding count does not match retained Files');
    }
    options.storedAggregate.attachments.forEach((record, index) => {
      const retained = options.retained[index] as ResolvedAttachment;
      result.set(storedAttachmentReference(record.id), {
        localAttachmentId: record.localAttachmentId,
        kind: record.kind,
        source: record.source,
        fileId: retained.file.id,
      });
    });
  }
  return result;
}

interface PreparedConversationContext {
  canonicalRequest: CanonicalConversationRequest;
  stored?: CanonicalStoredConversation;
  plan: ContextSyncPlan;
  preparedUploads: Array<{
    localAttachmentId: string;
    kind: 'image' | 'file';
    path: string;
    displayFilename: string;
  }>;
  uploadFilenameByReference: ReadonlyMap<string, string>;
  persistenceBindings: ReadonlyMap<string, PersistenceAttachmentBinding>;
  release(): Promise<void>;
}

async function prepareConversationContext(options: {
  engine: CreateConversationEngineOptions;
  request: NormalizedRequest;
  existing?: ConversationAggregate;
  conversationId: string;
  streaming: boolean;
  signal?: AbortSignal;
}): Promise<PreparedConversationContext> {
  const resolver = options.engine.attachmentResolver;
  if (resolver === undefined) {
    const canonicalRequest = options.streaming
      ? toCanonicalPhase7StreamingConversationRequest(options.request)
      : toCanonicalPhase7ConversationRequest(options.request);
    const stored =
      options.existing === undefined ? undefined : canonicalStoredConversation(options.existing);
    const plan = planContextSync({
      ...(stored === undefined ? {} : { stored }),
      request: canonicalRequest,
      hasAffinityPage:
        options.existing === undefined
          ? false
          : options.engine.pageRegistry.hasAffinity(options.conversationId),
    });
    return {
      canonicalRequest,
      ...(stored === undefined ? {} : { stored }),
      plan,
      preparedUploads: [],
      uploadFilenameByReference: new Map(),
      persistenceBindings: new Map(),
      release: async () => undefined,
    };
  }

  const current = await resolver.resolveAll(options.request.attachments, {
    requestId: options.request.requestId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  let retained: RetainedAttachmentHandle = { resolved: [], release: async () => undefined };
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await retained.release().catch(() => undefined);
    await current.release().catch(() => undefined);
  };

  try {
    if (options.existing !== undefined && options.existing.attachments.length > 0) {
      retained = await resolver.retainStored(options.existing.attachments);
    }
    const canonicalRequest = options.streaming
      ? toCanonicalPhase7StreamingConversationRequest(
          options.request,
          semanticMap(current.resolved),
        )
      : toCanonicalPhase7ConversationRequest(options.request, semanticMap(current.resolved));
    const stored =
      options.existing === undefined
        ? undefined
        : canonicalStoredConversation(options.existing, retained.resolved);
    const plan = planContextSync({
      ...(stored === undefined ? {} : { stored }),
      request: canonicalRequest,
      hasAffinityPage:
        options.existing === undefined
          ? false
          : options.engine.pageRegistry.hasAffinity(options.conversationId),
    });
    const uploadReferences = selectUploadAttachmentReferences(plan);
    const prepared =
      uploadReferences.length === 0 ? [] : await current.stage(uploadReferences, retained.resolved);
    const uploadFilenameByReference = new Map(
      prepared.map((item) => [item.localAttachmentId, item.uploadFilename]),
    );

    return {
      canonicalRequest,
      ...(stored === undefined ? {} : { stored }),
      plan,
      preparedUploads: prepared.map((item) => ({
        localAttachmentId: item.localAttachmentId,
        kind: item.kind,
        path: item.stagingPath,
        displayFilename: item.uploadFilename,
      })),
      uploadFilenameByReference,
      persistenceBindings: attachmentBindings({
        current: current.resolved,
        ...(options.existing === undefined ? {} : { storedAggregate: options.existing }),
        retained: retained.resolved,
      }),
      release,
    };
  } catch (error) {
    await release();
    throw error;
  }
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

function parseAssistantResult(options: {
  text: string;
  request: NormalizedRequest;
  randomUuid: () => string;
}): AssistantAggregateResult {
  const parsed = parseAssistantOutput(options.text, {
    tools: options.request.tools,
    toolChoice: options.request.toolChoice,
  });
  if (parsed.type === 'text') {
    validateStructuredAssistantText(parsed.text, options.request.output.structured);
    return parsed;
  }
  const toolCalls: NormalizedToolCall[] = parsed.calls.map((call) => ({
    id: `call_${options.randomUuid().replaceAll('-', '')}`,
    name: call.name,
    arguments: call.arguments,
  }));
  return { type: 'tool_calls', toolCalls };
}

function buildFinalResult(options: {
  engine: CreateConversationEngineOptions;
  existing?: ConversationAggregate;
  initial: ConversationAggregate;
  request: NormalizedRequest;
  canonicalRequest: CanonicalConversationRequest;
  plan: ContextSyncPlan;
  stored?: CanonicalStoredConversation;
  persistenceBindings?: ReadonlyMap<string, PersistenceAttachmentBinding>;
  assistantResult: AssistantAggregateResult;
  conversationUrl: string;
  completedAt: number;
}): NormalizedExecutionResult {
  const finalAggregate = buildFinalConversationAggregate({
    ...(options.existing === undefined ? {} : { stored: options.existing }),
    conversation: finalConversationRecord({
      existing: options.existing,
      initial: options.initial,
      request: options.request,
    }),
    ...(options.stored === undefined ? {} : { storedCanonicalMessages: options.stored.messages }),
    authoritativeMessages: authoritativeMessages({
      canonicalRequest: options.canonicalRequest,
      plan: options.plan,
      ...(options.stored === undefined ? {} : { stored: options.stored }),
    }),
    ...(options.persistenceBindings === undefined
      ? {}
      : { attachmentBindings: options.persistenceBindings }),
    assistantResult: options.assistantResult,
    conversationUrl: options.conversationUrl,
    completedAt: options.completedAt,
  });
  options.engine.conversationStore.save(finalAggregate);
  if (options.assistantResult.type === 'text') {
    return {
      type: 'text',
      text: options.assistantResult.text,
      conversationUrl: options.conversationUrl,
      completedAt: options.completedAt,
    };
  }
  return {
    type: 'tool_calls',
    toolCalls: options.assistantResult.toolCalls,
    conversationUrl: options.conversationUrl,
    completedAt: options.completedAt,
  };
}

async function executeConversation(options: {
  engine: CreateConversationEngineOptions;
  request: NormalizedRequest;
  conversationKey?: string;
  existing?: ConversationAggregate;
  now: () => number;
  randomUuid: () => string;
}): Promise<NormalizedExecutionResult> {
  const existing = options.existing;
  const conversationId = existing?.conversation.id ?? options.randomUuid();
  const context = await prepareConversationContext({
    engine: options.engine,
    request: options.request,
    ...(existing === undefined ? {} : { existing }),
    conversationId,
    streaming: false,
  });
  let session: ConversationPageSession | undefined;
  let completed = false;

  try {
    session = await options.engine.pageRegistry.acquire(conversationId);
    const promptMode = await preparePage({
      driver: options.engine.driver,
      session,
      plan: context.plan,
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
      request: options.request,
      canonicalRequest: context.canonicalRequest,
      plan: context.plan,
      stored: context.stored,
      uploadFilenameByReference: context.uploadFilenameByReference,
    });
    const result: ChatGptTextResult = await options.engine.driver.sendText(session.page, {
      prompt,
      ...(context.preparedUploads.length === 0 ? {} : { attachments: context.preparedUploads }),
    });
    const completedAt = options.now();
    const assistantResult = parseAssistantResult({
      text: result.text,
      request: options.request,
      randomUuid: options.randomUuid,
    });
    const finalResult = buildFinalResult({
      engine: options.engine,
      existing,
      initial,
      request: options.request,
      canonicalRequest: context.canonicalRequest,
      plan: context.plan,
      stored: context.stored,
      persistenceBindings: context.persistenceBindings,
      assistantResult,
      conversationUrl: result.conversationUrl,
      completedAt,
    });
    await session.complete();
    completed = true;
    return finalResult;
  } finally {
    try {
      if (!completed) await session?.fail();
    } finally {
      await context.release();
    }
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
  streamOptions: StreamingExecutionOptions;
  conversationKey?: string;
  existing?: ConversationAggregate;
  now: () => number;
  randomUuid: () => string;
}): Promise<NormalizedExecutionResult> {
  const existing = options.existing;
  const conversationId = existing?.conversation.id ?? options.randomUuid();
  const context = await prepareConversationContext({
    engine: options.engine,
    request: options.request,
    ...(existing === undefined ? {} : { existing }),
    conversationId,
    streaming: true,
    signal: options.streamOptions.signal,
  });
  const driver = requireStreamingDriver(options.engine.driver);
  let session: ConversationPageSession | undefined;
  let completed = false;
  let turn: ChatGptTextTurn | undefined;

  try {
    session = await options.engine.pageRegistry.acquire(conversationId);
    const promptMode = await preparePage({
      driver,
      session,
      plan: context.plan,
      conversationUrl: existing?.conversation.chatgptConversationUrl,
    });
    const startedAt = options.now();
    await options.streamOptions.sink({ type: 'started', startedAt });
    if (options.streamOptions.signal.aborted) throw new TextStreamAbortedError();

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
      request: options.request,
      canonicalRequest: context.canonicalRequest,
      plan: context.plan,
      stored: context.stored,
      uploadFilenameByReference: context.uploadFilenameByReference,
    });
    turn = await driver.startText(session.page, {
      prompt,
      signal: options.streamOptions.signal,
      ...(context.preparedUploads.length === 0 ? {} : { attachments: context.preparedUploads }),
    });
    const detector = new ToolDetectionBuffer(options.request.tools.length > 0);
    const assistantText = await streamAssistantText({
      observe: turn.observe,
      onDelta: async (delta) => {
        for (const safeDelta of detector.push(delta)) {
          await options.streamOptions.sink({ type: 'text.delta', delta: safeDelta });
        }
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
    for (const safeDelta of detector.finish()) {
      await options.streamOptions.sink({ type: 'text.delta', delta: safeDelta });
    }
    const conversationUrl = await turn.conversationUrl();
    const completedAt = options.now();
    const assistantResult = parseAssistantResult({
      text: assistantText,
      request: options.request,
      randomUuid: options.randomUuid,
    });
    const finalResult = buildFinalResult({
      engine: options.engine,
      existing,
      initial,
      request: options.request,
      canonicalRequest: context.canonicalRequest,
      plan: context.plan,
      stored: context.stored,
      persistenceBindings: context.persistenceBindings,
      assistantResult,
      conversationUrl,
      completedAt,
    });
    await session.complete();
    completed = true;
    try {
      if (finalResult.type === 'tool_calls') {
        await options.streamOptions.sink({ type: 'tool_calls', toolCalls: finalResult.toolCalls });
      }
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
    try {
      if (!completed) await session?.fail();
    } finally {
      await context.release();
    }
  }
}

function requestHistoryLength(request: CanonicalConversationRequest): number {
  const last = request.messages.at(-1);
  if (!last) return 0;
  if (last.role === 'user') return request.messages.length - 1;
  if (last.role !== 'tool') return 0;
  let start = request.messages.length - 1;
  while (start > 0 && request.messages[start - 1]?.role === 'tool') start -= 1;
  return start;
}

function anonymousContinuation(options: {
  engine: CreateConversationEngineOptions;
  request: NormalizedRequest;
}): ConversationAggregate | undefined {
  if (options.request.attachments.length > 0) return undefined;

  let canonicalRequest: CanonicalConversationRequest;
  try {
    canonicalRequest = options.request.output.stream
      ? toCanonicalPhase7StreamingConversationRequest(options.request)
      : toCanonicalPhase7ConversationRequest(options.request);
  } catch {
    return undefined;
  }
  if (canonicalRequest.mode !== 'full') return undefined;

  const historyLength = requestHistoryLength(canonicalRequest);
  if (historyLength <= 0) return undefined;

  let match: ConversationAggregate | undefined;
  for (const candidate of options.engine.conversationStore.loadAnonymousBySyncedMessageCount(
    historyLength,
  )) {
    if (candidate.attachments.length > 0) continue;
    let stored: CanonicalStoredConversation;
    try {
      stored = canonicalStoredConversation(candidate);
    } catch {
      continue;
    }
    const plan = planContextSync({
      stored,
      request: canonicalRequest,
      hasAffinityPage: options.engine.pageRegistry.hasAffinity(candidate.conversation.id),
    });
    if (plan.mode !== 'APPEND' && plan.mode !== 'RESTORE') continue;
    if (match !== undefined) return undefined;
    match = candidate;
  }
  return match;
}

function anonymousQueueKey(conversationId: string): string {
  return `anonymous:${conversationId}`;
}

function executeHandler(
  options: CreateConversationEngineOptions,
  now: () => number,
  randomUuid: () => string,
): NormalizedExecutionHandler {
  return async (request) => {
    const conversationKey = request.conversationKey;
    if (conversationKey === undefined) {
      const existing = anonymousContinuation({ engine: options, request });
      if (existing === undefined) {
        return executeConversation({
          engine: options,
          request,
          now,
          randomUuid,
        });
      }
      return options.queue.run(anonymousQueueKey(existing.conversation.id), async () => {
        const current = anonymousContinuation({ engine: options, request });
        if (current?.conversation.id !== existing.conversation.id) {
          return executeConversation({
            engine: options,
            request,
            now,
            randomUuid,
          });
        }
        return executeConversation({
          engine: options,
          request,
          existing: current,
          now,
          randomUuid,
        });
      });
    }

    return options.queue.run(conversationKey, async () => {
      const existing = options.conversationStore.loadByKey(conversationKey);
      return executeConversation({
        engine: options,
        request,
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
        const existing = anonymousContinuation({ engine: options, request });
        if (existing === undefined) {
          return streamConversation({
            engine: options,
            request,
            streamOptions,
            now,
            randomUuid,
          });
        }
        return options.queue.run(anonymousQueueKey(existing.conversation.id), async () => {
          const current = anonymousContinuation({ engine: options, request });
          if (current?.conversation.id !== existing.conversation.id) {
            return streamConversation({
              engine: options,
              request,
              streamOptions,
              now,
              randomUuid,
            });
          }
          return streamConversation({
            engine: options,
            request,
            streamOptions,
            existing: current,
            now,
            randomUuid,
          });
        });
      }

      return options.queue.run(conversationKey, async () => {
        const existing = options.conversationStore.loadByKey(conversationKey);
        return streamConversation({
          engine: options,
          request,
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
