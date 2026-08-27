import type { ExecutionStreamEvent } from '../stream/events.js';
import { BackendNotImplementedError } from './errors.js';
import type { NormalizedRequest, NormalizedToolCall } from './normalized.js';

export interface TextExecutionResult {
  type: 'text';
  text: string;
  conversationUrl: string;
  completedAt: number;
}

export interface ToolCallExecutionResult {
  type: 'tool_calls';
  toolCalls: NormalizedToolCall[];
  conversationUrl: string;
  completedAt: number;
}

export type NormalizedExecutionResult = TextExecutionResult | ToolCallExecutionResult;

export type NormalizedExecutionHandler = (
  request: NormalizedRequest,
) => Promise<NormalizedExecutionResult>;

export type TextStreamSink = (event: ExecutionStreamEvent) => Promise<void>;

export interface StreamingExecutionOptions {
  signal: AbortSignal;
  sink: TextStreamSink;
}

export type NormalizedStreamingExecutionHandler = (
  request: NormalizedRequest,
  options: StreamingExecutionOptions,
) => Promise<NormalizedExecutionResult>;

export interface ConversationExecutionEngine {
  execute: NormalizedExecutionHandler;
  stream: NormalizedStreamingExecutionHandler;
}

export class BrowserMaintenanceModeError extends Error {
  readonly code = 'browser_maintenance_mode';

  constructor() {
    super('Browser execution is disabled during maintenance mode');
    this.name = 'BrowserMaintenanceModeError';
  }
}

export const backendNotImplementedExecution: NormalizedExecutionHandler = async () => {
  throw new BackendNotImplementedError();
};

export const browserMaintenanceModeExecution: NormalizedExecutionHandler = async () => {
  throw new BrowserMaintenanceModeError();
};

export const backendNotImplementedStreamingExecution: NormalizedStreamingExecutionHandler =
  async () => {
    throw new BackendNotImplementedError();
  };

export const browserMaintenanceModeStreamingExecution: NormalizedStreamingExecutionHandler =
  async () => {
    throw new BrowserMaintenanceModeError();
  };
