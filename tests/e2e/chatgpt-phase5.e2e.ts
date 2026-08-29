import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChatGptDriver, type ChatGptStreamingTextDriver } from '../../src/chatgpt/driver.js';
import { inspectCollection, inspectUnique } from '../../src/chatgpt/selector-registry.js';
import { chatGptSelectors } from '../../src/chatgpt/selectors.js';
import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../src/runtime.js';
import { normalizeAssistantText } from '../../src/stream/normalize.js';
import { longestCommonPrefix } from '../../src/stream/stable-prefix.js';
import { cloneRealE2EProfile } from './profile.js';

export interface RunPhase5ChatGptE2EOptions {
  profileDir: string;
  proxyServer?: string;
  runAbortScenario?: boolean;
}

export interface Phase5ChatGptE2EResult {
  chatCompletions: true;
  markdown: true;
  responses: true;
  abort: true | 'not_run_in_combined';
}

interface DriverProbeError {
  phase: 'startText' | 'observe' | 'conversationUrl' | 'stop';
  name: string | null;
  code: string | null;
  message: string | null;
  selectorName: string | null;
  candidateName: string | null;
  causeMessage: string | null;
}

interface SnapshotTransition {
  previousCodePoints: number;
  currentCodePoints: number;
  commonPrefixCodePoints: number;
  rewrittenTailCodePoints: number;
}

interface StopProbe {
  calls: number;
  outcomes: Array<'stopped' | 'already_complete'>;
  errors: DriverProbeError[];
  transitions: SnapshotTransition[];
}

interface SseFrame {
  event?: string;
  data: string;
}

interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

interface ChatCompletionStreamError {
  code: string | null;
  message: string;
}

interface ResponseMessageEventItem {
  id: string;
  content?: Array<{ text?: string }>;
}

interface ResponseEventBody {
  sequence_number: number;
  response?: {
    id: string;
    output: ResponseMessageEventItem[];
  };
  item?: ResponseMessageEventItem;
  item_id?: string;
  text?: string;
  part?: { text?: string };
  delta?: string;
}

