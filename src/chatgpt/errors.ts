export type ChatGptDriverErrorCode =
  | 'auth_required'
  | 'browser_unavailable'
  | 'selector_missing'
  | 'selector_ambiguous'
  | 'chatgpt_generation_timeout'
  | 'chatgpt_response_missing'
  | 'chatgpt_upload_failed'
  | 'chatgpt_upload_timeout'
  | 'conversation_restore_failed';

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

export function asChatGptDriverError(
  error: unknown,
  message = 'ChatGPT page operation failed',
): ChatGptDriverError {
  if (error instanceof ChatGptDriverError) return error;
  return new ChatGptDriverError({
    code: 'browser_unavailable',
    message,
    cause: error,
  });
}
