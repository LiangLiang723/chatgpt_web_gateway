import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';

import {
  createChatGptDriver,
  type ChatGptStreamingTextDriver,
  type ChatGptTextRequest,
  type ChatGptTextResult,
  type ChatGptTextTurn,
} from '../../src/chatgpt/driver.js';
import { inspectCollection } from '../../src/chatgpt/selector-registry.js';
import { chatGptSelectors } from '../../src/chatgpt/selectors.js';
import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../src/runtime.js';
import { TOOL_PROTOCOL_END, TOOL_PROTOCOL_START } from '../../src/tools/protocol.js';
import { cloneRealE2EProfile } from './profile.js';

export interface RunPhase7ChatGptE2EOptions {
  profileDir: string;
  proxyServer?: string;
}

export interface Phase7ChatGptE2EResult {
  singleTool: true;
  resultContinuation: true;
  policyRebuild: true;
  multipleTools: true;
  streamTool: true;
  streamText: true;
  restore: true;
  schemaRebuild: true;
}

interface DriverCall {
  method: 'openFresh' | 'openConversation' | 'sendText' | 'startText';
  prompt?: string;
  conversationUrl?: string;
  assistantText?: string;
}

interface SseFrame {
  event?: string;
  data: string;
}

function token(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

function createRecordingDriver(calls: DriverCall[]): ChatGptStreamingTextDriver {
  const driver = createChatGptDriver();
  return {
    async openFresh(page: Page): Promise<void> {
      calls.push({ method: 'openFresh' });
      return driver.openFresh(page);
    },
    async openConversation(
      page: Page,
      conversationUrl: string,
    ): Promise<'restored' | 'not_restorable'> {
      calls.push({ method: 'openConversation', conversationUrl });
      return driver.openConversation(page, conversationUrl);
    },
    async sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
      const call: DriverCall = { method: 'sendText', prompt: request.prompt };
      calls.push(call);
      const result = await driver.sendText(page, request);
      call.assistantText = result.text;
      return result;
    },
    async startText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextTurn> {
      calls.push({ method: 'startText', prompt: request.prompt });
      return driver.startText(page, request);
    },
  };
}

async function createRuntime(options: {
  dataDir: string;
  profileDir: string;
  calls: DriverCall[];
  proxyServer?: string;
}): Promise<GatewayRuntime> {
  return createGatewayRuntime({
    config: loadConfig({
      GATEWAY_API_KEY: 'phase7-e2e-gateway-key',
      DATA_DIR: options.dataDir,
      MAX_ACTIVE_PAGES: '1',
      PAGE_IDLE_TIMEOUT_MINUTES: '30',
      ...(options.proxyServer ? { CHATGPT_PROXY_SERVER: options.proxyServer } : {}),
    }),
    browserProfileDir: options.profileDir,
    driver: createRecordingDriver(options.calls),
    logger: false,
  });
}

function headers(conversationKey: string): Record<string, string> {
  return {
    authorization: 'Bearer phase7-e2e-gateway-key',
    'content-type': 'application/json',
    'x-conversation-key': conversationKey,
  };
}

async function postJson(options: {
  baseUrl: string;
  path: '/v1/chat/completions' | '/v1/responses';
  conversationKey: string;
  body: unknown;
}): Promise<Response> {
  return fetch(`${options.baseUrl}${options.path}`, {
    method: 'POST',
    headers: headers(options.conversationKey),
    body: JSON.stringify(options.body),
  });
}

async function assertHttpOk(
  response: Response,
  label: string,
  assistantText?: string,
): Promise<void> {
  if (response.status === 200) return;
  const diagnostic = assistantText === undefined ? '' : `\nRaw Assistant text: ${assistantText}`;
  assert.fail(`${label} returned HTTP ${response.status}: ${await response.text()}${diagnostic}`);
}

function chatToolCalls(body: unknown): Array<{ id: string; name: string; arguments: string }> {
  const choice = (
    body as {
      choices?: Array<{
        finish_reason?: unknown;
        message?: {
          content?: unknown;
          tool_calls?: Array<{
            id?: unknown;
            type?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          }>;
        };
      }>;
    }
  ).choices?.[0];
  assert.equal(
    choice?.finish_reason,
    'tool_calls',
    `Unexpected tool body: ${JSON.stringify(body)}`,
  );
  assert.equal(choice?.message?.content, null);
  const calls = choice?.message?.tool_calls ?? [];
  assert.ok(calls.length > 0, `Expected tool calls: ${JSON.stringify(body)}`);
  return calls.map((call) => {
    assert.equal(call.type, 'function');
    assert.equal(typeof call.id, 'string');
    assert.equal(typeof call.function?.name, 'string');
    assert.equal(typeof call.function?.arguments, 'string');
    JSON.parse(call.function!.arguments as string);
    return {
      id: call.id as string,
      name: call.function!.name as string,
      arguments: call.function!.arguments as string,
    };
  });
}

