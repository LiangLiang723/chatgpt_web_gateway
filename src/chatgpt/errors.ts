export type ChatGptDriverErrorCode =
  | 'auth_required'
  | 'selector_missing'
  | 'selector_ambiguous'
  | 'chatgpt_generation_timeout'
  | 'chatgpt_response_missing';

export interface ChatGptDriverErrorOptions {
  code: ChatGptDriverErrorCode;
  message: string;
  selectorName?: string;
  candidateName?: string;
  cause?: unknown;
}

export class ChatGptDriverError extends Error {
  readonly code: ChatGptDriverErrorCode;
  readonly selectorName?: string;
  readonly candidateName?: string;
  readonly cause?: unknown;

  constructor(options: ChatGptDriverErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'ChatGptDriverError';
    this.code = options.code;
    this.selectorName = options.selectorName;
    this.candidateName = options.candidateName;
    this.cause = options.cause;
  }
}
