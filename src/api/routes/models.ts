import type { FastifyInstance } from 'fastify';

export function registerModelsRoute(app: FastifyInstance): void {
  app.get('/v1/models', async () => ({
    object: 'list',
    data: [
      {
        id: 'chatgpt-web',
        object: 'model',
        created: 0,
        owned_by: 'chatgpt-web-gateway',
      },
    ],
  }));
}
