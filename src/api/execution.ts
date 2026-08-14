import { BackendNotImplementedError } from './errors.js';
import type { NormalizedRequest } from './normalized.js';

export type NormalizedExecutionHandler = (request: NormalizedRequest) => Promise<unknown>;

export const backendNotImplementedExecution: NormalizedExecutionHandler = async () => {
  throw new BackendNotImplementedError();
};
