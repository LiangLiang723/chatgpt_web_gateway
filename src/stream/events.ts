export interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CompletedTextResult {
  type: 'text';
  text: string;
  conversationUrl: string;
  completedAt: number;
}

export interface CompletedToolCallResult {
  type: 'tool_calls';
  toolCalls: StreamToolCall[];
  conversationUrl: string;
  completedAt: number;
}

export type CompletedExecutionResult = CompletedTextResult | CompletedToolCallResult;

export type ExecutionStreamEvent =
  | { type: 'started'; startedAt: number }
  | { type: 'text.delta'; delta: string }
  | { type: 'tool_calls'; toolCalls: StreamToolCall[] }
  | { type: 'completed'; result: CompletedExecutionResult };

export type TextStreamEvent = ExecutionStreamEvent;
