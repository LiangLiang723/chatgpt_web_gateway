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

const toolResult = {
  type: 'tool_calls' as const,
  toolCalls: [{ id: 'call_stream_test', name: 'get_weather', arguments: '{"city":"Xiamen"}' }],
  conversationUrl: 'https://chatgpt.com/c/stream-tools',
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

  it.each([true, false])(
    'accepts Cherry Studio stream_options.include_usage=%s without emitting fake usage',
    async (includeUsage) => {
      const received: NormalizedRequest[] = [];
      const app = appWith({
        execute: async () => result,
        stream: async (request, { sink }) => {
          received.push(request);
          await sink({ type: 'started', startedAt: 1_786_720_001_000 });
          await sink({ type: 'text.delta', delta: 'Hello world' });
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
          messages: [{ role: 'user', content: '你是谁' }],
          stream: true,
          stream_options: { include_usage: includeUsage },
        }),
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.output).toEqual({ mode: 'text', stream: true });
      expect(body).toContain('"finish_reason":"stop"');
      expect(body).toContain('data: [DONE]\n\n');
      expect(body).not.toContain('"usage"');
    },
  );

  it('accepts Pi single-text-object user content over HTTP', async () => {
    const received: NormalizedRequest[] = [];
    const app = appWith({
      execute: async () => result,
      stream: async (request, { sink }) => {
        received.push(request);
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        await sink({ type: 'text.delta', delta: '你好' });
        await sink({ type: 'completed', result: { ...result, text: '你好' } });
        return { ...result, text: '你好' };
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: { type: 'text', text: '你好' } },
        ],
        stream: true,
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
    ]);
    expect(body).toContain('data: [DONE]\n\n');
  });

  it('accepts Cherry Studio history reasoning metadata and agent compatibility parameters over HTTP', async () => {
    const received: NormalizedRequest[] = [];
    const app = appWith({
      execute: async () => result,
      stream: async (request, { sink }) => {
        received.push(request);
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        await sink({ type: 'text.delta', delta: 'Hello world' });
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
        messages: [
          { role: 'user', content: '你是谁' },
          {
            role: 'assistant',
            content: '我是 ChatGPT。',
            reasoning_content: '',
            reasoning: 'cross-model reasoning replay',
            reasoning_text: 'cross-model reasoning text replay',
          },
          { role: 'user', content: '继续' },
        ],
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        reasoning_effort: 'high',
        parallel_tool_calls: true,
        service_tier: 'auto',
        metadata: { client: 'openclaw-hermes-pi' },
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '你是谁' }] },
      { role: 'assistant', content: [{ type: 'text', text: '我是 ChatGPT。' }] },
      { role: 'user', content: [{ type: 'text', text: '继续' }] },
    ]);
    expect(received[0]?.diagnostics.ignoredParameters).toEqual([
      'store',
      'reasoning_effort',
      'parallel_tool_calls',
      'service_tier',
      'metadata',
    ]);
    expect(body).toContain('data: [DONE]\n\n');
  });

  it('rejects non-boolean Cherry Studio stream_options.include_usage', async () => {
    const app = appWith({ execute: async () => result, stream: async () => result });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
        stream_options: { include_usage: 'true' },
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects unknown fields inside Cherry Studio stream_options', async () => {
    const app = appWith({ execute: async () => result, stream: async () => result });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
        stream_options: { include_usage: true, future_flag: true },
      }),
    });

    expect(response.status).toBe(400);
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

  it('accepts the current Codex Responses agent shape over HTTP', async () => {
    const received: NormalizedRequest[] = [];
    const app = appWith({
      execute: async () => result,
      stream: async (request, { sink }) => {
        received.push(request);
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        await sink({ type: 'text.delta', delta: 'OK' });
        await sink({ type: 'completed', result: { ...result, text: 'OK' } });
        return { ...result, text: 'OK' };
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        instructions: 'Use tools when useful.',
        input: [
          {
            type: 'message',
            id: 'msg_user',
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply only OK' }],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            description: 'Run a command',
            strict: false,
            parameters: { type: 'object', properties: {} },
          },
          {
            type: 'custom',
            name: 'apply_patch',
            description: 'Apply a patch',
            format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' },
          },
          {
            type: 'namespace',
            name: 'multi_agent_v1',
            description: 'Agent tools',
            tools: [
              {
                type: 'function',
                name: 'spawn_agent',
                description: 'Spawn an agent',
                strict: false,
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
          { type: 'web_search', external_web_access: false },
        ],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { effort: 'low', summary: 'auto' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'codex-session',
        client_metadata: { session_id: 'codex-session' },
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.tools.map((tool) => tool.name)).toEqual([
      'exec_command',
      '__responses_custom__::apply_patch',
      'multi_agent_v1::spawn_agent',
    ]);
    expect(received[0]?.diagnostics.ignoredParameters).toEqual([
      'parallel_tool_calls',
      'reasoning',
      'store',
      'include',
      'prompt_cache_key',
      'client_metadata',
      'tools.web_search',
    ]);
    expect(body).toContain('event: response.completed');
  });

  it('encodes Chat Completions tool calls in-stream with tool_calls terminal and no private protocol leak', async () => {
    const app = appWith({
      execute: async () => toolResult,
      stream: async (_request, { sink }) => {
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        await sink({ type: 'tool_calls', toolCalls: toolResult.toolCalls });
        await sink({ type: 'completed', result: toolResult });
        return toolResult;
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: true,
        messages: [{ role: 'user', content: 'Weather?' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object' } },
          },
        ],
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"id":"call_stream_test"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('data: [DONE]\n\n');
    expect(body).not.toContain('CHATGPT_WEB_GATEWAY_TOOL_CALLS');
  });

  it('encodes Responses function-call stream events and one completed response', async () => {
    const app = appWith({
      execute: async () => toolResult,
      stream: async (_request, { sink }) => {
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        await sink({ type: 'tool_calls', toolCalls: toolResult.toolCalls });
        await sink({ type: 'completed', result: toolResult });
        return toolResult;
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: true,
        input: 'Weather?',
        tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: response.function_call_arguments.delta');
    expect(body).toContain('event: response.function_call_arguments.done');
    expect(body).toContain('event: response.output_item.done');
    expect(body.match(/event: response.completed/g) ?? []).toHaveLength(1);
    expect(body).not.toContain('CHATGPT_WEB_GATEWAY_TOOL_CALLS');
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

  it('encodes a post-start tool parser error in-stream without a success terminator', async () => {
    const app = appWith({
      execute: async () => result,
      stream: async (_request, { sink }) => {
        await sink({ type: 'started', startedAt: 1_786_720_001_000 });
        throw Object.assign(new Error('bad private protocol'), {
          code: 'chatgpt_tool_protocol_invalid',
        });
      },
    });
    const base = await listen(app);

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'chatgpt-web',
        stream: true,
        messages: [{ role: 'user', content: 'Use tool' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: { type: 'object' } },
          },
        ],
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"code":"chatgpt_tool_protocol_invalid"');
    expect(body).not.toContain('"finish_reason":"tool_calls"');
    expect(body).not.toContain('data: [DONE]');
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
