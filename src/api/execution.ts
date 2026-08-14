import { BackendNotImplementedError } from './errors.js';
import type { NormalizedRequest } from './normalized.js';

export interface TextExecutionResult {
  type: 'text';
  text: string;
  conversationUrl: string;
  completedAt: number;
}

export type NormalizedExecutionResult = TextExecutionResult;

export type NormalizedExecutionHandler = (
  request: NormalizedRequest,
) => Promise<NormalizedExecutionResult>;

export const backendNotImplementedExecution: NormalizedExecutionHandler = async () => {
  throw new BackendNotImplementedError();
};
