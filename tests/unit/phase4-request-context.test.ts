import { describe, expect, it } from 'vitest';

import type { NormalizedRequest } from '../../src/api/normalized.js';
import { Phase4ExecutionError } from '../../src/conversations/errors.js';
import { toCanonicalConversationRequest } from '../../src/conversations/request-context.js';

function baseRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    requestId: 'req-1',
    instructions: [
      { role: 'developer', content: 'd1' },
      { role: 'system', content: 's1' },
      { role: 'developer', content: 'd2' },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: false },
    diagnostics: { ignoredParameters: [] },
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: Phase4ExecutionError['code']): void {
  expect(fn).toThrowError(expect.objectContaining({ name: 'Phase4ExecutionError', code }));
}

describe('toCanonicalConversationRequest', () => {
  it('canonicalizes a single user message as incremental', () => {
    expect(toCanonicalConversationRequest(baseRequest())).toEqual({
      instructions: { system: ['s1'], developer: ['d1', 'd2'] },
      messages: [{ role: 'user', text: 'hello' }],
      mode: 'incremental',
    });
  });

  it('canonicalizes multi-message user/assistant text history as full', () => {
    expect(
      toCanonicalConversationRequest(
        baseRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
            { role: 'user', content: [{ type: 'text', text: 'next' }] },
          ],
        }),
      ),
    ).toEqual({
      instructions: { system: ['s1'], developer: ['d1', 'd2'] },
      messages: [
        { role: 'user', text: 'a\nb' },
        { role: 'assistant', text: 'answer' },
        { role: 'user', text: 'next' },
      ],
      mode: 'full',
    });
  });

  it.each([
    ['stream', baseRequest({ output: { mode: 'text', stream: true } })],
    ['image output', baseRequest({ output: { mode: 'image', stream: false } })],
    [
      'request attachments',
      baseRequest({
        attachments: [{ id: 'a1', kind: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
      }),
    ],
    [
      'tools',
      baseRequest({
        tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }],
      }),
    ],
    ['tool choice', baseRequest({ toolChoice: { mode: 'required' } })],
    [
      'structured output',
      baseRequest({ output: { mode: 'text', stream: false, structured: { type: 'json_object' } } }),
    ],
    [
      'tool message',
      baseRequest({
        messages: [
          { role: 'tool', content: [{ type: 'text', text: 'result' }], toolCallId: 'call-1' },
          { role: 'user', content: [{ type: 'text', text: 'next' }] },
        ],
      }),
    ],
    [
      'assistant tool calls',
      baseRequest({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'calling' }],
            toolCalls: [{ id: 'call-1', name: 'f', arguments: '{}' }],
          },
          { role: 'user', content: [{ type: 'text', text: 'next' }] },
        ],
      }),
    ],
    [
      'attachment content part',
      baseRequest({
        messages: [
          { role: 'user', content: [{ type: 'attachment', attachmentId: 'a1' }] },
        ],
      }),
    ],
  ] as const)('rejects unsupported Phase 4 capability: %s', (_name, request) => {
    expectCode(() => toCanonicalConversationRequest(request), 'unsupported_phase4_request');
  });

  it('rejects missing or assistant-final user turn as invalid Conversation input', () => {
    expectCode(
      () => toCanonicalConversationRequest(baseRequest({ messages: [] })),
      'invalid_conversation_request',
    );
    expectCode(
      () =>
        toCanonicalConversationRequest(
          baseRequest({
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'hello' }] },
              { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
            ],
          }),
        ),
      'invalid_conversation_request',
    );
    expectCode(
      () =>
        toCanonicalConversationRequest(
          baseRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: '   ' }] }] }),
        ),
      'invalid_conversation_request',
    );
  });
});
