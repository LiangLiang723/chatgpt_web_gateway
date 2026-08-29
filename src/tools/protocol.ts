export const TOOL_PROTOCOL_VERSION = 2;
export const TOOL_PROTOCOL_START = '<<<EXTERNAL_FUNCTION_REQUESTS_V1>>>';
export const TOOL_PROTOCOL_END = '<<<END_EXTERNAL_FUNCTION_REQUESTS_V1>>>';

export type ToolProtocolErrorCode =
  | 'chatgpt_tool_required'
  | 'chatgpt_tool_protocol_invalid'
  | 'chatgpt_tool_unknown'
  | 'chatgpt_tool_forbidden';

export class ToolProtocolError extends Error {
  constructor(
    readonly code: ToolProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolProtocolError';
  }
}

export interface PrivateToolCallPayload {
  requests: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}
