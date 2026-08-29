import { describe, expect, it, vi } from 'vitest';

import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config/index.js';
import type { ImageGenerationServiceLike } from '../../src/images/service.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

function service() {
  const generate = vi.fn(async () => ({
    id,
    createdAt: 1_787_800_000_000,
    mimeType: 'image/png',
    sizeBytes: bytes.length,
    sha256: 'a'.repeat(64),
    storagePath: `/data/generated/${id}.png`,
    bytes,
  }));
  const read = vi.fn(async () => ({
    record: {
      id,
      prompt: 'cat',
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      sha256: 'a'.repeat(64),
      storagePath: `/data/generated/${id}.png`,
      createdAt: 1_787_800_000_000,
    },
    bytes,
  }));
  return { generate, read } satisfies ImageGenerationServiceLike;
}

describe('Images API routes', () => {
  it('returns a persistent Gateway URL and passes normalized compatibility metadata', async () => {
    const imageService = service();
    const app = buildServer({
      config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
      imageService,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { authorization: 'Bearer test-key', host: 'gateway.local:3000' },
      payload: {
        prompt: 'cat',
        n: 1,
        size: '1024x1024',
        response_format: 'url',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      created: 1_787_800_000,
      data: [{ url: `http://gateway.local:3000/v1/images/${id}/content` }],
    });
    expect(imageService.generate).toHaveBeenCalledWith({
      prompt: 'cat',
      responseFormat: 'url',
      ignoredParameters: ['size'],
    });
    await app.close();
  });

  it('uses PUBLIC_BASE_URL and supports b64_json', async () => {
    const imageService = service();
    const app = buildServer({
      config: loadConfig({
        GATEWAY_API_KEY: 'test-key',
        PUBLIC_BASE_URL: 'https://gateway.example/base/',
      }),
      imageService,
    });

    const urlResponse = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { authorization: 'Bearer test-key' },
      payload: { prompt: 'cat' },
    });
    expect(urlResponse.json().data[0].url).toBe(
      `https://gateway.example/base/v1/images/${id}/content`,
    );

    const b64Response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { authorization: 'Bearer test-key' },
      payload: { prompt: 'cat', response_format: 'b64_json' },
    });
    expect(b64Response.statusCode).toBe(200);
    expect(Buffer.from(b64Response.json().data[0].b64_json, 'base64')).toEqual(bytes);
    await app.close();
  });

  it('serves stored image content behind bearer authentication', async () => {
    const imageService = service();
    const app = buildServer({
      config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
      imageService,
    });

    const unauthorized = await app.inject({ method: 'GET', url: `/v1/images/${id}/content` });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/images/${id}/content`,
      headers: { authorization: 'Bearer test-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.rawPayload).toEqual(bytes);
    await app.close();
  });

  it('maps image validation errors to OpenAI-style 400 responses', async () => {
    const app = buildServer({
      config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
      imageService: service(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { authorization: 'Bearer test-key' },
      payload: { prompt: 'cat', n: 2 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'unsupported_image_request', param: 'n' },
    });
    await app.close();
  });
});
