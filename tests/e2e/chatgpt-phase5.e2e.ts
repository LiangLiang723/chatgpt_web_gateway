import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';

import { createChatGptDriver, type ChatGptStreamingTextDriver } from '../../src/chatgpt/driver.js';
import { inspectCollection, inspectUnique } from '../../src/chatgpt/selector-registry.js';
import { chatGptSelectors } from '../../src/chatgpt/selectors.js';
import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../src/runtime.js';
import { cloneRealE2EProfile } from './profile.js';

export interface RunPhase5ChatGptE2EOptions {
  profileDir: string;
  proxyServer?: string;
}

export interface Phase5ChatGptE2EResult {
  chatCompletions: true;
  markdown: true;
  responses: true;
  abort: true;
}

interface DriverProbeError {
  phase: 'startText' | 'observe' | 'conversationUrl';
  name: string | null;
  code: string | null;
  message: string | null;
  selectorName: string | null;
  candidateName: string | null;
  causeMessage: string | null;
}

interface StopProbe {
  calls: number;
  outcomes: Array<'stopped' | 'already_complete'>;
  errors: DriverProbeError[];
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
            return await turn.observe();
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
          const outcome = await turn.stop();
          stopProbe.outcomes.push(outcome);
          return outcome;
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

async function liveAssistantCodeBlockMarkerCount(
  runtime: GatewayRuntime,
  marker: string,
): Promise<{ codeBlocks: number; markerCount: number }> {
  const page = runtime.browser?.context.pages().at(-1);
  assert.ok(page, 'Expected a live ChatGPT page');
  const turns = await inspectCollection(page, chatGptSelectors.assistantTurns);
  assert.ok(turns.count > 0, 'Expected at least one Assistant turn');
  const content = chatGptSelectors.assistantTextContent.locate(turns.locator.nth(turns.count - 1));
  assert.equal(await content.count(), 1, 'Expected one authoritative Assistant text content node');
  const codeBlocks = content.locator('pre');
  const count = await codeBlocks.count();
  let markerCount = 0;
  for (let index = 0; index < count; index += 1) {
    const text = await codeBlocks.nth(index).innerText();
    markerCount += text.split(marker).length - 1;
  }
  return { codeBlocks: count, markerCount };
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
  const stopProbe: StopProbe = { calls: 0, outcomes: [], errors: [] };
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
    const chatPrompt = `Reply directly in the ordinary chat message body only. Do not use a writing block, artifact, canvas, editor, or table. Produce at least 20 short numbered lines and put ${chatMarker} on the first and last line.`;
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

    const markdownMarker = token('CWG_PHASE5_MD');
    const markdownPrompt = `Reply directly in the ordinary chat message body only; do not use a writing block, artifact, canvas, or editor. Return exactly one rendered Markdown message with no extra prose: a level-1 heading whose text is "Phase 5 Markdown"; a three-item bullet list containing exactly "alpha", "beta", and "gamma"; then one fenced text code block containing exactly two lines. The first code-block line must be exactly ${markdownMarker}. The second code-block line must be exactly line-two. Do not repeat ${markdownMarker} anywhere else.`;
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
      `Unexpected Markdown stream errors: ${JSON.stringify(markdownErrors)} driverErrors=${JSON.stringify(stopProbe.errors)}`,
    );
    const markdownText = markdownFrames
      .map(chatDelta)
      .filter((value): value is string => value !== undefined)
      .join('');
    assert.equal(
      markdownText.split(markdownMarker).length - 1,
      1,
      'Expected the Markdown code marker exactly once',
    );
    const codeBlockEvidence = await liveAssistantCodeBlockMarkerCount(runtime, markdownMarker);
    assert.ok(codeBlockEvidence.codeBlocks > 0, 'Expected a rendered fenced code block');
    assert.equal(
      codeBlockEvidence.markerCount,
      1,
      'Expected the unique marker inside the code block',
    );
    assert.match(markdownText, /line-two/);
    assert.ok(markdownText.includes('\n'), 'Expected multiline Markdown output');
    assert.equal(markdownText, await liveAssistantText(runtime));
    assert.equal(markdownText, persistedAssistant(runtime, mainKey));

