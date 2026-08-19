export type Phase4ExecutionErrorCode =
  'unsupported_phase4_request' | 'invalid_conversation_request';

export type Phase5ExecutionErrorCode =
  'unsupported_phase5_request' | 'invalid_conversation_request';

export type Phase6ExecutionErrorCode =
  'unsupported_phase6_request' | 'invalid_conversation_request';

export class Phase4ExecutionError extends Error {
  constructor(
    readonly code: Phase4ExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Phase4ExecutionError';
  }
}

export class Phase5ExecutionError extends Error {
  constructor(
    readonly code: Phase5ExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Phase5ExecutionError';
  }
}

export class Phase6ExecutionError extends Error {
  constructor(
    readonly code: Phase6ExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Phase6ExecutionError';
  }
}
