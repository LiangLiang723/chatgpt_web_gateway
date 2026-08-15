import { describe, expect, it } from 'vitest';

import type { NormalizedMessage, NormalizedRequest } from '../../src/api/normalized.js';
import {
  buildAppendPrompt,
  buildFullContextPrompt,
  validatePhase4Request,
} from '../../src/conversations/phase4-request.js';

const user = (text: string): NormalizedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

const assistant = (text: string): NormalizedMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    requestId: 'req-phase4',
    conversationKey: 'conversation-a',
    instructions: [
      { role: 'system', content: 'system "quoted" rule' },
      { role: 'developer', content: 'developer rule' },
    ],
    messages: [user('hello')],
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: false },
    diagnostics: { ignoredParameters: [] },
    ...overrides,
  };
}

function expectUnsupported(candidate: NormalizedRequest): void {
  try {
    validatePhase4Request(candidate);
    throw new Error('expected validatePhase4Request to reject');
  } catch (error) {
    expect(error).toMatchObject({ code: 'unsupported_phase4_request' });
  }
}

describe('Phase 4 request validation and prompts', () => {
  it('accepts assistant text history followed by one non-empty user text turn', () => {
    expect(() =>
      validatePhase4Request(
        request({ messages: [user('one'), assistant('reply one'), user('two')] }),
      ),
    ).not.toThrow();
  });

  it('rejects later-phase execution capabilities with a stable Phase 4 code', () => {
    const cases: NormalizedRequest[] = [
      request({ output: { mode: 'text', stream: true } }),
      request({ output: { mode: 'image', stream: false } }),
      request({ output: { mode: 'text', stream: false, structured: { type: 'json_object' } } }),
      request({
        attachments: [
          { id: 'att-1', kind: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        ],
      }),
      request({
        messages: [{ role: 'user', content: [{ type: 'attachment', attachmentId: 'att-1' }] }],
      }),
      request({
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      }),
      request({ toolChoice: { mode: 'required' } }),
      request({
        messages: [{ role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }],
      }),
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'calling tool' }],
            toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{}' }],
          },
          user('two'),
        ],
      }),
      request({ messages: [assistant('not a user turn')] }),
      request({ messages: [user('   ')] }),
      request({ messages: [] }),
    ];

    for (const candidate of cases) expectUnsupported(candidate);
  });

  it('builds a JSON-serialized full-context prompt with all text history', () => {
    const candidate = request({
      messages: [user('one\nline'), assistant('reply "one"'), user('two')],
    });

    const prompt = buildFullContextPrompt(candidate);
    const payload = {
      system: ['system "quoted" rule'],
      developer: ['developer rule'],
      messages: [
        { role: 'user', text: 'one\nline' },
        { role: 'assistant', text: 'reply "one"' },
        { role: 'user', text: 'two' },
      ],
    };

    expect(prompt).toContain(JSON.stringify(payload));
    expect(prompt).toContain('complete effective conversation context');
  });

  it('builds an append prompt containing only the new user turn', () => {
    const prompt = buildAppendPrompt(user('new turn'));

    expect(prompt).toContain(JSON.stringify({ user: 'new turn' }));
    expect(prompt).not.toContain('old turn');
    expect(prompt).toContain('existing conversation');
  });

  it('rejects a non-user append message instead of silently remapping it', () => {
    expect(() => buildAppendPrompt(assistant('not user'))).toThrowError(
      expect.objectContaining({ code: 'unsupported_phase4_request' }),
    );
  });
});
