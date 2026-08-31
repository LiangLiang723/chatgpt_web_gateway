import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config/index.js';

export function registerModelsRoute(app: FastifyInstance, config: AppConfig): void {
  app.get('/v1/models', async () => ({
    object: 'list',
    data: [
      {
        id: 'chatgpt-web',
        object: 'model',
        created: 0,
        owned_by: 'chatgpt-web-gateway',
        name: 'ChatGPT Web',
        capabilities: ['image-recognition', 'file-input', 'function-call', 'structured-output'],
        input_modalities: ['text', 'image'],
        supports_streaming: true,
        context_window: config.modelContextWindow,
      },
    ],
  }));
}
