import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateImageBytes } from '../../src/attachments/image.js';
import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../src/runtime.js';
import { cloneRealE2EProfile } from './profile.js';

export interface RunPhase8ChatGptE2EOptions {
  profileDir: string;
  proxyServer?: string;
}

export interface Phase8ChatGptE2EResult {
  url: true;
  base64: true;
  persistence: true;
  restart: true;
}

interface ImageGenerationResponse {
  created?: unknown;
  data?: Array<{ url?: unknown; b64_json?: unknown }>;
}

function authHeaders(): Record<string, string> {
  return { authorization: 'Bearer phase8-e2e-gateway-key' };
}

async function createRuntime(options: {
  dataDir: string;
  profileDir: string;
  proxyServer?: string;
  uiMode?: 'headless' | 'novnc';
}): Promise<GatewayRuntime> {
  return createGatewayRuntime({
    config: loadConfig({
      GATEWAY_API_KEY: 'phase8-e2e-gateway-key',
      DATA_DIR: options.dataDir,
      UI_MODE: options.uiMode ?? 'headless',
      MAX_ACTIVE_PAGES: '1',
      PAGE_IDLE_TIMEOUT_MINUTES: '30',
      ...(options.proxyServer ? { CHATGPT_PROXY_SERVER: options.proxyServer } : {}),
    }),
    browserProfileDir: options.profileDir,
    logger: false,
  });
}

async function postImage(
  baseUrl: string,
  body: unknown,
  label: string,
): Promise<ImageGenerationResponse> {
  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(`${label} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as ImageGenerationResponse;
}

async function getImageBytes(baseUrl: string, pathname: string, label: string): Promise<Buffer> {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: authHeaders() });
  if (response.status !== 200) {
    assert.fail(`${label} returned HTTP ${response.status}: ${await response.text()}`);
  }
  assert.match(response.headers.get('content-type') ?? '', /^image\//);
  return Buffer.from(await response.arrayBuffer());
}

function assertImageBytes(bytes: Buffer, label: string): void {
  assert.ok(bytes.byteLength > 0, `${label} returned empty image bytes`);
  const info = validateImageBytes(bytes);
  assert.match(info.mimeType, /^image\//);
}

function generatedImageId(urlText: string): { id: string; pathname: string } {
  const url = new URL(urlText);
  const match = /^\/v1\/images\/([0-9a-f-]+)\/content$/i.exec(url.pathname);
  assert.ok(match, `Unexpected generated image URL: ${urlText}`);
  assert.match(match[1]!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  return { id: match[1]!, pathname: url.pathname };
}

export async function runPhase8ChatGptE2E(
  options: RunPhase8ChatGptE2EOptions,
): Promise<Phase8ChatGptE2EResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cwg-phase8-e2e-'));
  const profile = cloneRealE2EProfile(options.profileDir);
  let runtime: GatewayRuntime | undefined;

  try {
    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });
    let baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });

    const urlPrompt = `A simple square icon of a lighthouse under a crescent moon, no text. Request token ${randomUUID().slice(0, 8)}.`;
    const urlBody = await postImage(
      baseUrl,
      { prompt: urlPrompt, n: 1, response_format: 'url' },
      'Phase 8 URL image generation',
    );
    assert.equal(typeof urlBody.created, 'number');
    assert.equal(urlBody.data?.length, 1);
    assert.equal(typeof urlBody.data?.[0]?.url, 'string');
    const urlResult = generatedImageId(urlBody.data![0]!.url as string);
    const urlBytes = await getImageBytes(baseUrl, urlResult.pathname, 'Phase 8 URL content');
    assertImageBytes(urlBytes, 'Phase 8 URL content');

    const record = runtime.persistence.generatedImages.getById(urlResult.id);
    assert.ok(record, 'Expected generated_images row for URL response');
    assert.equal(record.prompt, urlPrompt);
    assert.equal(record.sizeBytes, urlBytes.byteLength);
    assert.equal(record.sha256, createHash('sha256').update(urlBytes).digest('hex'));
    const diskBytes = readFileSync(record.storagePath);
    assert.deepEqual(diskBytes, urlBytes, 'Stored generated image must equal served content');
    assert.equal(createHash('sha256').update(diskBytes).digest('hex'), record.sha256);

    const rowsBeforeBase64 = (
      runtime.persistence.database
        .prepare('SELECT COUNT(*) AS count FROM generated_images')
        .get() as {
        count: number;
      }
    ).count;
    const b64Prompt = `A minimal flat illustration of a red umbrella on a white background, no text. Request token ${randomUUID().slice(0, 8)}.`;
    const b64Body = await postImage(
      baseUrl,
      { prompt: b64Prompt, response_format: 'b64_json' },
      'Phase 8 Base64 image generation',
    );
    assert.equal(typeof b64Body.created, 'number');
    assert.equal(b64Body.data?.length, 1);
    assert.equal(typeof b64Body.data?.[0]?.b64_json, 'string');
    const b64Bytes = Buffer.from(b64Body.data![0]!.b64_json as string, 'base64');
    assertImageBytes(b64Bytes, 'Phase 8 Base64 response');
    const rowsAfterBase64 = (
      runtime.persistence.database
        .prepare('SELECT COUNT(*) AS count FROM generated_images')
        .get() as {
        count: number;
      }
    ).count;
    assert.equal(
      rowsAfterBase64,
      rowsBeforeBase64 + 1,
      'Base64 generation must persist one image row',
    );

    await runtime.close();
    runtime = undefined;

    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      uiMode: 'novnc',
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });
    baseUrl = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
    const restartedBytes = await getImageBytes(
      baseUrl,
      urlResult.pathname,
      'Phase 8 persisted URL content after restart',
    );
    assert.deepEqual(
      restartedBytes,
      urlBytes,
      'Restarted Gateway must serve identical generated bytes',
    );
    const restartedRecord = runtime.persistence.generatedImages.getById(urlResult.id);
    assert.ok(restartedRecord, 'Expected generated_images row after restart');
    assert.equal(restartedRecord.sha256, record.sha256);

    return { url: true, base64: true, persistence: true, restart: true };
  } finally {
    await runtime?.close().catch(() => undefined);
    profile.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
