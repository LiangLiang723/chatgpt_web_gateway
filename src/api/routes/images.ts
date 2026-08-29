import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/index.js';
import type { ImageGenerationServiceLike } from '../../images/service.js';
import { normalizeImageGenerationRequest } from '../../images/types.js';

interface ImagePathParams {
  id: string;
}

function contentUrl(config: AppConfig, request: FastifyRequest, id: string): string {
  const path = `/v1/images/${id}/content`;
  if (config.publicBaseUrl) return `${config.publicBaseUrl}${path}`;
  const host = request.headers.host ?? request.hostname;
  return `${request.protocol}://${host}${path}`;
}

export function registerImagesRoute(
  app: FastifyInstance,
  config: AppConfig,
  imageService: ImageGenerationServiceLike,
): void {
  app.post('/v1/images/generations', async (request, reply) => {
    const normalized = normalizeImageGenerationRequest(request.body);
    const image = await imageService.generate(normalized);
    const created = Math.floor(image.createdAt / 1000);

    if (normalized.responseFormat === 'b64_json') {
      return reply.send({
        created,
        data: [{ b64_json: image.bytes.toString('base64') }],
      });
    }

    return reply.send({
      created,
      data: [{ url: contentUrl(config, request, image.id) }],
    });
  });

  app.get<{ Params: ImagePathParams }>('/v1/images/:id/content', async (request, reply) => {
    const content = await imageService.read(request.params.id);
    reply.header('content-type', content.record.mimeType ?? 'application/octet-stream');
    reply.header('content-length', String(content.bytes.byteLength));
    reply.header('content-disposition', `inline; filename="${content.record.id}"`);
    return reply.send(content.bytes);
  });
}
