import type { NormalizedTool, NormalizedToolChoice } from '../api/normalized.js';
import { TOOL_PROTOCOL_END, TOOL_PROTOCOL_START, ToolProtocolError } from './protocol.js';

export type ParsedAssistantOutput =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: Array<{ name: string; arguments: string }> };

function invalid(message: string): never {
  throw new ToolProtocolError('chatgpt_tool_protocol_invalid', message);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const target = [...expected].sort();
  return keys.length === target.length && keys.every((key, index) => key === target[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAssistantOutput(
  text: string,
  context: { tools: readonly NormalizedTool[]; toolChoice: NormalizedToolChoice },
): ParsedAssistantOutput {
  if (context.tools.length === 0) return { type: 'text', text };

  const hasMarker = text.includes(TOOL_PROTOCOL_START) || text.includes(TOOL_PROTOCOL_END);
  if (!hasMarker) {
    if (context.toolChoice.mode === 'required' || context.toolChoice.mode === 'function') {
      throw new ToolProtocolError(
        'chatgpt_tool_required',
        'ChatGPT returned text when the current tool policy requires a tool call',
      );
    }
    return { type: 'text', text };
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith(TOOL_PROTOCOL_START) || !trimmed.endsWith(TOOL_PROTOCOL_END)) {
    invalid('Tool protocol markers must wrap the entire Assistant output');
  }

  const payloadText = trimmed.slice(TOOL_PROTOCOL_START.length, -TOOL_PROTOCOL_END.length).trim();
  if (payloadText.length === 0) invalid('Tool protocol payload is empty');

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return invalid('Tool protocol payload is not valid JSON');
  }
  if (!isRecord(payload) || !exactKeys(payload, ['requests'])) {
    invalid('Function request protocol root must contain only requests');
  }
  if (
    !Array.isArray(payload.requests) ||
    payload.requests.length < 1 ||
    payload.requests.length > 16
  ) {
    invalid('Function request protocol requests must contain between 1 and 16 entries');
  }

  if (context.toolChoice.mode === 'none') {
    throw new ToolProtocolError(
      'chatgpt_tool_forbidden',
      'ChatGPT emitted a tool call while tool_choice is none',
    );
  }

  const known = new Set(context.tools.map((tool) => tool.name));
  const calls = payload.requests.map((value) => {
    if (!isRecord(value) || !exactKeys(value, ['name', 'arguments'])) {
      return invalid('Each function request must contain only name and arguments');
    }
    if (typeof value.name !== 'string' || value.name.trim().length === 0) {
      return invalid('Function request name must be a non-empty string');
    }
    if (!isRecord(value.arguments)) {
      return invalid('Function request arguments must be a JSON object');
    }
    if (!known.has(value.name)) {
      throw new ToolProtocolError('chatgpt_tool_unknown', 'ChatGPT requested an unknown tool');
    }
    if (context.toolChoice.mode === 'function' && value.name !== context.toolChoice.name) {
      throw new ToolProtocolError(
        'chatgpt_tool_forbidden',
        'ChatGPT requested a function outside the forced tool policy',
      );
    }
    return { name: value.name, arguments: JSON.stringify(value.arguments) };
  });

  return { type: 'tool_calls', calls };
}
