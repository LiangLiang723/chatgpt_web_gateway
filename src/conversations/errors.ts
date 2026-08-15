export type Phase4ExecutionErrorCode =
  | 'unsupported_phase4_request'
  | 'invalid_conversation_request';

export class Phase4ExecutionError extends Error {
  constructor(
    readonly code: Phase4ExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Phase4ExecutionError';
  }
}
