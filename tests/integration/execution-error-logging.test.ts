import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/api/server.js';
import { ChatGptDriverError } from '../../src/chatgpt/errors.js';
import { loadConfig } from '../../src/config/index.js';

const apps: Array<ReturnType<typeof buildServer>> = [];

function captureLogger() {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return {
    logger: { level: 'error', stream },
    output: () => output,
  };
}

function browserFailure() {
  return new ChatGptDriverError({
    code: 'browser_unavailable',
    message: 'ChatGPT page operation failed',
    cause: new Error('raw Playwright locator failure'),
    diagnostics: {
      operation: 'startText',
      page: {
        url: 'https://chatgpt.com/c/log-test',
        title: 'ChatGPT - log test',
        documentReadyState: 'interactive',
        closed: false,
      },
      prompt: { characters: 24000, utf8Bytes: 26000, lines: 2 },
    },
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('mapped execution error logging', () => {
  it('logs the original mapped Browser failure for normal HTTP requests without leaking it to the response', async () => {
    const captured = captureLogger();
    const app = buildServer({
      config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
      execute: async () => {
        throw browserFailure();
      },
      logger: captured.logger,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-key' },
      payload: { model: 'chatgpt-web', messages: [{ role: 'user', content: 'Hello' }] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('raw Playwright locator failure');
    expect(captured.output()).toContain('browser_unavailable');
    expect(captured.output()).toContain('raw Playwright locator failure');
    expect(captured.output()).toContain('https://chatgpt.com/c/log-test');
  });

  it('logs a Browser failure that occurs after SSE already returned HTTP 200', async () => {
    const captured = captureLogger();
    const app = buildServer({
      config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
      stream: async (_request, { sink }) => {
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        throw browserFailure();
      },
      logger: captured.logger,
    });
    apps.push(app);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('browser_unavailable');
    expect(body).not.toContain('raw Playwright locator failure');
    expect(captured.output()).toContain('browser_unavailable');
    expect(captured.output()).toContain('raw Playwright locator failure');
    expect(captured.output()).toContain('https://chatgpt.com/c/log-test');
  });
});
