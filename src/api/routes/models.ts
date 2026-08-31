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
        capabilities: [
          'reasoning',
          'image-recognition',
          'file-input',
          'function-call',
          'structured-output',
        ],
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        supports_streaming: true,
        context_window: config.modelContextWindow,
        max_input_tokens: config.modelMaxInputTokens,
        max_output_tokens: config.modelMaxOutputTokens,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        supportsStreaming: true,
        contextWindow: config.modelContextWindow,
        maxInputTokens: config.modelMaxInputTokens,
        maxOutputTokens: config.modelMaxOutputTokens,
      },
    ],
  }));
}
