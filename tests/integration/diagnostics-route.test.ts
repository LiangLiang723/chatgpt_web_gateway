import { describe, expect, it } from 'vitest';

import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config/index.js';

describe('runtime diagnostics route', () => {
  it('is authenticated and exposes only bounded local runtime facts', async () => {
    const app = buildServer({
      config: loadConfig({ GATEWAY_API_KEY: 'test-key' }),
      diagnostics: {
        snapshot: () => ({
          status: 'ready',
          ui_mode: 'headless',
          browser: {
            available: true,
            auth_state: 'not_probed',
            pages: { open: 3, leased: 1, idle: 2 },
          },
          persistence: {
            sqlite: 'ready',
            files: 'ready',
            generated_images: 'ready',
          },
        }),
      },
    });

    const unauthorized = await app.inject({ method: 'GET', url: '/v1/diagnostics' });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/diagnostics',
      headers: { authorization: 'Bearer test-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      ui_mode: 'headless',
      browser: {
        available: true,
        auth_state: 'not_probed',
        pages: { open: 3, leased: 1, idle: 2 },
      },
      persistence: {
        sqlite: 'ready',
        files: 'ready',
        generated_images: 'ready',
      },
    });
    expect(response.body).not.toMatch(/api.key|authorization|cookie|proxy|profile/i);
    await app.close();
  });
});