function token(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function probeError(phase: DriverProbeError['phase'], error: unknown): DriverProbeError {
  const value = typeof error === 'object' && error !== null ? error : undefined;
  const cause = value && 'cause' in value ? value.cause : undefined;
  const causeValue = typeof cause === 'object' && cause !== null ? cause : undefined;
  return {
    phase,
    name: value && 'name' in value && typeof value.name === 'string' ? value.name : null,
    code: value && 'code' in value && typeof value.code === 'string' ? value.code : null,
    message:
      value && 'message' in value && typeof value.message === 'string' ? value.message : null,
    selectorName:
      value && 'selectorName' in value && typeof value.selectorName === 'string'
        ? value.selectorName
        : null,
    candidateName:
      value && 'candidateName' in value && typeof value.candidateName === 'string'
        ? value.candidateName
        : null,
    causeMessage:
      causeValue && 'message' in causeValue && typeof causeValue.message === 'string'
        ? causeValue.message
        : null,
  };
}

function createStopProbedDriver(stopProbe: StopProbe): ChatGptStreamingTextDriver {
  const driver = createChatGptDriver();
  return {
    openFresh: (page) => driver.openFresh(page),
    openConversation: (page, conversationUrl) => driver.openConversation(page, conversationUrl),
    sendText: (page, request) => driver.sendText(page, request),
    async startText(page, request) {
      let previousObservedText: string | undefined;
      let turn;
      try {
        turn = await driver.startText(page, request);
      } catch (error) {
        stopProbe.errors.push(probeError('startText', error));
        throw error;
      }
      return {
        async observe() {
          try {
            const observation = await turn.observe();
            if (observation.exists) {
              const current = normalizeAssistantText(observation.text);
              if (previousObservedText !== undefined) {
                const previousCodePoints = Array.from(previousObservedText).length;
                const currentCodePoints = Array.from(current).length;
                const commonPrefixCodePoints = Array.from(
                  longestCommonPrefix([previousObservedText, current]),
                ).length;
                stopProbe.transitions.push({
                  previousCodePoints,
                  currentCodePoints,
                  commonPrefixCodePoints,
                  rewrittenTailCodePoints: previousCodePoints - commonPrefixCodePoints,
                });
                if (stopProbe.transitions.length > 24) stopProbe.transitions.shift();
              }
              previousObservedText = current;
            }
            return observation;
          } catch (error) {
            stopProbe.errors.push(probeError('observe', error));
            throw error;
          }
        },
        async conversationUrl() {
          try {
            return await turn.conversationUrl();
          } catch (error) {
            stopProbe.errors.push(probeError('conversationUrl', error));
            throw error;
          }
        },
        async stop() {
          stopProbe.calls += 1;
          try {
            const outcome = await turn.stop();
            stopProbe.outcomes.push(outcome);
            return outcome;
          } catch (error) {
            stopProbe.errors.push(probeError('stop', error));
            throw error;
          }
        },
      };
    },
  };
}

async function createRuntime(options: {
  dataDir: string;
  profileDir: string;
  proxyServer?: string;
  driver?: ChatGptStreamingTextDriver;
}): Promise<GatewayRuntime> {
  return createGatewayRuntime({
    config: loadConfig({
      GATEWAY_API_KEY: 'phase5-e2e-gateway-key',
      DATA_DIR: options.dataDir,
      MAX_ACTIVE_PAGES: '1',
      PAGE_IDLE_TIMEOUT_MINUTES: '30',
      ...(options.proxyServer ? { CHATGPT_PROXY_SERVER: options.proxyServer } : {}),
    }),
    browserProfileDir: options.profileDir,
    ...(options.driver ? { driver: options.driver } : {}),
    logger: false,
  });
}

function parseFrame(block: string): SseFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice('event: '.length);
    if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
  }
  if (data.length === 0) return undefined;
  return { ...(event === undefined ? {} : { event }), data: data.join('\n') };
}

async function readSse(
  response: Response,
  onFrame?: (frame: SseFrame) => Promise<void>,
): Promise<SseFrame[]> {
  assert.ok(response.body, 'Expected a streaming response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let delimiter = buffer.indexOf('\n\n');
    while (delimiter >= 0) {
      const raw = buffer.slice(0, delimiter);
      buffer = buffer.slice(delimiter + 2);
      const frame = parseFrame(raw);
      if (frame) {
        frames.push(frame);
        await onFrame?.(frame);
      }
      delimiter = buffer.indexOf('\n\n');
    }
    if (done) break;
  }

  return frames;
}

function chatChunk(frame: SseFrame): ChatCompletionChunk | undefined {
  if (frame.data === '[DONE]') return undefined;
  const body = JSON.parse(frame.data) as { choices?: unknown };
  return Array.isArray(body.choices) ? (body as ChatCompletionChunk) : undefined;
}

function chatStreamError(frame: SseFrame): ChatCompletionStreamError | undefined {
  if (frame.data === '[DONE]') return undefined;
  const body = JSON.parse(frame.data) as {
    error?: { code?: unknown; message?: unknown };
  };
  if (!body.error) return undefined;
  return {
    code: typeof body.error.code === 'string' ? body.error.code : null,
    message: typeof body.error.message === 'string' ? body.error.message : 'Unknown stream error',
  };
}

function chatDelta(frame: SseFrame): string | undefined {
  const body = chatChunk(frame);
  const content = body?.choices[0]?.delta.content;
  return typeof content === 'string' && content.length > 0 ? content : undefined;
}

function responseDelta(frame: SseFrame): string | undefined {
  if (frame.event !== 'response.output_text.delta') return undefined;
  const body = JSON.parse(frame.data) as { delta?: unknown };
  return typeof body.delta === 'string' && body.delta.length > 0 ? body.delta : undefined;
}

