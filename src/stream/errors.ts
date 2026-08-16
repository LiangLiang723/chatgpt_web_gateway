export type TextStreamErrorCode =
  | 'chatgpt_stream_diverged'
  | 'chatgpt_generation_timeout'
  | 'chatgpt_response_missing'
  | 'stream_aborted';

export class TextStreamError extends Error {
  readonly code: TextStreamErrorCode;

  constructor(code: TextStreamErrorCode, message: string) {
    super(message);
    this.name = 'TextStreamError';
    this.code = code;
  }
}

export class ChatGptStreamDivergedError extends TextStreamError {
  constructor(message = 'ChatGPT Assistant stream diverged from the committed prefix') {
    super('chatgpt_stream_diverged', message);
    this.name = 'ChatGptStreamDivergedError';
  }
}

export class TextStreamAbortedError extends TextStreamError {
  constructor() {
    super('stream_aborted', 'Streaming execution was aborted');
    this.name = 'TextStreamAbortedError';
  }
}
