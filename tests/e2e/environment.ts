import { parseInspectEnvironment, type InspectEnvironment } from '../../src/chatgpt/inspect.js';

export interface RealE2EEnvironment extends InspectEnvironment {
  E2E_CHATGPT?: string;
  E2E_CHATGPT_COMBINED?: string;
}

export function parseRealE2EEnvironment(env: RealE2EEnvironment) {
  if (env.E2E_CHATGPT !== '1') {
    throw new Error('E2E_CHATGPT=1 is required for real ChatGPT E2E');
  }
  return parseInspectEnvironment(env);
}

export function requireCombinedRealE2E(env: RealE2EEnvironment): void {
  if (env.E2E_CHATGPT_COMBINED !== '1') {
    throw new Error('E2E_CHATGPT_COMBINED=1 is required for the combined real ChatGPT E2E');
  }
}
