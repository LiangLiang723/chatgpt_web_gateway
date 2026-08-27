export const TOOL_PROTOCOL_START = '<<<CHATGPT_WEB_GATEWAY_TOOL_CALLS_V1>>>';
export const TOOL_PROTOCOL_END = '<<<END_CHATGPT_WEB_GATEWAY_TOOL_CALLS_V1>>>';

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
  calls: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
}
