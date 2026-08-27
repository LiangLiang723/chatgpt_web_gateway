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

function toolResult(): NormalizedExecutionResult {
  return {
    type: 'tool_calls',
    toolCalls: [{ id: 'call_gateway_test', name: 'get_weather', arguments: '{"city":"Xiamen"}' }],
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

  it('normalizes Chat Completions tools and encodes function tool_calls', async () => {
    const received: NormalizedRequest[] = [];
    const app = createApp(async (request) => {
      received.push(request);
      return toolResult();
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: {
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'Weather?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
        tool_choice: 'required',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_gateway_test',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Xiamen"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(received[0]).toMatchObject({
      tools: [{ type: 'function', name: 'get_weather' }],
      toolChoice: { mode: 'required' },
    });
  });

  it('normalizes Responses function_call_output and encodes function_call items', async () => {
    const received: NormalizedRequest[] = [];
    const app = createApp(async (request) => {
      received.push(request);
      return toolResult();
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { ...auth, 'x-conversation-key': 'response-tools' },
      payload: {
        model: 'chatgpt-web',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_previous',
            output: '{"condition":"sunny"}',
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object' },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      output: [
        {
          type: 'function_call',
          call_id: 'call_gateway_test',
          name: 'get_weather',
          arguments: '{"city":"Xiamen"}',
          status: 'completed',
        },
      ],
    });
    expect(received[0]).toMatchObject({
      conversationKey: 'response-tools',
      messages: [
        {
          role: 'tool',
          toolCallId: 'call_previous',
          content: [{ type: 'text', text: '{"condition":"sunny"}' }],
        },
      ],
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
    ['auth_required', 503, 'server_error'],
    ['browser_unavailable', 503, 'server_error'],
    ['browser_maintenance_mode', 503, 'server_error'],
    ['page_capacity_exceeded', 503, 'server_error'],
    ['selector_missing', 502, 'server_error'],
    ['selector_ambiguous', 502, 'server_error'],
    ['chatgpt_generation_timeout', 504, 'server_error'],
    ['chatgpt_response_missing', 502, 'server_error'],
    ['conversation_restore_failed', 502, 'server_error'],
    ['chatgpt_tool_required', 502, 'server_error'],
    ['chatgpt_tool_protocol_invalid', 502, 'server_error'],
    ['chatgpt_tool_unknown', 502, 'server_error'],
    ['chatgpt_tool_forbidden', 502, 'server_error'],
    ['unsupported_phase7_request', 501, 'server_error'],
    ['unsupported_phase4_request', 501, 'server_error'],
    ['invalid_conversation_request', 400, 'invalid_request_error'],
    ['conversation_sync_not_implemented', 501, 'server_error'],
    ['unsupported_phase3_request', 501, 'server_error'],
  ] as const)(
    'maps execution code %s to HTTP %s / %s without leaking raw errors',
    async (code, status, type) => {
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
          type,
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