async function liveAssistantText(runtime: GatewayRuntime): Promise<string> {
  const page = runtime.browser?.context.pages().at(-1);
  assert.ok(page, 'Expected a live ChatGPT page');
  const turns = await inspectCollection(page, chatGptSelectors.assistantTurns);
  assert.ok(turns.count > 0, 'Expected at least one Assistant turn');
  const content = chatGptSelectors.assistantTextContent.locate(turns.locator.nth(turns.count - 1));
  assert.equal(await content.count(), 1, 'Expected one authoritative Assistant text content node');
  return content.innerText();
}

async function liveAssistantCodeBlockCount(runtime: GatewayRuntime): Promise<number> {
  const page = runtime.browser?.context.pages().at(-1);
  assert.ok(page, 'Expected a live ChatGPT page');
  const turns = await inspectCollection(page, chatGptSelectors.assistantTurns);
  assert.ok(turns.count > 0, 'Expected at least one Assistant turn');
  const content = chatGptSelectors.assistantTextContent.locate(turns.locator.nth(turns.count - 1));
  assert.equal(await content.count(), 1, 'Expected one authoritative Assistant text content node');
  return content.locator('pre').count();
}

async function assertCurrentTurnStillGenerating(runtime: GatewayRuntime): Promise<void> {
  const page = runtime.browser?.context.pages().at(-1);
  assert.ok(page, 'Expected a live ChatGPT page');
  const turns = await inspectCollection(page, chatGptSelectors.assistantTurns);
  assert.ok(
    turns.count > 0,
    'Expected the target Assistant turn to exist after a meaningful delta',
  );
  const turn = turns.locator.nth(turns.count - 1);
  const marker = chatGptSelectors.assistantTurnCompletion.locate(turn);
  assert.equal(
    await marker.count(),
    0,
    'First meaningful API delta must arrive before the target Assistant completion marker',
  );
}

function persistedAssistant(runtime: GatewayRuntime, conversationKey: string): string {
  const aggregate = runtime.persistence.conversationStore.loadByKey(conversationKey);
  assert.ok(aggregate, `Expected persisted Conversation ${conversationKey}`);
  assert.equal(aggregate.conversation.sync.status, 'clean');
  const assistant = aggregate.messages.at(-1);
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.content.length, 1);
  const part = assistant?.content[0];
  assert.equal(part?.type, 'text');
  return part.type === 'text' ? part.text : '';
}

