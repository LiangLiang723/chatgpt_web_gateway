import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../../src/config/index.js';
import { createGatewayRuntime, type GatewayRuntime } from '../../src/runtime.js';
import { cloneRealE2EProfile } from './profile.js';

export interface RunPhase4ChatGptE2EOptions {
  profileDir: string;
  proxyServer?: string;
}

export interface Phase4ChatGptE2EResult {
  warmAppend: true;
  restartRestore: true;
  contextTokenRetained: true;
  conversationIdentityStable: true;
}

function token(): string {
  return `CWG_PHASE4_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function conversationIdentity(value: string): string {
  const url = new URL(value);
  assert.equal(url.origin, 'https://chatgpt.com');
  assert.match(url.pathname, /^\/c\/[^/]+$/);
  return `${url.origin}${url.pathname}`;
}

function assistantText(body: unknown): string {
  const content = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
    ?.message?.content;
  assert.equal(typeof content, 'string');
  return content as string;
}

async function createRuntime(options: {
  dataDir: string;
  profileDir: string;
  proxyServer?: string;
}): Promise<GatewayRuntime> {
  return createGatewayRuntime({
    config: loadConfig({
      GATEWAY_API_KEY: 'phase4-e2e-gateway-key',
      DATA_DIR: options.dataDir,
      MAX_ACTIVE_PAGES: '1',
      PAGE_IDLE_TIMEOUT_MINUTES: '30',
      ...(options.proxyServer ? { CHATGPT_PROXY_SERVER: options.proxyServer } : {}),
    }),
    browserProfileDir: options.profileDir,
    logger: false,
  });
}

export async function runPhase4ChatGptE2E(
  options: RunPhase4ChatGptE2EOptions,
): Promise<Phase4ChatGptE2EResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cwg-phase4-e2e-'));
  const conversationKey = `phase4-${randomUUID()}`;
  const memoryToken = token();
  const profile = cloneRealE2EProfile(options.profileDir);
  const headers = {
    authorization: 'Bearer phase4-e2e-gateway-key',
    'x-conversation-key': conversationKey,
  };
  let runtime: GatewayRuntime | undefined;

  try {
    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });

    const turnOneUser = `Memorize this token for later: ${memoryToken}. Reply exactly with: STORED ${memoryToken}`;
    const first = await runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: {
        model: 'chatgpt-web',
        stream: false,
        messages: [{ role: 'user', content: turnOneUser }],
      },
    });
    assert.equal(first.statusCode, 200, first.body);
    const turnOneAssistant = assistantText(first.json());
    assert.match(turnOneAssistant, new RegExp(memoryToken));

    const afterFirst = runtime.persistence.conversationStore.loadByKey(conversationKey);
    assert.ok(afterFirst, 'Expected the first Phase 4 turn to persist a Conversation');
    assert.ok(
      afterFirst.conversation.chatgptConversationUrl,
      'Expected the first Phase 4 turn to persist a ChatGPT Conversation URL',
    );
    const firstIdentity = conversationIdentity(afterFirst.conversation.chatgptConversationUrl);

    const turnTwoUser = 'What token did I ask you to memorize? Reply with the token only.';
    const second = await runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          { role: 'user', content: turnOneUser },
          { role: 'assistant', content: turnOneAssistant },
          { role: 'user', content: turnTwoUser },
        ],
      },
    });
    assert.equal(second.statusCode, 200, second.body);
    const turnTwoAssistant = assistantText(second.json());
    assert.match(turnTwoAssistant, new RegExp(memoryToken));

    const afterSecond = runtime.persistence.conversationStore.loadByKey(conversationKey);
    assert.ok(afterSecond?.conversation.chatgptConversationUrl);
    assert.equal(
      conversationIdentity(afterSecond.conversation.chatgptConversationUrl),
      firstIdentity,
      'Warm APPEND must stay on the same ChatGPT Conversation identity',
    );

    await runtime.close();
    runtime = undefined;

    runtime = await createRuntime({
      dataDir,
      profileDir: profile.profileDir,
      ...(options.proxyServer ? { proxyServer: options.proxyServer } : {}),
    });

    const turnThreeUser = 'Repeat the memorized token one more time. Reply with the token only.';
    const third = await runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          { role: 'user', content: turnOneUser },
          { role: 'assistant', content: turnOneAssistant },
          { role: 'user', content: turnTwoUser },
          { role: 'assistant', content: turnTwoAssistant },
          { role: 'user', content: turnThreeUser },
        ],
      },
    });
    assert.equal(third.statusCode, 200, third.body);
    assert.match(assistantText(third.json()), new RegExp(memoryToken));

    const afterThird = runtime.persistence.conversationStore.loadByKey(conversationKey);
    assert.ok(afterThird?.conversation.chatgptConversationUrl);
    assert.equal(
      conversationIdentity(afterThird.conversation.chatgptConversationUrl),
      firstIdentity,
      'Restart RESTORE must return to the same ChatGPT Conversation identity',
    );

    return {
      warmAppend: true,
      restartRestore: true,
      contextTokenRetained: true,
      conversationIdentityStable: true,
    };
  } finally {
    await runtime?.close();
    profile.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
