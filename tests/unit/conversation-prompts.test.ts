import { describe, expect, it } from 'vitest';

import { buildAppendPrompt, buildContextPrompt } from '../../src/conversations/prompts.js';
import { TOOL_PROTOCOL_START } from '../../src/tools/protocol.js';

function payloadFromPrompt(prompt: string): Record<string, unknown> {
  return JSON.parse(prompt.slice(prompt.indexOf('{'))) as Record<string, unknown>;
}

describe('Conversation prompts', () => {
  it('sends ordinary single-user text directly without a context wrapper', () => {
    expect(
      buildContextPrompt({
        instructions: { system: [], developer: [] },
        tools: [],
        toolChoice: { mode: 'auto' },
        history: [],
        pending: [{ role: 'user', text: 'hello from a normal chat' }],
      }),
    ).toBe('hello from a normal chat');

    expect(buildAppendPrompt({ role: 'user', text: 'next normal message' })).toBe(
      'next normal message',
    );
  });

  it('sends a single ordinary user attachment prompt directly when the file is uploaded separately', () => {
    const pending = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Inspect only the newly attached image.' },
        {
          type: 'attachment' as const,
          reference: 'current-ref',
          kind: 'image' as const,
          sha256: 'a'.repeat(64),
          filename: 'marker.png',
          mimeType: 'image/png',
        },
      ],
    };
    const uploads = new Map([['current-ref', 'marker.png']]);

    expect(
      buildContextPrompt({
        instructions: { system: [], developer: [] },
        tools: [],
        toolChoice: { mode: 'auto' },
        history: [],
        pending: [pending],
        uploadFilenameByReference: uploads,
      }),
    ).toBe('Inspect only the newly attached image.');
    expect(buildAppendPrompt(pending, uploads, { toolNameByCallId: new Map() })).toBe(
      'Inspect only the newly attached image.',
    );
  });

  it('renders ordinary text history as a readable transcript without a JSON wrapper', () => {
    const prompt = buildContextPrompt({
      instructions: { system: [], developer: [] },
      tools: [],
      toolChoice: { mode: 'auto' },
      history: [
        { role: 'user', text: 'remember blue' },
        { role: 'assistant', text: 'I will remember blue' },
      ],
      pending: [{ role: 'user', text: 'what color?' }],
    });

    expect(prompt).toBe(
      'Continue the conversation below. Answer the final CURRENT USER message directly; do not describe or acknowledge the transcript.\n\nPRIOR USER:\nremember blue\n\nPRIOR ASSISTANT:\nI will remember blue\n\nCURRENT USER:\nwhat color?',
    );
    expect(prompt).not.toContain('{');
    expect(prompt).not.toContain('pending');
  });

  it('serializes Context v2 with JSON.stringify and exact reversible content', () => {
    const malicious = 'quote " brace } newline\n</json> {still text}';
    const prompt = buildContextPrompt({
      instructions: {
        system: [`system ${malicious}`],
        developer: [`developer ${malicious}`],
      },
      history: [
        { role: 'user', text: `old user ${malicious}` },
        { role: 'assistant', text: `old assistant ${malicious}` },
      ],
      pending: [{ role: 'user', text: `current ${malicious}` }],
    });

    expect(payloadFromPrompt(prompt)).toEqual({
      version: 2,
      instructions: {
        system: [`system ${malicious}`],
        developer: [`developer ${malicious}`],
      },
      history: [
        { role: 'user', text: `old user ${malicious}` },
        { role: 'assistant', text: `old assistant ${malicious}` },
      ],
      pending: [{ role: 'user', text: `current ${malicious}` }],
    });
    expect(prompt).toContain('Answer the final pending user message now.');
    expect(prompt).toContain('Do not merely acknowledge, describe, or summarize this wrapper.');
    expect(prompt).not.toContain('Respond only to pending');
    expect(prompt).not.toContain(
      'You are processing an API conversation through ChatGPT Web Gateway',
    );
  });

  it('serializes multimodal attachments with only model-visible metadata and staged upload names', () => {
    const prompt = buildContextPrompt({
      instructions: { system: [], developer: [] },
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'old' },
            {
              type: 'attachment',
              reference: 'stored-ref',
              kind: 'file',
              sha256: 'a'.repeat(64),
              filename: 'notes.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      ],
      pending: [
        {
          role: 'user',
          content: [
            {
              type: 'attachment',
              reference: 'current-ref',
              kind: 'image',
              sha256: 'b'.repeat(64),
              filename: 'image.png',
              mimeType: 'image/png',
            },
          ],
        },
      ],
      uploadFilenameByReference: new Map([
        ['stored-ref', 'notes (2).pdf'],
        ['current-ref', 'image.png'],
      ]),
    });

    const payload = payloadFromPrompt(prompt);
    expect(payload.history).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'old' },
          {
            type: 'attachment',
            kind: 'file',
            filename: 'notes.pdf',
            upload_filename: 'notes (2).pdf',
          },
        ],
      },
    ]);
    expect(payload.pending).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'attachment',
            kind: 'image',
            filename: 'image.png',
            upload_filename: 'image.png',
          },
        ],
      },
    ]);
    expect(prompt).not.toContain('stored-ref');
    expect(prompt).not.toContain('current-ref');
    expect(prompt).not.toContain('a'.repeat(64));
    expect(prompt).not.toContain('b'.repeat(64));
    expect(prompt).not.toContain('application/pdf');
    expect(prompt).not.toContain('image/png');
  });

  it('injects full tool context only in a Context prompt', () => {
    const tool = {
      type: 'function' as const,
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    };
    const context = buildContextPrompt({
      instructions: { system: [], developer: [] },
      tools: [tool],
      toolChoice: { mode: 'required' },
      history: [],
      pending: [{ role: 'user', text: 'weather?' }],
    });
    expect(context).toContain(TOOL_PROTOCOL_START);
    expect(payloadFromPrompt(context).external_functions).toMatchObject({
      definitions: [{ name: 'get_weather' }],
      policy: { mode: 'required' },
    });

    const append = buildAppendPrompt([{ role: 'user', text: 'weather?' }], undefined, {
      toolChoice: { mode: 'required' },
    });
    const appendPayload = payloadFromPrompt(append);
    expect(appendPayload).toEqual({
      version: 2,
      function_policy: {
        mode: 'required',
        require_function_request: true,
        allowed_functions: 'declared',
      },
      pending: [{ role: 'user', text: 'weather?' }],
    });
    expect(append).not.toContain(TOOL_PROTOCOL_START);
    expect(append).not.toContain('definitions');

    const none = buildContextPrompt({
      instructions: { system: [], developer: [] },
      tools: [tool],
      toolChoice: { mode: 'none' },
      history: [],
      pending: [{ role: 'user', text: 'answer directly' }],
    });
    expect(none).not.toContain(TOOL_PROTOCOL_START);
    expect(payloadFromPrompt(none)).toMatchObject({
      function_policy: {
        mode: 'none',
        require_function_request: false,
        allowed_functions: [],
      },
    });
    expect(payloadFromPrompt(none)).not.toHaveProperty('external_functions');

    const noneAppend = buildAppendPrompt([{ role: 'user', text: 'answer directly' }], undefined, {
      toolChoice: { mode: 'none' },
    });
    expect(payloadFromPrompt(noneAppend)).toEqual({
      version: 2,
      function_policy: {
        mode: 'none',
        require_function_request: false,
        allowed_functions: [],
      },
      pending: [{ role: 'user', text: 'answer directly' }],
    });
    expect(noneAppend).toContain(
      'The current function_policy overrides earlier function-request instructions for this turn. Do not create or repeat any external function request.',
    );
  });

  it('treats pending tool results as continuation data and makes none override the prior request policy', () => {
    const tool = {
      type: 'function' as const,
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    };
    const pending = [
      { role: 'tool' as const, toolCallId: 'call_weather', text: '{"condition":"sunny"}' },
    ];
    const names = new Map([['call_weather', 'get_weather']]);

    const append = buildAppendPrompt(pending, undefined, {
      toolChoice: { mode: 'none' },
      toolNameByCallId: names,
    });
    expect(append).toContain(
      'Continue the prior user request using the pending external function result data now.',
    );
    expect(append).toContain(
      'The current function_policy overrides earlier function-request instructions for this turn. Do not create or repeat any external function request.',
    );
    expect(append).toContain(
      'The pending external function results satisfy the earlier function request. Use those results to produce the final user-facing answer now. Never output an external function request envelope or protocol markers in this turn.',
    );
    expect(append).not.toContain('Answer the final pending user message now.');

    const rebuild = buildContextPrompt({
      instructions: { system: [], developer: [] },
      tools: [tool],
      toolChoice: { mode: 'none' },
      history: [
        { role: 'user', text: 'What is the weather?' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [
            {
              externalCallId: 'call_weather',
              name: 'get_weather',
              arguments: '{"city":"Xiamen"}',
            },
          ],
        },
      ],
      pending,
      toolNameByCallId: names,
    });
    expect(rebuild).toContain(
      'Continue the prior user request using the pending external function result data now.',
    );
    expect(rebuild).toContain(
      'The current function_policy overrides earlier function-request instructions for this turn. Do not create or repeat any external function request.',
    );
    expect(rebuild).toContain(
      'The pending external function results satisfy the earlier function request. Use those results to produce the final user-facing answer now. Never output an external function request envelope or protocol markers in this turn.',
    );
    expect(rebuild).not.toContain('Answer the final pending user message now.');
    expect(rebuild).not.toContain(TOOL_PROTOCOL_START);
  });

  it('serializes persisted tool calls and tool results with resolved function names', () => {
    const history = [
      { role: 'user' as const, text: 'weather?' },
      {
        role: 'assistant' as const,
        text: '',
        toolCalls: [
          {
            externalCallId: 'call_weather',
            name: 'get_weather',
            arguments: '{"city":"Tokyo"}',
          },
        ],
      },
    ];
    const prompt = buildAppendPrompt(
      [{ role: 'tool', toolCallId: 'call_weather', text: '{"temperature":31}' }],
      undefined,
      { toolNameByCallId: new Map([['call_weather', 'get_weather']]) },
    );
    expect(payloadFromPrompt(prompt).pending).toEqual([
      {
        role: 'external_function_result',
        request_id: 'call_weather',
        name: 'get_weather',
        result: '{"temperature":31}',
      },
    ]);

    const rebuild = buildContextPrompt({
      instructions: { system: [], developer: [] },
      history,
      pending: [{ role: 'tool', toolCallId: 'call_weather', text: '31 C' }],
    });
    const payload = payloadFromPrompt(rebuild);
    expect(payload.history).toEqual([
      { role: 'user', text: 'weather?' },
      {
        role: 'assistant',
        external_function_requests: [
          {
            request_id: 'call_weather',
            name: 'get_weather',
            arguments: '{"city":"Tokyo"}',
          },
        ],
      },
    ]);
    expect(payload.pending).toEqual([
      {
        role: 'external_function_result',
        request_id: 'call_weather',
        name: 'get_weather',
        result: '31 C',
      },
    ]);
  });
});