async function postStream(options: {
  baseUrl: string;
  path: '/v1/chat/completions' | '/v1/responses';
  conversationKey: string;
  payload: unknown;
}): Promise<Response> {
  return fetch(`${options.baseUrl}${options.path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer phase5-e2e-gateway-key',
      'content-type': 'application/json',
      'x-conversation-key': options.conversationKey,
    },
    body: JSON.stringify(options.payload),
  });
}

export async function runPhase5ChatGptE2E(
  options: RunPhase5ChatGptE2EOptions,
): Promise<Phase5ChatGptE2EResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cwg-phase5-e2e-'));
  const profile = cloneRealE2EProfile(options.profileDir);
  const stopProbe: StopProbe = { calls: 0, outcomes: [], errors: [], transitions: [] };
  let runtime: GatewayRuntime | undefined;

  try {
    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      driver: createStopProbedDriver(stopProbe),
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });
    const baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });

    const mainKey = `phase5-stream-${randomUUID()}`;
    const chatMarker = token('CWG_PHASE5_LONG');
    const chatPrompt = `Produce at least 20 short numbered lines. Put ${chatMarker} on both the first and last line.`;
    const chatResponse = await postStream({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: mainKey,
      payload: {
        model: 'chatgpt-web',
        stream: true,
        messages: [
          {
            role: 'user',
            content: chatPrompt,
          },
        ],
      },
    });
    assert.equal(chatResponse.status, 200);
    assert.match(chatResponse.headers.get('content-type') ?? '', /text\/event-stream/);
    let checkedLiveGeneration = false;
    const chatFrames = await readSse(chatResponse, async (frame) => {
      if (!checkedLiveGeneration && chatDelta(frame)) {
        checkedLiveGeneration = true;
        await assertCurrentTurnStillGenerating(runtime!);
      }
    });
    const chatErrors = chatFrames
      .map(chatStreamError)
      .filter((value): value is ChatCompletionStreamError => value !== undefined);
    assert.deepEqual(
      chatErrors,
      [],
      `Unexpected Chat Completions stream errors: ${JSON.stringify(chatErrors)} driverErrors=${JSON.stringify(stopProbe.errors)}`,
    );
    assert.equal(checkedLiveGeneration, true, 'Expected at least one meaningful live text delta');
    const chatDeltas = chatFrames
      .map(chatDelta)
      .filter((value): value is string => value !== undefined);
    assert.ok(chatDeltas.length > 1, 'Expected multiple Chat Completions deltas');
    const chatText = chatDeltas.join('');
    const chatChunks = chatFrames
      .map(chatChunk)
      .filter((value): value is ChatCompletionChunk => value !== undefined);
    assert.ok(chatChunks.length > chatDeltas.length, 'Expected role and terminal chunks');
    assert.equal(new Set(chatChunks.map((chunk) => chunk.id)).size, 1);
    assert.equal(new Set(chatChunks.map((chunk) => chunk.created)).size, 1);
    assert.deepEqual(new Set(chatChunks.map((chunk) => chunk.model)), new Set(['chatgpt-web']));
    assert.deepEqual(
      new Set(chatChunks.map((chunk) => chunk.object)),
      new Set(['chat.completion.chunk']),
    );
    assert.equal(
      chatChunks.filter((chunk) => chunk.choices[0]?.delta.role === 'assistant').length,
      1,
      'Expected exactly one Assistant role chunk',
    );
    const finishChunks = chatChunks.filter((chunk) => chunk.choices[0]?.finish_reason !== null);
    assert.equal(finishChunks.length, 1, 'Expected exactly one terminal finish chunk');
    assert.equal(finishChunks[0]?.choices[0]?.finish_reason, 'stop');
    assert.deepEqual(finishChunks[0]?.choices[0]?.delta, {});
    assert.equal(chatFrames.filter((frame) => frame.data === '[DONE]').length, 1);
    assert.match(chatText, new RegExp(chatMarker));
    assert.equal(chatText, await liveAssistantText(runtime));
    assert.equal(chatText, persistedAssistant(runtime, mainKey));

    stopProbe.transitions.length = 0;
    const markdownPrompt =
      'Use the normal chat reply, not a writing block. Reply with exactly one fenced text code block containing two lines: phase-five-code and line-two.';
    const markdownResponse = await postStream({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: mainKey,
      payload: {
        model: 'chatgpt-web',
        stream: true,
        messages: [
          { role: 'user', content: chatPrompt },
          { role: 'assistant', content: chatText },
          { role: 'user', content: markdownPrompt },
        ],
      },
    });
    assert.equal(markdownResponse.status, 200);
    const markdownFrames = await readSse(markdownResponse);
    const markdownErrors = markdownFrames
      .map(chatStreamError)
      .filter((value): value is ChatCompletionStreamError => value !== undefined);
    assert.deepEqual(
      markdownErrors,
      [],
      `Unexpected Markdown stream errors: ${JSON.stringify(markdownErrors)} driverErrors=${JSON.stringify(stopProbe.errors)} transitions=${JSON.stringify(stopProbe.transitions)}`,
    );
    const markdownText = markdownFrames
      .map(chatDelta)
      .filter((value): value is string => value !== undefined)
      .join('');
    assert.equal(markdownText, await liveAssistantText(runtime));
    assert.equal(markdownText, persistedAssistant(runtime, mainKey));
    assert.ok(
      (await liveAssistantCodeBlockCount(runtime)) > 0,
      'Expected a rendered fenced code block',
    );
    assert.ok(markdownText.includes('\n'), 'Expected multiline Markdown output');

    const responsesMarker = token('CWG_PHASE5_RESP');
    const responsesPrompt = `Produce at least 12 short lines. Put ${responsesMarker} on the final line.`;
    const responsesResponse = await postStream({
      baseUrl,
      path: '/v1/responses',
      conversationKey: mainKey,
      payload: {
        model: 'chatgpt-web',
        stream: true,
        input: [
          { role: 'user', content: chatPrompt },
          { role: 'assistant', content: chatText },
          { role: 'user', content: markdownPrompt },
          { role: 'assistant', content: markdownText },
          { role: 'user', content: responsesPrompt },
        ],
      },
    });
    assert.equal(responsesResponse.status, 200);
    const responseFrames = await readSse(responsesResponse);
    const responseErrors = responseFrames
      .filter((frame) => frame.event === 'error')
      .map((frame) => {
        const body = JSON.parse(frame.data) as { code?: unknown; message?: unknown };
        return {
          code: typeof body.code === 'string' ? body.code : null,
          message:
            typeof body.message === 'string' ? body.message : 'Unknown Responses stream error',
        };
      });
    assert.deepEqual(
      responseErrors,
      [],
      `Unexpected Responses stream errors: ${JSON.stringify(responseErrors)} driverErrors=${JSON.stringify(stopProbe.errors)}`,
    );
    const responseEvents = responseFrames.map((frame) => frame.event);
    assert.deepEqual(responseEvents.slice(0, 4), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
    ]);
    assert.deepEqual(responseEvents.slice(-4), [
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    assert.ok(
      responseEvents.slice(4, -4).every((event) => event === 'response.output_text.delta'),
      'Expected only output_text.delta events between Responses start and completion lifecycle',
    );
    const responseBodies = responseFrames.map(
      (frame) => JSON.parse(frame.data) as ResponseEventBody,
    );
    const sequenceNumbers = responseBodies.map((body) => body.sequence_number);
    assert.deepEqual(
      sequenceNumbers,
      sequenceNumbers.map((_, index) => index + 1),
    );
    const responseId = responseBodies[0]?.response?.id;
    const messageId = responseBodies[2]?.item?.id;
    assert.ok(responseId, 'Expected a stable Responses response id');
    assert.ok(messageId, 'Expected a stable Responses message id');
    assert.equal(responseBodies[1]?.response?.id, responseId);
    assert.equal(responseBodies[3]?.item_id, messageId);
    for (let index = 4; index < responseBodies.length - 4; index += 1) {
      assert.equal(responseBodies[index]?.item_id, messageId);
    }
    const outputTextDone = responseBodies.at(-4)!;
    const contentPartDone = responseBodies.at(-3)!;
    const outputItemDone = responseBodies.at(-2)!;
    const completedBody = responseBodies.at(-1)!;
    assert.equal(outputTextDone.item_id, messageId);
    assert.equal(contentPartDone.item_id, messageId);
    assert.equal(outputItemDone.item?.id, messageId);
    assert.equal(completedBody.response?.id, responseId);
    assert.equal(completedBody.response?.output[0]?.id, messageId);

    const responseDeltas = responseFrames
      .map(responseDelta)
      .filter((value): value is string => value !== undefined);
    assert.ok(responseDeltas.length > 1, 'Expected multiple Responses text deltas');
    const responsesText = responseDeltas.join('');
    assert.match(responsesText, new RegExp(responsesMarker));
    assert.equal(responsesText, await liveAssistantText(runtime));
    assert.equal(responsesText, persistedAssistant(runtime, mainKey));
    assert.equal(outputTextDone.text, responsesText);
    assert.equal(contentPartDone.part?.text, responsesText);
    assert.equal(outputItemDone.item?.content?.[0]?.text, responsesText);
    assert.equal(completedBody.response?.output[0]?.content?.[0]?.text, responsesText);

    if (options.runAbortScenario === false) {
      return {
        chatCompletions: true,
        markdown: true,
        responses: true,
        abort: 'not_run_in_combined',
      };
    }

    const abortKey = `phase5-abort-${randomUUID()}`;
    const abortBaselinePrompt = 'Reply exactly with: ABORT_BASELINE_OK';
    const abortBaseline = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer phase5-e2e-gateway-key',
        'content-type': 'application/json',
        'x-conversation-key': abortKey,
      },
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: false,
        messages: [{ role: 'user', content: abortBaselinePrompt }],
      }),
    });
    assert.equal(abortBaseline.status, 200, await abortBaseline.text());
    const baselineAggregate = runtime.persistence.conversationStore.loadByKey(abortKey);
    assert.ok(baselineAggregate, 'Expected a clean abort baseline Conversation');
    assert.equal(baselineAggregate.conversation.sync.status, 'clean');
    const abortConversationId = baselineAggregate.conversation.id;
    const baselineConversationUrl = baselineAggregate.conversation.chatgptConversationUrl;
    assert.ok(baselineConversationUrl, 'Expected the abort baseline ChatGPT Conversation URL');
    assert.equal(runtime.pageRegistry?.hasAffinity(abortConversationId), true);
    const baselineAssistant = persistedAssistant(runtime, abortKey);
    const abortLongPrompt =
      'Produce 100 numbered lines, each with a different short sentence. Do not stop early.';
    const abortPage = runtime.browser?.context.pages().at(-1);
    assert.ok(abortPage, 'Expected the live abort ChatGPT page');
    const abortTurnBaseline = (await inspectCollection(abortPage, chatGptSelectors.assistantTurns))
      .count;

    const abortController = new AbortController();
    const abortResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: abortController.signal,
      headers: {
        authorization: 'Bearer phase5-e2e-gateway-key',
        'content-type': 'application/json',
        'x-conversation-key': abortKey,
      },
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: true,
        messages: [
          { role: 'user', content: abortBaselinePrompt },
          { role: 'assistant', content: baselineAssistant },
          { role: 'user', content: abortLongPrompt },
        ],
      }),
    });
    assert.equal(abortResponse.status, 200);
    assert.ok(abortResponse.body);
    const reader = abortResponse.body.getReader();

    const generatingDeadline = Date.now() + 10_000;
    let sawGeneratingTarget = false;
    while (Date.now() < generatingDeadline) {
      const turns = await inspectCollection(abortPage, chatGptSelectors.assistantTurns);
      if (turns.count > abortTurnBaseline) {
        const target = turns.locator.nth(abortTurnBaseline);
        const completionMarkerCount = await chatGptSelectors.assistantTurnCompletion
          .locate(target)
          .count();
        const stopControl = await inspectUnique(abortPage, chatGptSelectors.stopControl);
        if (completionMarkerCount === 0 && stopControl.status === 'unique') {
          sawGeneratingTarget = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      sawGeneratingTarget,
      true,
      'Expected a new generating Assistant target before client abort',
    );

    abortController.abort();
    await reader.cancel().catch(() => undefined);

    const abortDeadline = Date.now() + 10_000;
    while (Date.now() < abortDeadline) {
      const saved = runtime.persistence.conversationStore.loadByKey(abortKey);
      const stopSettled =
        stopProbe.outcomes.length === 1 || stopProbe.errors.some((error) => error.phase === 'stop');
      const cleanupFinished =
        saved?.conversation.sync.status === 'in_flight' &&
        stopSettled &&
        runtime.pageRegistry?.hasAffinity(abortConversationId) === false &&
        abortPage.isClosed();
      if (cleanupFinished) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const inFlightAggregate = runtime.persistence.conversationStore.loadByKey(abortKey);
    assert.ok(inFlightAggregate, 'Expected the aborted Conversation to remain persisted');
    assert.equal(inFlightAggregate.conversation.id, abortConversationId);
    assert.equal(inFlightAggregate.conversation.sync.status, 'in_flight');
    assert.equal(inFlightAggregate.conversation.chatgptConversationUrl, baselineConversationUrl);
    assert.equal(stopProbe.calls, 1, 'Expected exactly one real ChatGPT Stop attempt');
    assert.deepEqual(
      stopProbe.outcomes,
      ['stopped'],
      `Stop must begin before the target Assistant turn is already complete; driverErrors=${JSON.stringify(stopProbe.errors)}`,
    );
    assert.equal(
      runtime.pageRegistry?.hasAffinity(abortConversationId),
      false,
      'Aborted Page must not remain as clean Conversation affinity',
    );

    assert.equal(
      abortPage.isClosed(),
      true,
      'Aborted Page must be closed after failed-session cleanup',
    );

    const rebuildPrompt = 'Reply exactly with: ABORT_REBUILD_OK';
    const rebuild = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer phase5-e2e-gateway-key',
        'content-type': 'application/json',
        'x-conversation-key': abortKey,
      },
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: false,
        messages: [
          { role: 'user', content: abortBaselinePrompt },
          { role: 'assistant', content: baselineAssistant },
          { role: 'user', content: rebuildPrompt },
        ],
      }),
    });
    assert.equal(rebuild.status, 200, await rebuild.text());
    const rebuiltAggregate = runtime.persistence.conversationStore.loadByKey(abortKey);
    assert.ok(rebuiltAggregate, 'Expected the aborted Conversation to converge after REBUILD');
    assert.equal(rebuiltAggregate.conversation.id, abortConversationId);
    assert.equal(rebuiltAggregate.conversation.sync.status, 'clean');
    assert.notEqual(
      rebuiltAggregate.conversation.chatgptConversationUrl,
      baselineConversationUrl,
      'REBUILD after abort must move to a new ChatGPT Conversation URL',
    );

    const rebuildPage = runtime.browser?.context.pages().at(-1);
    assert.ok(rebuildPage, 'Expected a live ChatGPT Page after abort REBUILD');
    const rebuildUserTurns = await inspectCollection(rebuildPage, chatGptSelectors.userTurns);
    assert.ok(rebuildUserTurns.count > 0, 'Expected a ChatGPT Web user turn after abort REBUILD');
    const rebuildWebUserTurn = await rebuildUserTurns.locator
      .nth(rebuildUserTurns.count - 1)
      .innerText();
    assert.match(
      rebuildWebUserTurn,
      /ABORT_REBUILD_OK/,
      `REBUILD Web user turn must contain the current prompt; webUser=${JSON.stringify(rebuildWebUserTurn)}`,
    );
    assert.doesNotMatch(
      rebuildWebUserTurn,
      /Produce 100 numbered lines/,
      `REBUILD Web user turn must exclude the aborted pending prompt; webUser=${JSON.stringify(rebuildWebUserTurn)}`,
    );

    const rebuildPersistedAssistant = persistedAssistant(runtime, abortKey);
    const rebuildLiveAssistant = await liveAssistantText(runtime);
    assert.equal(
      rebuildPersistedAssistant,
      rebuildLiveAssistant,
      'REBUILD persisted Assistant must equal the authoritative live Assistant text',
    );
    assert.match(
      rebuildPersistedAssistant,
      /ABORT_REBUILD_OK/,
      `Unexpected abort REBUILD Assistant; baselineAssistant=${JSON.stringify(baselineAssistant)} webUser=${JSON.stringify(rebuildWebUserTurn)}`,
    );

    return {
      chatCompletions: true,
      markdown: true,
      responses: true,
      abort: true,
    };
  } finally {
    await runtime?.close();
    profile.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
