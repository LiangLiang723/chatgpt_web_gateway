import { describe, expect, it } from 'vitest';

import { parseAssistantOutput } from '../../src/tools/parser.js';
import { TOOL_PROTOCOL_END, TOOL_PROTOCOL_START } from '../../src/tools/protocol.js';

const tools = [
  { type: 'function' as const, name: 'weather', parameters: { type: 'object' } },
  { type: 'function' as const, name: 'clock', parameters: { type: 'object' } },
];

function envelope(calls: unknown): string {
  return `${TOOL_PROTOCOL_START}\n${JSON.stringify({ requests: calls })}\n${TOOL_PROTOCOL_END}`;
}

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(expect.objectContaining({ code }));
}

describe('strict tool parser', () => {
  it('treats ordinary output as text for auto and when no tools exist', () => {
    expect(parseAssistantOutput('hello', { tools, toolChoice: { mode: 'auto' } })).toEqual({
      type: 'text',
      text: 'hello',
    });
    expect(
      parseAssistantOutput(`${TOOL_PROTOCOL_START} not-a-protocol`, {
        tools: [],
        toolChoice: { mode: 'auto' },
      }),
    ).toEqual({ type: 'text', text: `${TOOL_PROTOCOL_START} not-a-protocol` });
  });

  it('parses one and multiple calls and re-stringifies argument objects', () => {
    expect(
      parseAssistantOutput(envelope([{ name: 'weather', arguments: { city: 'Xiamen' } }]), {
        tools,
        toolChoice: { mode: 'auto' },
      }),
    ).toEqual({
      type: 'tool_calls',
      calls: [{ name: 'weather', arguments: '{"city":"Xiamen"}' }],
    });
    expect(
      parseAssistantOutput(
        envelope([
          { name: 'weather', arguments: { city: 'Tokyo' } },
          { name: 'clock', arguments: { zone: 'UTC' } },
        ]),
        { tools, toolChoice: { mode: 'required' } },
      ),
    ).toMatchObject({ type: 'tool_calls', calls: [{ name: 'weather' }, { name: 'clock' }] });
  });

  it('rejects required text, malformed framing, fences and bad JSON', () => {
    expectCode(
      () => parseAssistantOutput('plain', { tools, toolChoice: { mode: 'required' } }),
      'chatgpt_tool_required',
    );
    expectCode(
      () =>
        parseAssistantOutput(`prefix ${envelope([{ name: 'weather', arguments: {} }])}`, {
          tools,
          toolChoice: { mode: 'auto' },
        }),
      'chatgpt_tool_protocol_invalid',
    );
    expectCode(
      () =>
        parseAssistantOutput(
          `\`\`\`json\n${envelope([{ name: 'weather', arguments: {} }])}\n\`\`\``,
          {
            tools,
            toolChoice: { mode: 'auto' },
          },
        ),
      'chatgpt_tool_protocol_invalid',
    );
    expectCode(
      () =>
        parseAssistantOutput(`${TOOL_PROTOCOL_START}\n{bad}\n${TOOL_PROTOCOL_END}`, {
          tools,
          toolChoice: { mode: 'auto' },
        }),
      'chatgpt_tool_protocol_invalid',
    );
  });

  it('rejects extra keys, non-object arguments, unknown and forbidden functions', () => {
    expectCode(
      () =>
        parseAssistantOutput(
          `${TOOL_PROTOCOL_START}\n${JSON.stringify({ requests: [], extra: true })}\n${TOOL_PROTOCOL_END}`,
          { tools, toolChoice: { mode: 'auto' } },
        ),
      'chatgpt_tool_protocol_invalid',
    );
    expectCode(
      () =>
        parseAssistantOutput(envelope([{ name: 'weather', arguments: [] }]), {
          tools,
          toolChoice: { mode: 'auto' },
        }),
      'chatgpt_tool_protocol_invalid',
    );
    expectCode(
      () =>
        parseAssistantOutput(envelope([{ name: 'missing', arguments: {} }]), {
          tools,
          toolChoice: { mode: 'auto' },
        }),
      'chatgpt_tool_unknown',
    );
    expectCode(
      () =>
        parseAssistantOutput(envelope([{ name: 'weather', arguments: {} }]), {
          tools,
          toolChoice: { mode: 'none' },
        }),
      'chatgpt_tool_forbidden',
    );
    expectCode(
      () =>
        parseAssistantOutput(envelope([{ name: 'clock', arguments: {} }]), {
          tools,
          toolChoice: { mode: 'function', name: 'weather' },
        }),
      'chatgpt_tool_forbidden',
    );
  });

  it('rejects call-level extra keys and more than sixteen calls', () => {
    expectCode(
      () =>
        parseAssistantOutput(envelope([{ name: 'weather', arguments: {}, extra: 'no' }]), {
          tools,
          toolChoice: { mode: 'auto' },
        }),
      'chatgpt_tool_protocol_invalid',
    );
    expectCode(
      () =>
        parseAssistantOutput(
          envelope(Array.from({ length: 17 }, () => ({ name: 'weather', arguments: {} }))),
          { tools, toolChoice: { mode: 'auto' } },
        ),
      'chatgpt_tool_protocol_invalid',
    );
  });
});
