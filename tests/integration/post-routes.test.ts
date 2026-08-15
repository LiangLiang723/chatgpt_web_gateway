import { afterEach, describe, expect, it } from 'vitest';

import type {
  NormalizedExecutionHandler,
  NormalizedExecutionResult,
} from '../../src/api/execution.js';
import type { NormalizedRequest } from '../../src/api/normalized.js';
import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config/index.js';

const apps: Array<ReturnType<typeof buildServer>> = [];

function textResult(text = 'backend answer'): NormalizedExecutionResult {
  return {
    type: 'text',
    text,
    conversationUrl: 'https://chatgpt.com/c/test',
    completedAt: 1_786_720_001_234,
  };
}

function createApp(execute?: NormalizedExecutionHandler) {
  const app = buildServer({
    config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
    execute,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const auth = { authorization: 'Bearer test-key' };

describe('POST routes', () => {
  it('rejects unauthenticated requests before invoking the execution boundary', async () => {
    const received: NormalizedRequest[] = [];
    const app = createApp(async (request) => {
      received.push(request);
      return textResult();
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'chatgpt-web', messages: [{ role: 'user', content: 'Hello' }] },
    });

    expect(response.statusCode).toBe(401);
    expect(received).toEqual([]);
  });

  it('maps Fastify schema failures to a stable OpenAI error envelope', async () => {
    const app = createApp(async () => textResult());

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: { model: 'chatgpt-web' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    });
  });

  it('normalizes Chat Completions and encodes the shared execution result', async () => {
    const received: NormalizedRequest[] = [];
    const app = createApp(async (request) => {
      received.push(request);
      return textResult('chat answer');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...auth, 'x-conversation-key': 'conversation-chat' },
      payload: {
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'chat.completion',
      model: 'chatgpt-web',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'chat answer' },
          finish_reason: 'stop',
        },
      ],
    });
    expect(response.json()).not.toHaveProperty('usage');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      conversationKey: 'conversation-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      output: { mode: 'text', stream: false },
    });
    expect(received[0].requestId).toEqual(expect.any(String));
  });

  it('normalizes Responses and encodes the same shared execution result', async () => {
    const received: NormalizedRequest[] = [];
    const app = createApp(async (request) => {
      received.push(request);
      return textResult('responses answer');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: {
        model: 'chatgpt-web',
        instructions: 'Be concise.',
        input: 'Hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'chatgpt-web',
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'responses answer', annotations: [] }],
        },
      ],
      usage: null,
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      instructions: [{ role: 'developer', content: 'Be concise.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });
  });

  it('returns stable unsupported-parameter errors from the normalizer', async () => {
    const app = createApp(async () => textResult());

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: auth,
      payload: { model: 'chatgpt-web', input: 'Hello', logprobs: false },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: 'Unsupported parameter: logprobs',
        type: 'invalid_request_error',
        param: 'logprobs',
        code: 'unsupported_parameter',
      },
    });
  });

  it.each([
    ['auth_required', 503],
    ['browser_unavailable', 503],
    ['browser_maintenance_mode', 503],
    ['page_capacity_exceeded', 503],
    ['selector_missing', 502],
    ['selector_ambiguous', 502],
    ['chatgpt_generation_timeout', 504],
    ['chatgpt_response_missing', 502],
    ['conversation_restore_failed', 502],
    ['unsupported_phase4_request', 501],
    ['conversation_sync_not_implemented', 501],
    ['unsupported_phase3_request', 501],
  ] as const)(
    'maps execution code %s to HTTP %s without leaking raw errors',
    async (code, status) => {
      const app = createApp(async () => {
        throw Object.assign(new Error('sensitive Playwright/profile detail'), { code });
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: auth,
        payload: { model: 'chatgpt-web', messages: [{ role: 'user', content: 'Hello' }] },
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        error: {
          type: 'server_error',
          code,
          param: null,
        },
      });
      expect(response.body).not.toContain('sensitive Playwright/profile detail');
    },
  );

  it('uses a generic 501 when no execution backend is configured', async () => {
    const app = createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: { model: 'chatgpt-web', messages: [{ role: 'user', content: 'Hello' }] },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      error: {
        message: 'ChatGPT execution backend is not configured',
        type: 'server_error',
        param: null,
        code: 'backend_not_implemented',
      },
    });
  });
});
