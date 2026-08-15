import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import type { NormalizedRequest } from '../../src/api/normalized.js';
import {
  buildPhase3Prompt,
  createPhase3Executor,
} from '../../src/conversations/phase3-executor.js';

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    requestId: 'req-1',
    instructions: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: false },
    diagnostics: { ignoredParameters: [] },
    ...overrides,
  };
}

function harness() {
  const release = vi.fn(async () => undefined);
  const page = {} as Page;
  const acquire = vi.fn(async () => ({ page, release }));
  const sendText = vi.fn(async () => ({
    text: 'answer',
    conversationUrl: 'https://chatgpt.com/c/test',
  }));
  const execute = createPhase3Executor({
    pagePool: { acquire } as never,
    driver: {
      openFresh: vi.fn(async () => undefined),
      openConversation: vi.fn(async () => 'restored' as const),
      sendText,
    },
    now: () => 1_786_720_000_123,
  });
  return { execute, acquire, release, sendText };
}

describe('Phase3Executor', () => {
  it('builds a JSON-escaped role envelope and executes a Fresh text request', async () => {
    const input = request({
      instructions: [
        { role: 'system', content: 'say "safe"' },
        { role: 'developer', content: 'line 1\nline 2' },
        { role: 'system', content: 'system two' },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' },
          ],
        },
      ],
    });
    const prompt = buildPhase3Prompt(input);
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{')));

    expect(payload).toEqual({
      system: ['say "safe"', 'system two'],
      developer: ['line 1\nline 2'],
      user: 'hello\nworld',
    });

    const { execute, release, sendText } = harness();
    await expect(execute(input)).resolves.toEqual({
      type: 'text',
      text: 'answer',
      conversationUrl: 'https://chatgpt.com/c/test',
      completedAt: 1_786_720_000_123,
    });
    expect(sendText).toHaveBeenCalledWith(expect.anything(), { prompt });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['conversation key', { conversationKey: 'thread-1' }],
    [
      'assistant history',
      {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
          { role: 'user', content: [{ type: 'text', text: 'next' }] },
        ],
      },
    ],
    [
      'tool history',
      {
        messages: [
          { role: 'tool', content: [{ type: 'text', text: 'result' }], toolCallId: 'call-1' },
          { role: 'user', content: [{ type: 'text', text: 'next' }] },
        ],
      },
    ],
    [
      'multiple user turns',
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'one' }] },
          { role: 'user', content: [{ type: 'text', text: 'two' }] },
        ],
      },
    ],
  ])('rejects %s as conversation_sync_not_implemented', async (_name, overrides) => {
    const { execute, acquire } = harness();
    await expect(execute(request(overrides as Partial<NormalizedRequest>))).rejects.toMatchObject({
      code: 'conversation_sync_not_implemented',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([
    ['streaming', { output: { mode: 'text', stream: true } }],
    [
      'attachments',
      { attachments: [{ id: 'a', kind: 'image', source: { type: 'url', url: 'x' } }] },
    ],
    ['tools', { tools: [{ type: 'function', name: 'f', parameters: {} }] }],
    ['tool choice', { toolChoice: { mode: 'required' } }],
    [
      'structured output',
      { output: { mode: 'text', stream: false, structured: { type: 'json_object' } } },
    ],
    ['image output', { output: { mode: 'image', stream: false } }],
    [
      'attachment content part',
      { messages: [{ role: 'user', content: [{ type: 'attachment', attachmentId: 'a' }] }] },
    ],
  ])('rejects %s as unsupported_phase3_request', async (_name, overrides) => {
    const { execute, acquire } = harness();
    await expect(execute(request(overrides as Partial<NormalizedRequest>))).rejects.toMatchObject({
      code: 'unsupported_phase3_request',
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('releases the Page lease when the Driver fails', async () => {
    const release = vi.fn(async () => undefined);
    const execute = createPhase3Executor({
      pagePool: { acquire: async () => ({ page: {} as Page, release }) } as never,
      driver: {
        openFresh: async () => undefined,
        openConversation: async () => 'restored',
        sendText: async () => {
          throw new Error('driver failed');
        },
      },
      now: () => 1,
    });

    await expect(execute(request())).rejects.toThrow('driver failed');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
