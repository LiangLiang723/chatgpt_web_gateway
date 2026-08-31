import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config/index.js';

const apps: Array<ReturnType<typeof buildServer>> = [];

function createApp(env: NodeJS.ProcessEnv = {}) {
  const app = buildServer({
    config: loadConfig({ GATEWAY_API_KEY: 'test-key', ...env }),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('health and models routes', () => {
  it('exposes process health without authentication', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('rejects /v1/models without a Gateway API key', async () => {
    const response = await createApp().inject({ method: 'GET', url: '/v1/models' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        message: 'Missing Authorization: Bearer token',
        type: 'authentication_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
  });

  it('rejects a wrong Gateway API key without leaking configured secrets', async () => {
    const response = await createApp().inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer wrong-key' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('test-key');
    expect(response.body).not.toContain('wrong-key');
  });

  it('returns only the chatgpt-web model for an authenticated request', async () => {
    const response = await createApp().inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer test-key' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: 'list',
      data: [
        {
          id: 'chatgpt-web',
          object: 'model',
          created: 0,
          owned_by: 'chatgpt-web-gateway',
          name: 'ChatGPT Web',
          capabilities: [
            'reasoning',
            'image-recognition',
            'file-input',
            'function-call',
            'structured-output',
          ],
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          supports_streaming: true,
          context_window: 128000,
          max_input_tokens: 128000,
          max_output_tokens: 32768,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          supportsStreaming: true,
          contextWindow: 128000,
          maxInputTokens: 128000,
          maxOutputTokens: 32768,
        },
      ],
    });
  });

  it('reads compatibility token-limit hints from configuration', async () => {
    const response = await createApp({
      MODEL_CONTEXT_WINDOW: '64000',
      MODEL_MAX_INPUT_TOKENS: '60000',
      MODEL_MAX_OUTPUT_TOKENS: '16000',
    }).inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer test-key' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0]).toMatchObject({
      id: 'chatgpt-web',
      context_window: 64000,
      max_input_tokens: 60000,
      max_output_tokens: 16000,
      contextWindow: 64000,
      maxInputTokens: 60000,
      maxOutputTokens: 16000,
    });
  });
});
