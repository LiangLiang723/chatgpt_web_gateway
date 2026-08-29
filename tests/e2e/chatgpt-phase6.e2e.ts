import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { ChatGptDriverError } from '../../src/chatgpt/errors.js';
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
  createImageToken,
} from './phase6-fixtures.js';
import { createPhase6ConversationKeys, type Phase6Scenario } from './phase6-scenarios.js';

export interface RunPhase6ChatGptE2EOptions {
  profileDir: string;
  proxyServer?: string;
  scenario?: Phase6Scenario;
}

export interface Phase6ChatGptE2EResult {
  imageDataUrl?: true;
  imageFileId?: true;
  txt?: true;
  pdf?: true;
  docx?: true;
  xlsx?: true;
  append?: true;
  restore?: true;
  streaming?: true;
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

function createRecordingDriver(calls: DriverCall[]): ChatGptStreamingTextDriver {
  const driver = createChatGptDriver();
  const record = (method: DriverCall['method'], request: ChatGptTextRequest): void => {
    calls.push({
      method,
      attachments: [...(request.attachments ?? [])].map((item) => ({ ...item })),
    });
  };
  const reportFailure = async (page: Page, error: unknown): Promise<void> => {
    if (!(error instanceof ChatGptDriverError)) return;
    const composer = page.locator('#prompt-textarea');
    const composerCount = await composer.count().catch(() => -1);
    const composerTextLength =
      composerCount === 1
        ? await composer
            .innerText()
            .then((value) => value.length)
            .catch(() => -1)
        : -1;
    const sendCount = await page
      .locator('[data-testid="send-button"]')
      .count()
      .catch(() => -1);
    const userTurns = await inspectCollection(page, chatGptSelectors.userTurns).catch(
      () => undefined,
    );
    const attachmentTiles = await inspectCollection(page, chatGptSelectors.attachmentTiles).catch(
      () => undefined,
    );
    const uploadAlerts = await inspectCollection(
      page,
      chatGptSelectors.attachmentUploadAlerts,
    ).catch(() => undefined);
    const uploadAlertText =
      uploadAlerts && uploadAlerts.count > 0
        ? await uploadAlerts.locator
            .allInnerTexts()
            .then((items) => items.join(' | ').replaceAll('\n', ' ').slice(0, 300))
            .catch(() => 'unavailable')
        : 'none';
    const activeElement = await page
      .evaluate(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLElement)) return 'none';
        return `${element.tagName.toLowerCase()}#${element.id || '-'}:${element.getAttribute('contenteditable') ?? '-'}`;
      })
      .catch(() => 'unavailable');
    const composerButtons = await page
      .locator('#prompt-textarea ~ * button, form button')
      .evaluateAll((buttons) =>
        buttons.slice(-12).map((button) => ({
          testId: button.getAttribute('data-testid'),
          ariaLabel: button.getAttribute('aria-label'),
          type: button.getAttribute('type'),
          disabled: button.hasAttribute('disabled'),
          text: (button.textContent ?? '').trim().slice(0, 80),
        })),
      )
      .catch(() => []);
    process.stderr.write(
      `[phase6-driver] code=${error.code} selector=${error.selectorName ?? 'none'} candidate=${error.candidateName ?? 'none'} composerCount=${composerCount} composerTextLength=${composerTextLength} sendCount=${sendCount} userTurns=${userTurns?.count ?? -1} attachmentTiles=${attachmentTiles?.count ?? -1} uploadAlert=${JSON.stringify(uploadAlertText)} active=${activeElement} buttons=${JSON.stringify(composerButtons)} message=${error.message}\n`,
    );
  };
  return {
    openFresh: (page) => driver.openFresh(page),
    openConversation: (page, url) => driver.openConversation(page, url),
    async sendText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextResult> {
      record('sendText', request);
      try {
        return await driver.sendText(page, request);
      } catch (error) {
        await reportFailure(page, error);
        throw error;
      }
    },
    async startText(page: Page, request: ChatGptTextRequest): Promise<ChatGptTextTurn> {
      record('startText', request);
      try {
        return await driver.startText(page, request);
      } catch (error) {
        await reportFailure(page, error);
        throw error;
      }
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
  const isImageToken = expected === 'RED' || expected === 'BLUE';
  assert.equal(
    isImageToken ? normalized === expected : normalized.includes(expected),
    true,
    `${label} did not contain expected token ${expected}; actual: ${text}`,
  );
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
  const conversationKeys = createPhase6ConversationKeys(randomUUID());
  const scenario = options.scenario ?? 'all';
  const result: Phase6ChatGptE2EResult = {};

  try {
    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      calls,
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });
    baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });

    if (scenario === 'all' || scenario === 'images') {
      const imageDataToken = createImageToken();
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
                  text: 'Identify the dominant color of the image newly attached in this message. Reply with RED or BLUE only.',
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
        conversationKeys.images,
      );
      await assertHttpOk(imageDataResponse, 'Data URL image request');
      assertContainsToken(
        chatText(await imageDataResponse.json()),
        imageDataToken,
        'Data URL image',
      );
      assertAttachmentPersistence(runtime, conversationKeys.images, 1);

      const imageFileToken = createImageToken(imageDataToken);
      const imageFileId = await uploadPublicFile({
        baseUrl,
        filename: 'phase6-image-file-id.png',
        mimeType: 'image/png',
        bytes: buildPngTokenFixture(imageFileToken),
      });
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
                {
                  type: 'input_text',
                  text: 'Identify the dominant color of only the image newly attached in this message, ignoring earlier images. Reply with RED or BLUE only.',
                },
                { type: 'input_image', file_id: imageFileId },
              ],
            },
          ],
        },
        conversationKeys.images,
      );
      await assertHttpOk(imageFileResponse, 'image file_id request');
      assertContainsToken(
        responsesText(await imageFileResponse.json()),
        imageFileToken,
        'image file_id',
      );
      assertAttachmentPersistence(runtime, conversationKeys.images, 2);
      result.imageDataUrl = true;
      result.imageFileId = true;
    }

    if (scenario === 'all' || scenario === 'documents' || scenario === 'xlsx') {
      const xlsxToken = uniqueToken('P6XLSX');
      const xlsxId = await uploadPublicFile({
        baseUrl,
        filename: 'phase6-token.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: buildXlsxFixture(xlsxToken),
      });
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
                  text: 'Read cell A1 only from the XLSX newly attached in this message. Reply with its token only.',
                },
                {
                  type: 'input_file',
                  file_id: xlsxId,
                },
              ],
            },
          ],
        },
        conversationKeys.documentsPrimary,
      );
      await assertHttpOk(xlsxResponse, 'XLSX request');
      assertContainsToken(responsesText(await xlsxResponse.json()), xlsxToken, 'XLSX file_id');
      assertAttachmentPersistence(runtime, conversationKeys.documentsPrimary, 1);
      result.xlsx = true;
    }

    if (scenario === 'all' || scenario === 'documents') {
      const txtToken = uniqueToken('P6TXT');
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
                  text: 'Read only the text file newly attached in this message, ignoring earlier attachments. Reply with its unique token only.',
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
        conversationKeys.documentsPrimary,
      );
      await assertHttpOk(txtResponse, 'TXT request');
      assertContainsToken(chatText(await txtResponse.json()), txtToken, 'TXT direct Base64');
      assertAttachmentPersistence(runtime, conversationKeys.documentsPrimary, 2);

      const pdfToken = uniqueToken('P6PDF');
      const pdfId = await uploadPublicFile({
        baseUrl,
        filename: 'phase6-token.pdf',
        mimeType: 'application/pdf',
        bytes: buildPdfFixture(pdfToken),
      });
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
                  text: 'Read only the PDF newly attached in this message, ignoring earlier attachments. Reply with its unique token only.',
                },
                { type: 'input_file', file_id: pdfId },
              ],
            },
          ],
        },
        conversationKeys.documentsSecondary,
      );
      await assertHttpOk(pdfResponse, 'PDF request');
      assertContainsToken(responsesText(await pdfResponse.json()), pdfToken, 'PDF file_id');
      assertAttachmentPersistence(runtime, conversationKeys.documentsSecondary, 1);

      const docxToken = uniqueToken('P6DOCX');
      const docxId = await uploadPublicFile({
        baseUrl,
        filename: 'phase6-token.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: buildDocxFixture(docxToken),
      });
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
                {
                  type: 'text',
                  text: 'Read only the DOCX newly attached in this message, ignoring earlier attachments. Reply with its unique token only.',
                },
                { type: 'file', file: { file_id: docxId } },
              ],
            },
          ],
        },
        conversationKeys.documentsSecondary,
      );
      await assertHttpOk(docxResponse, 'DOCX request');
      assertContainsToken(chatText(await docxResponse.json()), docxToken, 'DOCX file_id');
      assertAttachmentPersistence(runtime, conversationKeys.documentsSecondary, 2);
      result.txt = true;
      result.pdf = true;
      result.docx = true;
    }

    if (scenario === 'all' || scenario === 'memory' || scenario === 'streaming') {
      const memoryToken = uniqueToken('P6MEM');
      const memoryKey = conversationKeys.memory;
      const beforeMemoryCalls = calls.length;
      const memorySeedResponse = await postJson(
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
                  text: 'Read only the text file newly attached in this message. Remember its token for later turns. Produce at least 30 short numbered lines, with the file token on line 1 and line 30. Do not use a writing block or table.',
                },
                {
                  type: 'file',
                  file: {
                    file_data: buildTextFixture(memoryToken).toString('base64'),
                    filename: 'phase6-memory-stream.txt',
                  },
                },
              ],
            },
          ],
        },
        memoryKey,
      );
      assert.equal(memorySeedResponse.status, 200);
      assert.match(memorySeedResponse.headers.get('content-type') ?? '', /text\/event-stream/);
      let sawLiveDelta = false;
      const frames = await readSse(memorySeedResponse, async (frame) => {
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
      assertContainsToken(streamed, memoryToken, 'attachment streaming memory seed');
      assert.equal(streamed, await liveAssistantText(runtime));
      assert.equal(streamed, persistedAssistant(runtime, memoryKey));
      assert.equal(calls[beforeMemoryCalls]?.attachments.length, 1);
      assertAttachmentPersistence(runtime, memoryKey, 1);
      result.streaming = true;

      if (scenario !== 'streaming') {
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
                  'Repeat the token from the file I attached in the immediately preceding user message. Reply with that token only.',
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
        assertAttachmentPersistence(runtime, memoryKey, 1);

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
                  'After this restart, repeat the token from the file attached in the most recent user message that included a file. Reply with that token only.',
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
        assertAttachmentPersistence(runtime, memoryKey, 1);
        result.append = true;
        result.restore = true;
      }
    }

    return result;
  } finally {
    await runtime?.close();
    profile.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
