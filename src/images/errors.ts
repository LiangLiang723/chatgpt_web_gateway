export type ImageGenerationErrorCode =
  | 'invalid_image_request'
  | 'unsupported_image_request'
  | 'chatgpt_image_missing'
  | 'chatgpt_image_ambiguous'
  | 'chatgpt_image_fetch_failed'
  | 'image_storage_error'
  | 'image_not_found'
  | 'browser_maintenance_mode';

export class ImageGenerationError extends Error {
  constructor(
    readonly code: ImageGenerationErrorCode,
    message: string,
    readonly param?: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'ImageGenerationError';
  }
}
