import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';

import {
  createChatGptDriver,
  type ChatGptPreparedUpload,
  type ChatGptStreamingTextDriver,
  type ChatGptTextRequest,
  type ChatGptTextResult,
  type ChatGptTextTurn,
} from '../../src/chatgpt/driver.js';
import { inspectCollection } from '../../src/chatgpt/selector-registry.js';
import { chatGptSelectors } from '../../src/chatgpt/selectors.js';
import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../src/runtime.js';
import { cloneRealE2EProfile } from './profile.js';
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPngTokenFixture,
  buildTextFixture,
  buildXlsxFixture,
} from './phase6-fixtures.js';

export interface RunPhase6ChatGptE2EOptions {
  profileDir: string;
  proxyServer?: string;
}

export interface Phase6ChatGptE2EResult {
  imageDataUrl: true;
  imageFileId: true;
  txt: true;
  pdf: true;
  docx: true;
  xlsx: true;
  append: true;
  restore: true;
  streaming: true;
}

interface DriverCall {
  method: 'sendText' | 'startText';
  attachments: ChatGptPreparedUpload[];
}

interface SseFrame {
  event?: string;
  data: string;
}

function uniqueToken(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

function imageToken(): string {
  return `P6${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}

function createRecordingDriver(calls: DriverCall[]): ChatGptStreamingTextDriver {
  const driver = createChatGptDriver();
  const record = (method: DriverCall['method'], request: ChatGptTextRequest): void => {
    calls.push({
      method,
      attachments: [...(request.attachments ?? [])].map((item) => ({ ...item })),
    });
  };
  return {
    openFresh: (page) => driver.openFresh(page),
    openConversation: (page, url) => driver.openConversation(page, url),
    async sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
      record('sendText', request);
      return driver.sendText(page, request);
    },
    async startText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextTurn> {
      record('startText', request);
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
      GATEWAY_API_KEY: 'phase6-e2e-gateway-key',
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

function authHeaders(conversationKey?: string): Record<string, string> {
  return {
    authorization: 'Bearer phase6-e2e-gateway-key',
    ...(conversationKey === undefined ? {} : { 'x-conversation-key': conversationKey }),
  };
}

async function postJson(
  baseUrl: string,
  path: '/v1/chat/completions' | '/v1/responses',
  body: unknown,
  conversationKey: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...authHeaders(conversationKey),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function assertHttpOk(response: Response, label: string): Promise<void> {
  if (response.status === 200) return;
  const body = await response.text();
  assert.fail(`${label} returned HTTP ${response.status}: ${body}`);
}

async function uploadPublicFile(options: {
  baseUrl: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<string> {
  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append(
    'file',
    new Blob([Uint8Array.from(options.bytes)], { type: options.mimeType }),
    options.filename,
  );
  const response = await fetch(`${options.baseUrl}/v1/files`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  await assertHttpOk(response, '/v1/files upload');
  const body = (await response.json()) as { id?: unknown };
  assert.equal(typeof body.id, 'string');
  return body.id as string;
}

function chatText(body: unknown): string {
  const value = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
    ?.message?.content;
  assert.equal(typeof value, 'string', `Unexpected Chat Completions body: ${JSON.stringify(body)}`);
  return value as string;
}

function responsesText(body: unknown): string {
  const value = (
    body as {
      output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>;
    }
  ).output?.[0]?.content?.find((part) => part.type === 'output_text')?.text;
  assert.equal(typeof value, 'string', `Unexpected Responses body: ${JSON.stringify(body)}`);
  return value as string;
}

function assertContainsToken(text: string, token: string, label: string): void {
  if (text.includes(token)) return;
  const normalized = text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const expected = token.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const imageOcrEquivalent = normalized.replaceAll('E', '6');
  const imagePrefixVariants = expected.startsWith('P6')
    ? [expected.slice(1), expected.slice(2), `P${expected.slice(2)}`]
    : [];
  const distance = levenshtein(imageOcrEquivalent, expected);
  assert.equal(
    imageOcrEquivalent.includes(expected) ||
      imagePrefixVariants.some((variant) => imageOcrEquivalent === variant) ||
      distance <= 1,
    true,
    `${label} did not contain expected token: ${text}`,
  );
}

function levenshtein(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[right.length]!;
}

function assertAttachmentPersistence(
  runtime: GatewayRuntime,
  conversationKey: string,
  minimumAttachments = 1,
): void {
  const aggregate = runtime.persistence.conversationStore.loadByKey(conversationKey);
  assert.ok(aggregate, `Expected persisted Conversation ${conversationKey}`);
  assert.equal(aggregate.conversation.sync.status, 'clean');
  assert.ok(
    aggregate.attachments.length >= minimumAttachments,
    `Expected at least ${minimumAttachments} AttachmentRecords`,
  );
  for (const attachment of aggregate.attachments) {
    assert.deepEqual(Object.keys(attachment.source), ['type']);
    const file = runtime.persistence.files.getById(attachment.fileId);
    assert.ok(file, `Attachment ${attachment.id} references a missing File`);
    const blob = runtime.persistence.fileBlobs.getById(file.blobId);
    assert.ok(blob, `File ${file.id} references a missing Blob`);
  }
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

async function assertCurrentTurnStillGenerating(runtime: GatewayRuntime): Promise<void> {
  const page = runtime.browser?.context.pages().at(-1);
  assert.ok(page, 'Expected a live ChatGPT page');
  const turns = await inspectCollection(page, chatGptSelectors.assistantTurns);
  assert.ok(turns.count > 0, 'Expected target Assistant turn after a meaningful delta');
  const marker = chatGptSelectors.assistantTurnCompletion.locate(
    turns.locator.nth(turns.count - 1),
  );
  assert.equal(
    await marker.count(),
    0,
    'First meaningful attachment delta must arrive before the completion marker',
  );
}

function persistedAssistant(runtime: GatewayRuntime, conversationKey: string): string {
  const aggregate = runtime.persistence.conversationStore.loadByKey(conversationKey);
  assert.ok(aggregate, `Expected persisted Conversation ${conversationKey}`);
  assert.equal(aggregate.conversation.sync.status, 'clean');
  const assistant = aggregate.messages.at(-1);
  assert.equal(assistant?.role, 'assistant');
  const part = assistant?.content[0];
  assert.equal(part?.type, 'text');
  return part?.type === 'text' ? part.text : '';
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
  assert.ok(response.body, 'Expected SSE response body');
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
    if (done) return frames;
  }
}

function chatDelta(frame: SseFrame): string | undefined {
  if (frame.data === '[DONE]') return undefined;
  const body = JSON.parse(frame.data) as {
    choices?: Array<{ delta?: { content?: unknown } }>;
    error?: unknown;
  };
  const content = body.choices?.[0]?.delta?.content;
  return typeof content === 'string' && content.length > 0 ? content : undefined;
}

function chatStreamError(frame: SseFrame): string | undefined {
  if (frame.data === '[DONE]') return undefined;
  const body = JSON.parse(frame.data) as { error?: { code?: unknown; message?: unknown } };
  if (!body.error) return undefined;
  return `${String(body.error.code)}:${String(body.error.message)}`;
}

export async function runPhase6ChatGptE2E(
  options: RunPhase6ChatGptE2EOptions,
): Promise<Phase6ChatGptE2EResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cwg-phase6-e2e-'));
  const profile = cloneRealE2EProfile(options.profileDir);
  let runtime: GatewayRuntime | undefined;
  let baseUrl: string | undefined;
  const calls: DriverCall[] = [];

  try {
    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      calls,
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });
    baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });

    const imageDataToken = imageToken();
    const imageDataKey = `phase6-image-data-${randomUUID()}`;
    const imageDataResponse = await postJson(
      baseUrl,
      '/v1/chat/completions',
      {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Read the token visibly printed in the attached image. Reply with that token only.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${buildPngTokenFixture(imageDataToken).toString('base64')}`,
                },
              },
            ],
          },
        ],
      },
      imageDataKey,
    );
    await assertHttpOk(imageDataResponse, 'Data URL image request');
    assertContainsToken(chatText(await imageDataResponse.json()), imageDataToken, 'Data URL image');
    assertAttachmentPersistence(runtime, imageDataKey);

    const imageFileToken = imageToken();
    const imageFileId = await uploadPublicFile({
      baseUrl,
      filename: 'phase6-image-file-id.png',
      mimeType: 'image/png',
      bytes: buildPngTokenFixture(imageFileToken),
    });
    const imageFileKey = `phase6-image-file-${randomUUID()}`;
    const imageFileResponse = await postJson(
      baseUrl,
      '/v1/responses',
      {
        model: 'chatgpt-web',
        stream: false,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Read the visible image token and reply with it only.' },
              { type: 'input_image', file_id: imageFileId },
            ],
          },
        ],
      },
      imageFileKey,
    );
    await assertHttpOk(imageFileResponse, 'image file_id request');
    assertContainsToken(
      responsesText(await imageFileResponse.json()),
      imageFileToken,
      'image file_id',
    );
    assertAttachmentPersistence(runtime, imageFileKey);

    const txtToken = uniqueToken('P6TXT');
    const txtKey = `phase6-txt-${randomUUID()}`;
    const txtResponse = await postJson(
      baseUrl,
      '/v1/chat/completions',
      {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Read the attached text file. Reply with its unique token only.',
              },
              {
                type: 'file',
                file: {
                  file_data: buildTextFixture(txtToken).toString('base64'),
                  filename: 'phase6-token.txt',
                },
              },
            ],
          },
        ],
      },
      txtKey,
    );
    await assertHttpOk(txtResponse, 'TXT request');
    assertContainsToken(chatText(await txtResponse.json()), txtToken, 'TXT direct Base64');
    assertAttachmentPersistence(runtime, txtKey);

    const pdfToken = uniqueToken('P6PDF');
    const pdfId = await uploadPublicFile({
      baseUrl,
      filename: 'phase6-token.pdf',
      mimeType: 'application/pdf',
      bytes: buildPdfFixture(pdfToken),
    });
    const pdfKey = `phase6-pdf-${randomUUID()}`;
    const pdfResponse = await postJson(
      baseUrl,
      '/v1/responses',
      {
        model: 'chatgpt-web',
        stream: false,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Read the attached PDF. Reply with its unique token only.',
              },
              { type: 'input_file', file_id: pdfId },
            ],
          },
        ],
      },
      pdfKey,
    );
    await assertHttpOk(pdfResponse, 'PDF request');
    assertContainsToken(responsesText(await pdfResponse.json()), pdfToken, 'PDF file_id');
    assertAttachmentPersistence(runtime, pdfKey);

    const docxToken = uniqueToken('P6DOCX');
    const docxId = await uploadPublicFile({
      baseUrl,
      filename: 'phase6-token.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: buildDocxFixture(docxToken),
    });
    const docxKey = `phase6-docx-${randomUUID()}`;
    const docxResponse = await postJson(
      baseUrl,
      '/v1/chat/completions',
      {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read the attached DOCX. Reply with its unique token only.' },
              { type: 'file', file: { file_id: docxId } },
            ],
          },
        ],
      },
      docxKey,
    );
    await assertHttpOk(docxResponse, 'DOCX request');
    assertContainsToken(chatText(await docxResponse.json()), docxToken, 'DOCX file_id');
    assertAttachmentPersistence(runtime, docxKey);

    const xlsxToken = uniqueToken('P6XLSX');
    const xlsxId = await uploadPublicFile({
      baseUrl,
      filename: 'phase6-token.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: buildXlsxFixture(xlsxToken),
    });
    const xlsxKey = `phase6-xlsx-${randomUUID()}`;
    const xlsxResponse = await postJson(
      baseUrl,
      '/v1/responses',
      {
        model: 'chatgpt-web',
        stream: false,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Read cell A1 in the attached XLSX. Reply with its token only.',
              },
              {
                type: 'input_file',
                file_id: xlsxId,
              },
            ],
          },
        ],
      },
      xlsxKey,
    );
    await assertHttpOk(xlsxResponse, 'XLSX request');
    assertContainsToken(responsesText(await xlsxResponse.json()), xlsxToken, 'XLSX direct Base64');
    assertAttachmentPersistence(runtime, xlsxKey);

    const memoryToken = uniqueToken('P6MEM');
    const memoryKey = `phase6-memory-${randomUUID()}`;
    const beforeMemoryCalls = calls.length;
    const memoryFirst = await postJson(
      baseUrl,
      '/v1/chat/completions',
      {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Read the attached file and remember its token. Reply with the token only.',
              },
              {
                type: 'file',
                file: {
                  file_data: buildTextFixture(memoryToken).toString('base64'),
                  filename: 'phase6-memory.txt',
                },
              },
            ],
          },
        ],
      },
      memoryKey,
    );
    await assertHttpOk(memoryFirst, 'attachment memory first turn');
    assertContainsToken(chatText(await memoryFirst.json()), memoryToken, 'memory first turn');
    assert.equal(calls[beforeMemoryCalls]?.attachments.length, 1);

    const memorySecond = await postJson(
      baseUrl,
      '/v1/chat/completions',
      {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content:
              'Repeat the token from the file I attached previously. Reply with the token only.',
          },
        ],
      },
      memoryKey,
    );
    await assertHttpOk(memorySecond, 'attachment APPEND turn');
    assertContainsToken(
      chatText(await memorySecond.json()),
      memoryToken,
      'APPEND attachment context',
    );
    assert.equal(
      calls[beforeMemoryCalls + 1]?.attachments.length,
      0,
      'APPEND reuploaded old attachment',
    );
    assertAttachmentPersistence(runtime, memoryKey);

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
    const memoryThird = await postJson(
      baseUrl,
      '/v1/chat/completions',
      {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          {
            role: 'user',
            content:
              'After this restart, repeat the token from the file I attached earlier. Reply with the token only.',
          },
        ],
      },
      memoryKey,
    );
    await assertHttpOk(memoryThird, 'attachment RESTORE turn');
    assertContainsToken(
      chatText(await memoryThird.json()),
      memoryToken,
      'RESTORE attachment context',
    );
    assert.equal(restartCalls[0]?.attachments.length, 0, 'RESTORE reuploaded old attachment');
    assertAttachmentPersistence(runtime, memoryKey);

    const streamToken = uniqueToken('P6STREAM');
    const streamKey = `phase6-stream-${randomUUID()}`;
    const streamResponse = await postJson(
      baseUrl,
      '/v1/chat/completions',
      {
        model: 'chatgpt-web',
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Read the attached text file. Produce at least 12 short numbered lines. Put the file token on line 1 and line 12. Do not use a writing block or table.`,
              },
              {
                type: 'file',
                file: {
                  file_data: buildTextFixture(streamToken).toString('base64'),
                  filename: 'phase6-stream.txt',
                },
              },
            ],
          },
        ],
      },
      streamKey,
    );
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get('content-type') ?? '', /text\/event-stream/);
    let sawLiveDelta = false;
    const frames = await readSse(streamResponse, async (frame) => {
      if (!sawLiveDelta && chatDelta(frame)) {
        sawLiveDelta = true;
        await assertCurrentTurnStillGenerating(runtime!);
      }
    });
    assert.equal(sawLiveDelta, true, 'Expected at least one meaningful attachment stream delta');
    const errors = frames
      .map(chatStreamError)
      .filter((value): value is string => value !== undefined);
    assert.deepEqual(errors, []);
    assert.equal(frames.filter((frame) => frame.data === '[DONE]').length, 1);
    const streamed = frames
      .map(chatDelta)
      .filter((value): value is string => value !== undefined)
      .join('');
    assertContainsToken(streamed, streamToken, 'attachment streaming');
    assert.equal(streamed, await liveAssistantText(runtime));
    assert.equal(streamed, persistedAssistant(runtime, streamKey));
    assertAttachmentPersistence(runtime, streamKey);

    return {
      imageDataUrl: true,
      imageFileId: true,
      txt: true,
      pdf: true,
      docx: true,
      xlsx: true,
      append: true,
      restore: true,
      streaming: true,
    };
  } finally {
    await runtime?.close();
    profile.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
