import { describe, expect, it } from 'vitest';

import { buildAppendPrompt, buildContextPrompt } from '../../src/conversations/prompts.js';
import { TOOL_PROTOCOL_START } from '../../src/tools/protocol.js';

function payloadFromPrompt(prompt: string): Record<string, unknown> {
  return JSON.parse(prompt.slice(prompt.indexOf('{'))) as Record<string, unknown>;
}

describe('Conversation prompts', () => {
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
      tools: {
        definitions: [],
        policy: { mode: 'auto', require_tool_call: false, allowed_tools: 'declared' },
      },
      history: [
        { role: 'user', text: `old user ${malicious}` },
        { role: 'assistant', text: `old assistant ${malicious}` },
      ],
      pending: [{ role: 'user', text: `current ${malicious}` }],
    });
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
    expect(payloadFromPrompt(context).tools).toMatchObject({
      definitions: [{ name: 'get_weather' }],
      policy: { mode: 'required' },
    });

    const append = buildAppendPrompt([{ role: 'user', text: 'weather?' }], undefined, {
      toolChoice: { mode: 'required' },
    });
    const appendPayload = payloadFromPrompt(append);
    expect(appendPayload).toEqual({
      version: 2,
      tool_policy: {
        mode: 'required',
        require_tool_call: true,
        allowed_tools: 'declared',
      },
      pending: [{ role: 'user', text: 'weather?' }],
    });
    expect(append).not.toContain(TOOL_PROTOCOL_START);
    expect(append).not.toContain('definitions');
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
        role: 'tool',
        tool_call_id: 'call_weather',
        name: 'get_weather',
        output: '{"temperature":31}',
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
        tool_calls: [
          {
            tool_call_id: 'call_weather',
            name: 'get_weather',
            arguments: '{"city":"Tokyo"}',
          },
        ],
      },
    ]);
    expect(payload.pending).toEqual([
      { role: 'tool', tool_call_id: 'call_weather', name: 'get_weather', output: '31 C' },
    ]);
  });
});