function chatText(body: unknown): string {
  const choice = (
    body as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> }
  ).choices?.[0];
  assert.equal(choice?.finish_reason, 'stop', `Unexpected text body: ${JSON.stringify(body)}`);
  assert.equal(typeof choice?.message?.content, 'string');
  return choice!.message!.content as string;
}

function assertArgumentToken(call: { arguments: string }, expected: string): void {
  const value = JSON.parse(call.arguments) as Record<string, unknown>;
  assert.equal(value.token, expected, `Unexpected arguments: ${call.arguments}`);
}

function conversationUrl(runtime: GatewayRuntime, key: string): string {
  const aggregate = runtime.persistence.conversationStore.loadByKey(key);
  assert.ok(aggregate, `Expected persisted Conversation ${key}`);
  assert.equal(aggregate.conversation.sync.status, 'clean');
  assert.ok(aggregate.conversation.chatgptConversationUrl);
  return aggregate.conversation.chatgptConversationUrl;
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
  assert.ok(response.body, 'Expected SSE body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let delimiter = buffer.indexOf('\n\n');
    while (delimiter >= 0) {
      const frame = parseFrame(buffer.slice(0, delimiter));
      buffer = buffer.slice(delimiter + 2);
      if (frame) {
        frames.push(frame);
        await onFrame?.(frame);
      }
      delimiter = buffer.indexOf('\n\n');
    }
    if (done) return frames;
  }
}

function chatDelta(frame: SseFrame): string | undefined {
  if (frame.data === '[DONE]') return undefined;
  const body = JSON.parse(frame.data) as {
    choices?: Array<{ delta?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.delta?.content;
  return typeof content === 'string' && content.length > 0 ? content : undefined;
}

async function assertCurrentTurnStillGenerating(runtime: GatewayRuntime): Promise<void> {
  const page = runtime.browser?.context.pages().at(-1);
  assert.ok(page, 'Expected a live ChatGPT page');
  const turns = await inspectCollection(page, chatGptSelectors.assistantTurns);
  assert.ok(turns.count > 0, 'Expected an Assistant turn');
  const marker = chatGptSelectors.assistantTurnCompletion.locate(
    turns.locator.nth(turns.count - 1),
  );
  assert.equal(await marker.count(), 0, 'Meaningful text delta must arrive before completion');
}

function functionTool(name: string, description: string) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: { token: { type: 'string' } },
        required: ['token'],
        additionalProperties: false,
      },
    },
  };
}

function responsesFunctionTool(name: string, description: string) {
  return {
    type: 'function' as const,
    name,
    description,
    parameters: {
      type: 'object',
      properties: { token: { type: 'string' } },
      required: ['token'],
      additionalProperties: false,
    },
  };
}

