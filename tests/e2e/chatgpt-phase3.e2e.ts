import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBrowserManager } from '../../src/browser/browser-manager.js';
import { createChatGptDriver } from '../../src/chatgpt/driver.js';
import { inspectChatGptPage } from '../../src/chatgpt/inspect.js';
import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime } from '../../src/runtime.js';

export interface RunPhase3ChatGptE2EOptions {
  profileDir: string;
  diagnosticsDir?: string;
}

export interface Phase3ChatGptE2EResult {
  auth: 'authenticated';
  composer: 'unique';
  driverChallenge: true;
  gatewayChallenge: true;
}

function challengeToken(): string {
  return `CWG_PHASE3_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function challengePrompt(token: string): string {
  return `Return exactly this token and nothing else: ${token}`;
}

function assertConversationUrl(value: string): void {
  const url = new URL(value);
  assert.equal(url.hostname, 'chatgpt.com');
  assert.notEqual(url.pathname, '/');
}

export async function runPhase3ChatGptE2E(
  options: RunPhase3ChatGptE2EOptions,
): Promise<Phase3ChatGptE2EResult> {
  const browser = await createBrowserManager({
    profileDir: options.profileDir,
    maxActivePages: 1,
  });

  try {
    const lease = await browser.pages.acquire();
    try {
      const inspection = await inspectChatGptPage(lease.page, {
        ...(options.diagnosticsDir ? { diagnosticsDir: options.diagnosticsDir } : {}),
      });
      assert.equal(
        inspection.auth,
        'authenticated',
        `Expected authenticated, got ${inspection.auth}`,
      );
      assert.equal(
        inspection.selectors.composer,
        'unique',
        `Expected unique composer, got ${inspection.selectors.composer}`,
      );

      const token = challengeToken();
      const driver = createChatGptDriver();
      const result = await driver.sendText(lease.page, { prompt: challengePrompt(token) });
      assert.match(result.text, new RegExp(token));
      assertConversationUrl(result.conversationUrl);
    } finally {
      await lease.release();
    }
  } finally {
    await browser.close();
  }

  const runtimeDataDir = mkdtempSync(join(tmpdir(), 'cwg-phase3-e2e-'));
  try {
    const runtime = await createGatewayRuntime({
      config: loadConfig({
        GATEWAY_API_KEY: 'phase3-e2e-gateway-key',
        DATA_DIR: runtimeDataDir,
        MAX_ACTIVE_PAGES: '1',
      }),
      browserProfileDir: options.profileDir,
      logger: false,
    });

    try {
      const token = challengeToken();
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer phase3-e2e-gateway-key' },
        payload: {
          model: 'chatgpt-web',
          messages: [{ role: 'user', content: challengePrompt(token) }],
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.equal(body.model, 'chatgpt-web');
      assert.equal(body.choices?.[0]?.message?.role, 'assistant');
      assert.match(String(body.choices?.[0]?.message?.content ?? ''), new RegExp(token));
      assert.equal(body.choices?.[0]?.finish_reason, 'stop');
    } finally {
      await runtime.close();
    }
  } finally {
    rmSync(runtimeDataDir, { recursive: true, force: true });
  }

  return {
    auth: 'authenticated',
    composer: 'unique',
    driverChallenge: true,
    gatewayChallenge: true,
  };
}