    const responsesMarker = token('CWG_PHASE5_RESP');
    const responsesPrompt = `Reply directly in the ordinary chat message body only. Do not use a writing block, artifact, canvas, or editor. Produce at least 12 short lines and include ${responsesMarker} on the final line.`;
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
      'Reply directly in the ordinary chat message body only. Do not use a writing block, artifact, canvas, or editor. Produce 100 numbered lines, each with a different short sentence. Do not stop early.';

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
    const decoder = new TextDecoder();
    let abortBuffer = '';
    const abortFrames: SseFrame[] = [];
    let sawAbortDelta = false;
    while (!sawAbortDelta) {
      const { value, done } = await reader.read();
      if (value) abortBuffer += decoder.decode(value, { stream: !done });
      let delimiter = abortBuffer.indexOf('\n\n');
      while (delimiter >= 0) {
        const raw = abortBuffer.slice(0, delimiter);
        abortBuffer = abortBuffer.slice(delimiter + 2);
        const frame = parseFrame(raw);
        if (frame) {
          abortFrames.push(frame);
          if (chatDelta(frame)) {
            sawAbortDelta = true;
            break;
          }
        }
        delimiter = abortBuffer.indexOf('\n\n');
      }
      if (done && !sawAbortDelta) {
        const errors = abortFrames
          .map(chatStreamError)
          .filter((value): value is ChatCompletionStreamError => value !== undefined);
        const chunks = abortFrames
          .map(chatChunk)
          .filter((value): value is ChatCompletionChunk => value !== undefined);
        const finishReasons = chunks
          .map((chunk) => chunk.choices[0]?.finish_reason)
          .filter((value): value is string => typeof value === 'string');
        const page: Page | undefined = runtime.browser?.context.pages().at(-1);
        const structure: {
          urlPath: string;
          userTurns: number;
          assistantTurns: number;
          rateLimitModal: string;
          stopControl: string;
        } | null = page
          ? {
              urlPath: new URL(page.url()).pathname,
              userTurns: (await inspectCollection(page, chatGptSelectors.userTurns)).count,
              assistantTurns: (await inspectCollection(page, chatGptSelectors.assistantTurns))
                .count,
              rateLimitModal: (
                await inspectUnique(page, chatGptSelectors.conversationHistoryRateLimitModal)
              ).status,
              stopControl: (await inspectUnique(page, chatGptSelectors.stopControl)).status,
            }
          : null;
        assert.fail(
          `Streaming response ended before a meaningful abort delta: errors=${JSON.stringify(errors)} done=${abortFrames.filter((frame) => frame.data === '[DONE]').length} chunks=${chunks.length} finishReasons=${JSON.stringify(finishReasons)} structure=${JSON.stringify(structure)} driverErrors=${JSON.stringify(stopProbe.errors)}`,
        );
      }
    }
    await assertCurrentTurnStillGenerating(runtime);
    const abortPage = runtime.browser?.context.pages().at(-1);
    assert.ok(abortPage, 'Expected the live abort ChatGPT page');
    const abortTurns = await inspectCollection(abortPage, chatGptSelectors.assistantTurns);
    assert.ok(abortTurns.count > 0, 'Expected a live abort Assistant turn');
    const abortTurn = abortTurns.locator.nth(abortTurns.count - 1);
    assert.equal(
      await chatGptSelectors.assistantTurnCompletion.locate(abortTurn).count(),
      0,
      'Abort must happen while the target Assistant turn is still generating',
    );

    abortController.abort();
    await reader.cancel().catch(() => undefined);

    const abortDeadline = Date.now() + 10_000;
    while (Date.now() < abortDeadline) {
      const saved = runtime.persistence.conversationStore.loadByKey(abortKey);
      const cleanupFinished =
        saved?.conversation.sync.status === 'in_flight' &&
        stopProbe.outcomes.length === 1 &&
        runtime.pageRegistry?.hasAffinity(abortConversationId) === false;
      if (cleanupFinished) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const inFlightAggregate = runtime.persistence.conversationStore.loadByKey(abortKey);
    assert.ok(inFlightAggregate, 'Expected the aborted Conversation to remain persisted');
    assert.equal(inFlightAggregate.conversation.id, abortConversationId);
    assert.equal(inFlightAggregate.conversation.sync.status, 'in_flight');
    assert.equal(inFlightAggregate.conversation.chatgptConversationUrl, baselineConversationUrl);
    assert.equal(stopProbe.calls, 1, 'Expected exactly one real ChatGPT Stop attempt');
    assert.deepEqual(stopProbe.outcomes, ['stopped']);
    assert.equal(
      runtime.pageRegistry?.hasAffinity(abortConversationId),
      false,
      'Aborted Page must not remain as clean Conversation affinity',
    );

    const postAbortMarkerCount = await chatGptSelectors.assistantTurnCompletion
      .locate(abortTurn)
      .count();
    const postAbortStopControl = await inspectUnique(abortPage, chatGptSelectors.stopControl);
    assert.ok(
      postAbortMarkerCount === 1 || postAbortStopControl.status === 'missing',
      'Aborted target must reach a stopped/terminal DOM state',
    );
    const abortContent = chatGptSelectors.assistantTextContent.locate(abortTurn);
    assert.equal(await abortContent.count(), 1, 'Expected one aborted Assistant text content node');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stoppedText1 = await abortContent.innerText();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stoppedText2 = await abortContent.innerText();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stoppedText3 = await abortContent.innerText();
    assert.equal(stoppedText2, stoppedText1, 'Stopped Assistant text must no longer grow');
    assert.equal(stoppedText3, stoppedText2, 'Stopped Assistant text must remain stable');

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
    assert.match(persistedAssistant(runtime, abortKey), /ABORT_REBUILD_OK/);

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
