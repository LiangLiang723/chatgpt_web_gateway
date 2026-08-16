import { afterEach, describe, expect, it } from 'vitest';

import type {
  NormalizedExecutionHandler,
  NormalizedStreamingExecutionHandler,
} from '../../src/api/execution.js';
import type { NormalizedRequest } from '../../src/api/normalized.js';
import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config/index.js';

const apps: Array<ReturnType<typeof buildServer>> = [];

const result = {
  type: 'text' as const,
  text: 'Hello world',
  conversationUrl: 'https://chatgpt.com/c/stream-test',
  completedAt: 1_786_720_001_234,
};

function appWith(options: {
  execute?: NormalizedExecutionHandler;
  stream?: NormalizedStreamingExecutionHandler;
}) {
  const app = buildServer({
    config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
    ...(options.execute === undefined ? {} : { execute: options.execute }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  });
  apps.push(app);
  return app;
}

async function listen(app: ReturnType<typeof buildServer>): Promise<string> {
  return app.listen({ host: '127.0.0.1', port: 0 });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const headers = {
  authorization: 'Bearer test-key',
  'content-type': 'application/json',
};

describe('Streaming HTTP routes', () => {
  it('routes Chat Completions stream=true through the streaming backend and writes SSE', async () => {
    const received: NormalizedRequest[] = [];
    let executeCalls = 0;
    const app = appWith({
      execute: async () => {
        executeCalls += 1;
        return result;
      },
      stream: async (request, { sink }) => {
        received.push(request);
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        await sink({ type: 'text.delta', delta: 'Hello ' });
        await sink({ type: 'text.delta', delta: 'world' });
        await sink({ type: 'completed', result });
        return result;
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(executeCalls).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.output).toEqual({ mode: 'text', stream: true });
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"content":"Hello "');
    expect(body).toContain('"content":"world"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('data: [DONE]\n\n');
  });

  it('routes Responses stream=true through the Responses SSE encoder', async () => {
    const app = appWith({
      execute: async () => result,
      stream: async (_request, { sink }) => {
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        await sink({ type: 'text.delta', delta: 'Hello world' });
        await sink({ type: 'completed', result });
        return result;
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'chatgpt-web', stream: true, input: 'Hello' }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: response.created');
    expect(body).toContain('event: response.output_text.delta');
    expect(body).toContain('event: response.completed');
    expect(body).not.toContain('data: [DONE]');
  });

  it('keeps stream=false on the existing non-stream execution path', async () => {
    let streamCalls = 0;
    const app = appWith({
      execute: async () => result,
      stream: async () => {
        streamCalls += 1;
        return result;
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: false,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(streamCalls).toBe(0);
  });

  it('returns a normal mapped JSON error when streaming fails before started', async () => {
    const app = appWith({
      execute: async () => result,
      stream: async () => {
        throw Object.assign(new Error('maintenance'), { code: 'browser_maintenance_mode' });
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body).toMatchObject({
      error: { code: 'browser_maintenance_mode', type: 'server_error' },
    });
  });

  it('encodes a post-start Chat Completions error in-stream without a success terminator', async () => {
    const app = appWith({
      execute: async () => result,
      stream: async (_request, { sink }) => {
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        await sink({ type: 'text.delta', delta: 'partial' });
        throw Object.assign(new Error('diverged'), { code: 'chatgpt_stream_diverged' });
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('"code":"chatgpt_stream_diverged"');
    expect(body).not.toContain('"finish_reason":"stop"');
    expect(body).not.toContain('data: [DONE]');
  });
});
