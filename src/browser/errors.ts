export type BrowserRuntimeErrorCode = 'browser_unavailable' | 'page_capacity_exceeded';

export class BrowserRuntimeError extends Error {
  constructor(
    readonly code: BrowserRuntimeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'BrowserRuntimeError';
  }
}
