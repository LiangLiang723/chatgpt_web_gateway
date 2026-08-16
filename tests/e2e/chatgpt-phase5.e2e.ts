import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectCollection } from '../../src/chatgpt/selector-registry.js';
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

interface SseFrame {
  event?: string;
  data: string;
}

function token(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

async function createRuntime(options: {
  dataDir: string;
  profileDir: string;
  proxyServer?: string;
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

function chatDelta(frame: SseFrame): string | undefined {
  if (frame.data === '[DONE]') return undefined;
  const body = JSON.parse(frame.data) as {
    choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
  };
  const content = body.choices?.[0]?.delta?.content;
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
  return turns.locator.nth(turns.count - 1).innerText();
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
  let runtime: GatewayRuntime | undefined;

  try {
    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });
    const baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });

    const chatKey = `phase5-chat-${randomUUID()}`;
    const chatMarker = token('CWG_PHASE5_LONG');
    const chatResponse = await postStream({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: chatKey,
      payload: {
        model: 'chatgpt-web',
        stream: true,
        messages: [
          {
            role: 'user',
            content: `Write at least 20 short numbered lines. Put ${chatMarker} on the first and last line. Do not use a table.`,
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
    assert.equal(checkedLiveGeneration, true, 'Expected at least one meaningful live text delta');
    const chatDeltas = chatFrames
      .map(chatDelta)
      .filter((value): value is string => value !== undefined);
    assert.ok(chatDeltas.length > 1, 'Expected multiple Chat Completions deltas');
    const chatText = chatDeltas.join('');
    assert.equal(chatFrames.filter((frame) => frame.data === '[DONE]').length, 1);
    assert.match(chatText, new RegExp(chatMarker));
    assert.equal(chatText, await liveAssistantText(runtime));
    assert.equal(chatText, persistedAssistant(runtime, chatKey));

    const markdownKey = `phase5-markdown-${randomUUID()}`;
    const markdownMarker = token('CWG_PHASE5_MD');
    const markdownResponse = await postStream({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: markdownKey,
      payload: {
        model: 'chatgpt-web',
        stream: true,
        messages: [
          {
            role: 'user',
            content: `Return a Markdown heading, a three-item list, and a fenced TypeScript code block. Include ${markdownMarker} exactly once.`,
          },
        ],
      },
    });
    assert.equal(markdownResponse.status, 200);
    const markdownFrames = await readSse(markdownResponse);
    const markdownText = markdownFrames
      .map(chatDelta)
      .filter((value): value is string => value !== undefined)
      .join('');
    assert.match(markdownText, /```/);
    assert.match(markdownText, new RegExp(markdownMarker));
    assert.equal(markdownText, await liveAssistantText(runtime));
    assert.equal(markdownText, persistedAssistant(runtime, markdownKey));

    const responsesKey = `phase5-responses-${randomUUID()}`;
    const responsesMarker = token('CWG_PHASE5_RESP');
    const responsesResponse = await postStream({
      baseUrl,
      path: '/v1/responses',
      conversationKey: responsesKey,
      payload: {
        model: 'chatgpt-web',
        stream: true,
        input: `Write at least 12 short lines and include ${responsesMarker} on the final line.`,
      },
    });
    assert.equal(responsesResponse.status, 200);
    const responseFrames = await readSse(responsesResponse);
    const responseEvents = responseFrames.map((frame) => frame.event);
    assert.equal(responseEvents[0], 'response.created');
    assert.equal(responseEvents.at(-1), 'response.completed');
    const sequenceNumbers = responseFrames.map(
      (frame) => (JSON.parse(frame.data) as { sequence_number: number }).sequence_number,
    );
    assert.deepEqual(
      sequenceNumbers,
      sequenceNumbers.map((_, index) => index + 1),
    );
    const responseDeltas = responseFrames
      .map(responseDelta)
      .filter((value): value is string => value !== undefined);
    assert.ok(responseDeltas.length > 1, 'Expected multiple Responses text deltas');
    const responsesText = responseDeltas.join('');
    assert.match(responsesText, new RegExp(responsesMarker));
    assert.equal(responsesText, await liveAssistantText(runtime));
    assert.equal(responsesText, persistedAssistant(runtime, responsesKey));
    const completedFrame = responseFrames.at(-1)!;
    const completedBody = JSON.parse(completedFrame.data) as {
      response: { output: Array<{ content: Array<{ text: string }> }> };
    };
    assert.equal(completedBody.response.output[0]?.content[0]?.text, responsesText);

    const abortKey = `phase5-abort-${randomUUID()}`;
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
          {
            role: 'user',
            content:
              'Write 100 numbered lines, each with a different short sentence. Do not stop early.',
          },
        ],
      }),
    });
    assert.equal(abortResponse.status, 200);
    assert.ok(abortResponse.body);
    const reader = abortResponse.body.getReader();
    const decoder = new TextDecoder();
    let abortBuffer = '';
    let sawAbortDelta = false;
    while (!sawAbortDelta) {
      const { value, done } = await reader.read();
      assert.equal(done, false, 'Streaming response ended before a meaningful abort delta');
      abortBuffer += decoder.decode(value, { stream: true });
      for (const block of abortBuffer.split('\n\n')) {
        const frame = parseFrame(block);
        if (frame && chatDelta(frame)) {
          sawAbortDelta = true;
          break;
        }
      }
    }
    abortController.abort();
    await reader.cancel().catch(() => undefined);

    const abortDeadline = Date.now() + 10_000;
    while (Date.now() < abortDeadline) {
      const saved = runtime.persistence.conversationStore.loadByKey(abortKey);
      if (saved?.conversation.sync.status === 'in_flight') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      runtime.persistence.conversationStore.loadByKey(abortKey)?.conversation.sync.status,
      'in_flight',
    );

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
        messages: [{ role: 'user', content: 'Reply exactly with: ABORT_REBUILD_OK' }],
      }),
    });
    assert.equal(rebuild.status, 200, await rebuild.text());
    assert.equal(
      runtime.persistence.conversationStore.loadByKey(abortKey)?.conversation.sync.status,
      'clean',
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
