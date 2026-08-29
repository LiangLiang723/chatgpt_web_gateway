import { ImageGenerationError } from './errors.js';

export type ImageResponseFormat = 'url' | 'b64_json';

export interface NormalizedImageGenerationRequest {
  prompt: string;
  responseFormat: ImageResponseFormat;
  ignoredParameters: string[];
}

export interface GeneratedImageResult {
  id: string;
  createdAt: number;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  bytes: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string, param: string): never {
  throw new ImageGenerationError('invalid_image_request', message, param);
}

export function normalizeImageGenerationRequest(body: unknown): NormalizedImageGenerationRequest {
  if (!isRecord(body)) invalid('Image generation request body must be an object', 'body');

  const allowed = new Set([
    'prompt',
    'n',
    'response_format',
    'model',
    'size',
    'quality',
    'style',
    'user',
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) invalid(`Unsupported image generation parameter: ${key}`, key);
  }

  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
    invalid('prompt must be a non-empty string', 'prompt');
  }
  if (body.n !== undefined && body.n !== 1) {
    throw new ImageGenerationError('unsupported_image_request', 'Only n=1 is supported', 'n');
  }

  const responseFormat = body.response_format ?? 'url';
  if (responseFormat !== 'url' && responseFormat !== 'b64_json') {
    invalid('response_format must be url or b64_json', 'response_format');
  }

  const ignoredParameters: string[] = [];
  for (const key of ['model', 'quality', 'size', 'style', 'user'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim().length === 0) {
      invalid(`${key} must be a non-empty string`, key);
    }
    ignoredParameters.push(key);
  }
  ignoredParameters.sort();

  return {
    prompt: body.prompt,
    responseFormat,
    ignoredParameters,
  };
}
