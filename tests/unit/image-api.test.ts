import { describe, expect, it } from 'vitest';

import { normalizeImageGenerationRequest } from '../../src/images/types.js';

describe('image generation request normalization', () => {
  it('defaults to one URL image and records compatibility-only fields as ignored', () => {
    expect(
      normalizeImageGenerationRequest({
        prompt: 'a lighthouse in a storm',
        model: 'gpt-image-1',
        size: '1024x1024',
        quality: 'high',
      }),
    ).toEqual({
      prompt: 'a lighthouse in a storm',
      responseFormat: 'url',
      ignoredParameters: ['model', 'quality', 'size'],
    });
  });

  it('accepts b64_json and n=1', () => {
    expect(
      normalizeImageGenerationRequest({
        prompt: 'cat',
        n: 1,
        response_format: 'b64_json',
      }),
    ).toEqual({ prompt: 'cat', responseFormat: 'b64_json', ignoredParameters: [] });
  });

  it.each([
    [{}, 'prompt'],
    [{ prompt: '' }, 'prompt'],
    [{ prompt: 'cat', n: 2 }, 'n'],
    [{ prompt: 'cat', response_format: 'invalid' }, 'response_format'],
    [{ prompt: 'cat', extra: true }, 'extra'],
  ])('rejects invalid image request %#', (body, param) => {
    expect(() => normalizeImageGenerationRequest(body)).toThrowError(
      expect.objectContaining({ code: expect.any(String), param }),
    );
  });
});
