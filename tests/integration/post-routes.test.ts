import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/api/server.js';
import type { NormalizedRequest } from '../../src/api/normalized.js';
import { loadConfig } from '../../src/config/index.js';

const apps: Array<ReturnType<typeof buildServer>> = [];

function createApp(execute?: (request: NormalizedRequest) => Promise<unknown>) {
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

describe('Phase 1 POST routes', () => {
  it('rejects unauthenticated requests before invoking the execution boundary', async () => {
    const received: NormalizedRequest[] = [];
    const app = createApp(async (request) => {
      received.push(request);
      return { ok: true };
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
    const app = createApp(async () => ({ ok: true }));

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

  it('passes a validated Chat Completions request to the injected normalized boundary', async () => {
    const received: NormalizedRequest[] = [];
    const app = createApp(async (request) => {
      received.push(request);
      return { endpoint: 'chat', normalized: true };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...auth, 'x-conversation-key': 'conversation-chat' },
      payload: {
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ endpoint: 'chat', normalized: true });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      conversationKey: 'conversation-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      output: { mode: 'text', stream: true },
    });
    expect(received[0].requestId).toEqual(expect.any(String));
  });

  it('passes a validated Responses request to the same normalized boundary', async () => {
    const received: NormalizedRequest[] = [];
    const app = createApp(async (request) => {
      received.push(request);
      return { endpoint: 'responses', normalized: true };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { ...auth, 'x-conversation-key': 'conversation-responses' },
      payload: {
        model: 'chatgpt-web',
        instructions: 'Be concise.',
        input: 'Hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ endpoint: 'responses', normalized: true });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      conversationKey: 'conversation-responses',
      instructions: [{ role: 'developer', content: 'Be concise.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });
  });

  it('returns stable unsupported-parameter errors from the normalizer', async () => {
    const app = createApp(async () => ({ ok: true }));

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

  it('does not fabricate ChatGPT output when no execution backend is injected', async () => {
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
        message: 'ChatGPT execution is not implemented in Phase 1',
        type: 'server_error',
        param: null,
        code: 'backend_not_implemented',
      },
    });
  });
});
