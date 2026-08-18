import { AttachmentPipelineError } from './errors.js';
import { MAX_FILE_BYTES } from './policy.js';

export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface ImageTypeInfo {
  mimeType: SupportedImageMime;
  extension: 'png' | 'jpg' | 'webp' | 'gif';
}

export interface ParsedImageDataUrl {
  bytes: Buffer;
  mimeType: SupportedImageMime;
  filename: string;
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const IMAGE_TYPES: Record<SupportedImageMime, ImageTypeInfo> = {
  'image/png': { mimeType: 'image/png', extension: 'png' },
  'image/jpeg': { mimeType: 'image/jpeg', extension: 'jpg' },
  'image/webp': { mimeType: 'image/webp', extension: 'webp' },
  'image/gif': { mimeType: 'image/gif', extension: 'gif' },
};

export function decodeBase64Strict(data: string, maxBytes = MAX_FILE_BYTES): Buffer {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    throw new AttachmentPipelineError('invalid_attachment', 'Base64 attachment data is invalid');
  }

  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const estimatedBytes = (data.length / 4) * 3 - padding;
  if (estimatedBytes > maxBytes) {
    throw new AttachmentPipelineError(
      'attachment_too_large',
      'Attachment exceeds the Gateway size limit',
    );
  }

  const bytes = Buffer.from(data, 'base64');
  if (bytes.byteLength > maxBytes) {
    throw new AttachmentPipelineError(
      'attachment_too_large',
      'Attachment exceeds the Gateway size limit',
    );
  }
  return bytes;
}

export function validateImageBytes(bytes: Uint8Array, declaredMime?: string): ImageTypeInfo {
  const detected = sniffImageType(bytes);
  if (!detected) {
    throw new AttachmentPipelineError('invalid_attachment', 'Attachment is not a supported image');
  }
  if (declaredMime !== undefined && declaredMime.toLowerCase() !== detected.mimeType) {
    throw new AttachmentPipelineError(
      'invalid_attachment',
      'Declared image MIME does not match image bytes',
    );
  }
  return detected;
}

export function parseImageDataUrl(value: string): ParsedImageDataUrl {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) {
    throw new AttachmentPipelineError('invalid_attachment', 'Image Data URL is invalid');
  }
  const declaredMime = match[1] as SupportedImageMime;
  const bytes = decodeBase64Strict(match[2] ?? '');
  const info = validateImageBytes(bytes, declaredMime);
  return {
    bytes,
    mimeType: info.mimeType,
    filename: `image.${info.extension}`,
  };
}

function sniffImageType(bytes: Uint8Array): ImageTypeInfo | undefined {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return IMAGE_TYPES['image/png'];
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return IMAGE_TYPES['image/jpeg'];
  }
  if (
    bytes.byteLength >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return IMAGE_TYPES['image/webp'];
  }
  if (bytes.byteLength >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return IMAGE_TYPES['image/gif'];
  }
  return undefined;
}
