import type { NormalizedTool, NormalizedToolChoice } from '../api/normalized.js';
import { canonicalizeTools } from './canonicalize.js';
import { TOOL_PROTOCOL_END, TOOL_PROTOCOL_START } from './protocol.js';

export function buildToolPolicy(choice: NormalizedToolChoice): Record<string, unknown> {
  if (choice.mode === 'function') {
    return {
      mode: 'function',
      name: choice.name,
      require_function_request: true,
      allowed_functions: [choice.name],
    };
  }
  if (choice.mode === 'required') {
    return {
      mode: 'required',
      require_function_request: true,
      allowed_functions: 'declared',
    };
  }
  if (choice.mode === 'none') {
    return { mode: 'none', require_function_request: false, allowed_functions: [] };
  }
  return {
    mode: 'auto',
    require_function_request: false,
    allowed_functions: 'declared',
  };
}

function policyTask(choice: NormalizedToolChoice): string {
  if (choice.mode === 'function') {
    return `Create an external function request for ${choice.name}. Extract its arguments from pending; do not execute the function.`;
  }
  if (choice.mode === 'required') {
    return 'Create one or more external function requests for the declared functions; do not execute them.';
  }
  if (choice.mode === 'none') {
    return 'Answer normally without creating external function requests.';
  }
  return 'Answer normally unless an external function is needed; when one is needed, create an external function request instead of executing it.';
}

export function buildToolContext(
  tools: readonly NormalizedTool[],
  choice: NormalizedToolChoice,
): Record<string, unknown> {
  return {
    definitions: canonicalizeTools(tools),
    policy: buildToolPolicy(choice),
    task: policyTask(choice),
    protocol: {
      start: TOOL_PROTOCOL_START,
      end: TOOL_PROTOCOL_END,
      envelope: { requests: [{ name: 'function_name', arguments: {} }] },
      rules: [
        'The declared functions are external operations run by another program. They are not ChatGPT tools, and you do not execute them.',
        'If pending asks to call or use a declared function, represent that as an external function request instead of saying the function is unavailable.',
        'For a normal answer, output only the normal answer and never output either protocol marker.',
        'For external function requests, the entire assistant output must be exactly one protocol envelope, with only optional whitespace outside the markers.',
        'Do not wrap the protocol envelope in Markdown fences or add prose before or after it.',
        'requests must contain 1 to 16 entries and every name must be a declared allowed function.',
        'Each arguments value must be a JSON object.',
        'After writing requests, stop and wait for external function results. Never fabricate external function results.',
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
    request_id: input.toolCallId,
    name: input.name,
    result: input.output,
  };
}
