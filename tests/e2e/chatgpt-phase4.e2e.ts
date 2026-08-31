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

export interface RunPhase4ChatGptE2EOptions {
  profileDir: string;
  proxyServer?: string;
}

export interface Phase4ChatGptE2EResult {
  append: true;
  restore: true;
  rebuild: true;
  anonymousContinuation: true;
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
  const appendMarker = token();
  const rebuiltToken = token();
  const anonymousMemoryToken = token();
  const anonymousAppendMarker = token();
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
    const firstUrl = afterFirst.conversation.chatgptConversationUrl;
    const firstIdentity = conversationIdentity(firstUrl);
    const conversationId = afterFirst.conversation.id;

    const turnTwoUser = `What token did I ask you to memorize? This request marker is ${appendMarker}. Reply exactly as: <memorized-token>|${appendMarker}`;
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
    assert.match(turnTwoAssistant, new RegExp(appendMarker));

    const livePage = runtime.browser?.context.pages().at(-1);
    assert.ok(livePage, 'Expected one live ChatGPT Conversation Page after APPEND');
    const userTurns = await inspectCollection(livePage, chatGptSelectors.userTurns);
    assert.ok(userTurns.count >= 2, 'Expected at least two ChatGPT Web user turns after APPEND');
    const secondWebUserTurn = await userTurns.locator.nth(userTurns.count - 1).innerText();
    assert.match(secondWebUserTurn, new RegExp(appendMarker));
    assert.doesNotMatch(
      secondWebUserTurn,
      new RegExp(memoryToken),
      'APPEND must not resend the first user token into the second ChatGPT Web user turn',
    );

    const afterSecond = runtime.persistence.conversationStore.loadByKey(conversationKey);
    assert.ok(afterSecond?.conversation.chatgptConversationUrl);
    assert.equal(
      afterSecond.conversation.chatgptConversationUrl,
      firstUrl,
      'Warm APPEND must keep the exact persisted ChatGPT Conversation URL',
    );
    assert.equal(
      conversationIdentity(afterSecond.conversation.chatgptConversationUrl),
      firstIdentity,
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
        messages: [{ role: 'user', content: turnThreeUser }],
      },
    });
    assert.equal(third.statusCode, 200, third.body);
    assert.match(assistantText(third.json()), new RegExp(memoryToken));

    const afterThird = runtime.persistence.conversationStore.loadByKey(conversationKey);
    assert.ok(afterThird?.conversation.chatgptConversationUrl);
    assert.equal(
      afterThird.conversation.chatgptConversationUrl,
      firstUrl,
      'Restart RESTORE must keep the exact persisted ChatGPT Conversation URL',
    );
    assert.equal(
      conversationIdentity(afterThird.conversation.chatgptConversationUrl),
      firstIdentity,
    );

    const modifiedTurnOneUser = `The token to remember is ${rebuiltToken}. Reply exactly with: STORED ${rebuiltToken}`;
    const modifiedTurnOneAssistant = `STORED ${rebuiltToken}`;
    const rebuildUser =
      'According to the corrected history, what token should you remember? Reply with the token only.';
    const rebuilt = await runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          { role: 'user', content: modifiedTurnOneUser },
          { role: 'assistant', content: modifiedTurnOneAssistant },
          { role: 'user', content: rebuildUser },
        ],
      },
    });
    assert.equal(rebuilt.statusCode, 200, rebuilt.body);
    assert.match(assistantText(rebuilt.json()), new RegExp(rebuiltToken));

    const afterRebuild = runtime.persistence.conversationStore.loadByKey(conversationKey);
    assert.ok(afterRebuild?.conversation.chatgptConversationUrl);
    assert.equal(afterRebuild.conversation.id, conversationId, 'REBUILD must preserve local UUID');
    assert.equal(afterRebuild.conversation.conversationKey, conversationKey);
    assert.notEqual(
      afterRebuild.conversation.chatgptConversationUrl,
      firstUrl,
      'REBUILD must persist a new ChatGPT Conversation URL',
    );

    const anonymousHeaders = {
      authorization: 'Bearer phase4-e2e-gateway-key',
    };
    const anonymousTurnOneUser = `Memorize this anonymous continuity token: ${anonymousMemoryToken}. Reply exactly with: STORED ${anonymousMemoryToken}`;
    const anonymousFirst = await runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: anonymousHeaders,
      payload: {
        model: 'chatgpt-web',
        stream: false,
        messages: [{ role: 'user', content: anonymousTurnOneUser }],
      },
    });
    assert.equal(anonymousFirst.statusCode, 200, anonymousFirst.body);
    const anonymousTurnOneAssistant = assistantText(anonymousFirst.json());
    assert.match(anonymousTurnOneAssistant, new RegExp(anonymousMemoryToken));

    const anonymousAfterFirst =
      runtime.persistence.conversationStore.loadAnonymousBySyncedMessageCount(2);
    assert.equal(
      anonymousAfterFirst.length,
      1,
      'Expected exactly one anonymous Conversation candidate',
    );
    const anonymousFirstUrl = anonymousAfterFirst[0]!.conversation.chatgptConversationUrl;
    assert.ok(
      anonymousFirstUrl,
      'Expected anonymous first turn to persist a ChatGPT Conversation URL',
    );

    const anonymousTurnTwoUser = `What anonymous continuity token did I ask you to memorize? This marker is ${anonymousAppendMarker}. Reply exactly as: <token>|${anonymousAppendMarker}`;
    const anonymousSecond = await runtime.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: anonymousHeaders,
      payload: {
        model: 'chatgpt-web',
        stream: false,
        messages: [
          { role: 'user', content: anonymousTurnOneUser },
          { role: 'assistant', content: anonymousTurnOneAssistant },
          { role: 'user', content: anonymousTurnTwoUser },
        ],
      },
    });
    assert.equal(anonymousSecond.statusCode, 200, anonymousSecond.body);
    const anonymousTurnTwoAssistant = assistantText(anonymousSecond.json());
    assert.match(anonymousTurnTwoAssistant, new RegExp(anonymousMemoryToken));
    assert.match(anonymousTurnTwoAssistant, new RegExp(anonymousAppendMarker));

    const anonymousAfterSecond =
      runtime.persistence.conversationStore.loadAnonymousBySyncedMessageCount(4);
    assert.equal(anonymousAfterSecond.length, 1, 'Expected one continued anonymous Conversation');
    assert.equal(
      anonymousAfterSecond[0]!.conversation.chatgptConversationUrl,
      anonymousFirstUrl,
      'Anonymous full-history continuation must keep the same ChatGPT Conversation URL',
    );

    const anonymousLivePage = runtime.browser?.context.pages().at(-1);
    assert.ok(anonymousLivePage, 'Expected one live anonymous ChatGPT Conversation Page');
    const anonymousUserTurns = await inspectCollection(
      anonymousLivePage,
      chatGptSelectors.userTurns,
    );
    assert.ok(anonymousUserTurns.count >= 2, 'Expected two anonymous ChatGPT Web user turns');
    const anonymousSecondWebUserTurn = await anonymousUserTurns.locator
      .nth(anonymousUserTurns.count - 1)
      .innerText();
    assert.match(anonymousSecondWebUserTurn, new RegExp(anonymousAppendMarker));
    assert.doesNotMatch(
      anonymousSecondWebUserTurn,
      new RegExp(anonymousMemoryToken),
      'Anonymous APPEND must not replay the first user token into the second Web turn',
    );

    return {
      append: true,
      restore: true,
      rebuild: true,
      anonymousContinuation: true,
    };
  } finally {
    await runtime?.close();
    profile.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
