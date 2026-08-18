export type Phase6AttachmentErrorCode =
  | 'file_not_found'
  | 'invalid_file_upload'
  | 'file_too_large'
  | 'invalid_attachment'
  | 'attachment_too_large'
  | 'attachment_fetch_failed'
  | 'chatgpt_upload_failed'
  | 'chatgpt_upload_timeout'
  | 'file_storage_error'
  | 'unsupported_phase6_request';

export class AttachmentPipelineError extends Error {
  readonly code: Phase6AttachmentErrorCode;

  constructor(code: Phase6AttachmentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AttachmentPipelineError';
    this.code = code;
  }
}
