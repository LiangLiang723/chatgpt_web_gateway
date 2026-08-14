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
