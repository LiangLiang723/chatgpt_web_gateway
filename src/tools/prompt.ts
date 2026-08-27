import type { NormalizedTool, NormalizedToolChoice } from '../api/normalized.js';
import { canonicalizeTools } from './canonicalize.js';
import { TOOL_PROTOCOL_END, TOOL_PROTOCOL_START } from './protocol.js';

export function buildToolPolicy(choice: NormalizedToolChoice): Record<string, unknown> {
  if (choice.mode === 'function') {
    return {
      mode: 'function',
      name: choice.name,
      require_tool_call: true,
      allowed_tools: [choice.name],
    };
  }
  if (choice.mode === 'required') {
    return { mode: 'required', require_tool_call: true, allowed_tools: 'declared' };
  }
  if (choice.mode === 'none') {
    return { mode: 'none', require_tool_call: false, allowed_tools: [] };
  }
  return { mode: 'auto', require_tool_call: false, allowed_tools: 'declared' };
}

export function buildToolContext(
  tools: readonly NormalizedTool[],
  choice: NormalizedToolChoice,
): Record<string, unknown> {
  return {
    definitions: canonicalizeTools(tools),
    policy: buildToolPolicy(choice),
    protocol: {
      start: TOOL_PROTOCOL_START,
      end: TOOL_PROTOCOL_END,
      envelope: { calls: [{ name: 'tool_name', arguments: {} }] },
      rules: [
        'For a normal answer, output only the normal answer and never output either protocol marker.',
        'For tool calls, the entire assistant output must be exactly one protocol envelope, with only optional whitespace outside the markers.',
        'Do not wrap the protocol envelope in Markdown fences or add prose before or after it.',
        'calls must contain 1 to 16 entries and every name must be a declared allowed function.',
        'Each arguments value must be a JSON object.',
        'After requesting tools, stop and wait for tool results. Never fabricate tool results.',
      ],
    },
  };
}

export function buildToolResultData(input: {
  toolCallId: string;
  name: string;
  output: string;
}): Record<string, string> {
  return {
    tool_call_id: input.toolCallId,
    name: input.name,
    output: input.output,
  };
}