export async function runPhase7ChatGptE2E(
  options: RunPhase7ChatGptE2EOptions,
): Promise<Phase7ChatGptE2EResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cwg-phase7-e2e-'));
  const profile = cloneRealE2EProfile(options.profileDir);
  const firstCalls: DriverCall[] = [];
  let runtime: GatewayRuntime | undefined;
  let baseUrl: string | undefined;

  const restoreKey = `phase7-restore-${randomUUID()}`;
  const multipleKey = `phase7-multiple-${randomUUID()}`;
  const streamToolKey = `phase7-stream-tool-${randomUUID()}`;
  const streamTextKey = `phase7-stream-text-${randomUUID()}`;
  const schemaKey = `phase7-schema-${randomUUID()}`;

  try {
    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      calls: firstCalls,
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });
    baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });

    const echoToken = token('P7ECHO');
    const echoResponse = await postJson({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: restoreKey,
      body: {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content: `Call deterministic_echo with token ${echoToken}. After its result arrives, reply with the returned value only.`,
          },
        ],
        tools: [functionTool('deterministic_echo', 'Return a caller-supplied deterministic token')],
        tool_choice: { type: 'function', function: { name: 'deterministic_echo' } },
      },
    });
    await assertHttpOk(echoResponse, 'single tool', firstCalls.at(-1)?.assistantText);
    const firstToolCalls = chatToolCalls(await echoResponse.json());
    assert.equal(firstToolCalls.length, 1);
    assert.equal(firstToolCalls[0]!.name, 'deterministic_echo');
    assertArgumentToken(firstToolCalls[0]!, echoToken);
    const callId = firstToolCalls[0]!.id;
    assert.match(callId, /^call_[0-9a-f]{32}$/);
    const restoreUrl = conversationUrl(runtime, restoreKey);
    const persistedBeforeRestart = runtime.persistence.conversationStore.loadByKey(restoreKey)!;
    assert.equal(persistedBeforeRestart.toolCalls[0]?.externalCallId, callId);

    await runtime.close();
    runtime = undefined;

    const restartCalls: DriverCall[] = [];
    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      calls: restartCalls,
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });
    baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const resultToken = token('P7RESULT');
    const continuation = await postJson({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: restoreKey,
      body: {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'tool',
            tool_call_id: callId,
            content: resultToken,
          },
        ],
        tools: [functionTool('deterministic_echo', 'Return a caller-supplied deterministic token')],
        tool_choice: 'none',
      },
    });
    await assertHttpOk(
      continuation,
      'tool result continuation after restart',
      restartCalls.at(-1)?.assistantText,
    );
    assert.match(chatText(await continuation.json()), new RegExp(resultToken));
    const continuationUrl = conversationUrl(runtime, restoreKey);
    assert.notEqual(
      continuationUrl,
      restoreUrl,
      'function -> none policy change must REBUILD to a new ChatGPT URL',
    );
    assert.ok(
      restartCalls.some((call) => call.method === 'openFresh'),
      'Expected tool-result continuation to open a fresh ChatGPT conversation after policy change',
    );
    assert.equal(
      restartCalls.some(
        (call) => call.method === 'openConversation' && call.conversationUrl === restoreUrl,
      ),
      false,
      'Policy change must not RESTORE the old function-request conversation',
    );
    const afterContinuation = runtime.persistence.conversationStore.loadByKey(restoreKey)!;
    assert.equal(afterContinuation.toolCalls[0]?.externalCallId, callId);
    assert.ok(
      afterContinuation.messages.some(
        (message) => message.role === 'tool' && message.toolCallId === callId,
      ),
    );

    await runtime.close();
    runtime = undefined;

    const beforeStableRestoreCalls = restartCalls.length;
    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      calls: restartCalls,
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });
    baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const restoreProbeToken = token('P7RESTORE');
    const stableRestore = await postJson({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: restoreKey,
      body: {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content: `Reply exactly with ${restoreProbeToken}.`,
          },
        ],
        tools: [functionTool('deterministic_echo', 'Return a caller-supplied deterministic token')],
        tool_choice: 'none',
      },
    });
    await assertHttpOk(
      stableRestore,
      'stable-policy restart RESTORE',
      restartCalls.at(-1)?.assistantText,
    );
    assert.match(chatText(await stableRestore.json()), new RegExp(restoreProbeToken));
    assert.equal(
      conversationUrl(runtime, restoreKey),
      continuationUrl,
      'unchanged function policy restart must keep the ChatGPT URL',
    );
    const stableRestoreCalls = restartCalls.slice(beforeStableRestoreCalls);
    assert.ok(
      stableRestoreCalls.some(
        (call) => call.method === 'openConversation' && call.conversationUrl === continuationUrl,
      ),
      'Expected unchanged function policy to RESTORE the persisted ChatGPT URL',
    );
    assert.equal(
      stableRestoreCalls.some((call) => call.method === 'openFresh'),
      false,
      'Unchanged function policy must not REBUILD',
    );

    const leftToken = token('P7LEFT');
    const rightToken = token('P7RIGHT');
    const multiple = await postJson({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: multipleKey,
      body: {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content: `Call left_token once with token ${leftToken} and right_token once with token ${rightToken}. Return both tool calls in the same response.`,
          },
        ],
        tools: [
          functionTool('left_token', 'Accept the left deterministic token'),
          functionTool('right_token', 'Accept the right deterministic token'),
        ],
        tool_choice: 'required',
      },
    });
    await assertHttpOk(multiple, 'multiple tools');
    const many = chatToolCalls(await multiple.json());
    assert.equal(many.length, 2, `Expected exactly two calls: ${JSON.stringify(many)}`);
    assert.equal(new Set(many.map((call) => call.id)).size, 2);
    const byName = new Map(many.map((call) => [call.name, call]));
    assertArgumentToken(byName.get('left_token')!, leftToken);
    assertArgumentToken(byName.get('right_token')!, rightToken);

    const streamToolToken = token('P7STREAMTOOL');
    const streamTool = await postJson({
      baseUrl,
      path: '/v1/responses',
      conversationKey: streamToolKey,
      body: {
        model: 'chatgpt-web',
        stream: true,
        input: `Call stream_echo with token ${streamToolToken}. Do not answer directly.`,
        tools: [responsesFunctionTool('stream_echo', 'Accept the deterministic streaming token')],
        tool_choice: { type: 'function', name: 'stream_echo' },
      },
    });
    await assertHttpOk(streamTool, 'Responses stream tool');
    assert.match(streamTool.headers.get('content-type') ?? '', /text\/event-stream/);
    const toolFrames = await readSse(streamTool);
    const serializedToolFrames = toolFrames.map((frame) => frame.data).join('\n');
    assert.doesNotMatch(serializedToolFrames, new RegExp(TOOL_PROTOCOL_START));
    assert.doesNotMatch(serializedToolFrames, new RegExp(TOOL_PROTOCOL_END));
    assert.equal(
      toolFrames.filter((frame) => frame.event === 'response.function_call_arguments.done').length,
      1,
    );
    assert.equal(toolFrames.filter((frame) => frame.event === 'response.completed').length, 1);
    const argumentsDone = toolFrames.find(
      (frame) => frame.event === 'response.function_call_arguments.done',
    );
    assert.ok(argumentsDone);
    const argumentsBody = JSON.parse(argumentsDone.data) as { arguments?: string };
    assert.equal(typeof argumentsBody.arguments, 'string');
    assert.equal(
      (JSON.parse(argumentsBody.arguments!) as Record<string, unknown>).token,
      streamToolToken,
    );

    const textToken = token('P7TEXT');
    const streamText = await postJson({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: streamTextKey,
      body: {
        model: 'chatgpt-web',
        stream: true,
        messages: [
          {
            role: 'user',
            content: `Do not call tools. Write 24 numbered short lines. Include ${textToken} on line 1 and line 24.`,
          },
        ],
        tools: [functionTool('unused_tool', 'A tool that must not be called for this request')],
        tool_choice: 'auto',
      },
    });
    await assertHttpOk(streamText, 'auto text stream');
    let sawLiveTextDelta = false;
    const textFrames = await readSse(streamText, async (frame) => {
      if (!sawLiveTextDelta && chatDelta(frame)) {
        sawLiveTextDelta = true;
        await assertCurrentTurnStillGenerating(runtime!);
      }
    });
    assert.equal(sawLiveTextDelta, true, 'Expected public text delta before generation completed');
    const streamedText = textFrames
      .map(chatDelta)
      .filter((value): value is string => value !== undefined)
      .join('');
    assert.match(streamedText, new RegExp(textToken));
    assert.doesNotMatch(streamedText, new RegExp(TOOL_PROTOCOL_START));
    const textBodies = textFrames
      .filter((frame) => frame.data !== '[DONE]')
      .map((frame) => JSON.parse(frame.data) as { choices?: Array<{ finish_reason?: unknown }> });
    assert.equal(
      textBodies.some((body) => body.choices?.[0]?.finish_reason === 'tool_calls'),
      false,
    );
    assert.equal(textFrames.filter((frame) => frame.data === '[DONE]').length, 1);

    const oldTool = functionTool('old_lookup', 'Old schema marker');
    const schemaBaseline = await postJson({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: schemaKey,
      body: {
        model: 'chatgpt-web',
        stream: false,
        messages: [{ role: 'user', content: 'Reply exactly with SCHEMA_BASELINE.' }],
        tools: [oldTool],
        tool_choice: 'none',
      },
    });
    await assertHttpOk(schemaBaseline, 'schema baseline');
    assert.match(chatText(await schemaBaseline.json()), /SCHEMA_BASELINE/);
    const oldUrl = conversationUrl(runtime, schemaKey);
    const beforeSchemaCalls = restartCalls.length;
    const newToken = token('P7NEWSCHEMA');
    const schemaChanged = await postJson({
      baseUrl,
      path: '/v1/chat/completions',
      conversationKey: schemaKey,
      body: {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content: `Call new_lookup with token ${newToken}. Do not use any old tool.`,
          },
        ],
        tools: [functionTool('new_lookup', 'New schema marker')],
        tool_choice: { type: 'function', function: { name: 'new_lookup' } },
      },
    });
    await assertHttpOk(schemaChanged, 'schema change rebuild');
    const rebuiltCalls = chatToolCalls(await schemaChanged.json());
    assert.equal(rebuiltCalls.length, 1);
    assert.equal(rebuiltCalls[0]!.name, 'new_lookup');
    assertArgumentToken(rebuiltCalls[0]!, newToken);
    const newUrl = conversationUrl(runtime, schemaKey);
    assert.notEqual(newUrl, oldUrl, 'Tool schema change must REBUILD to a new ChatGPT URL');
    const schemaDriverCalls = restartCalls.slice(beforeSchemaCalls);
    assert.ok(schemaDriverCalls.some((call) => call.method === 'openFresh'));
    const schemaPrompt = schemaDriverCalls.find((call) => call.method === 'sendText')?.prompt ?? '';
    assert.match(schemaPrompt, /new_lookup/);
    assert.doesNotMatch(schemaPrompt, /Old schema marker/);

    return {
      singleTool: true,
      resultContinuation: true,
      policyRebuild: true,
      multipleTools: true,
      streamTool: true,
      streamText: true,
      restore: true,
      schemaRebuild: true,
    };
  } finally {
    await runtime?.close();
    profile.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
